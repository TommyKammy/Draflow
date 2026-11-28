import type { BusinessDelivery } from './business.js';
import type { Identity } from './operator-store.js';
import { type SharedOptions, OwnershipLost } from './postgres.js';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { isPlainObject, type ExecutionEngineOptions, type JsonObject, type Workflow } from '@draflow/core';
import { MemoryRuntime, type PublishedWorkflow, type TriggerEvent } from '@draflow/runtime';
import type { ExecutionSummary } from '@draflow/storage';
import {
  ReadDeferred,
  ReadThrottled,
  sharedRateLimit,
  serverHttp,
  type RateGate,
  type HttpAuth,
} from './http-auth.js';
import { compensationSpec } from './compensation.js';
import { pageConfig, readPage, retryTime } from './pages.js';
import { latestDue, nextTime, scheduleFor } from './schedule.js';
import {
  executionTasks,
  QueueFull,
  ExecutionLedger,
  type DeliverySource,
  type Reconciliation,
} from './sqlite.js';

interface HostOptions extends Omit<ExecutionEngineOptions, 'credentialFetch'> {
  scheduleClock?: {
    now(): number;
    arm(callback: () => void, delayMs: number): () => void;
  };
  shared?: SharedOptions;
  organization?: string;
  businessOnly?: boolean;
  prepareBusiness?: (
    organization: string,
    event: string,
    rule: string,
    run: string,
    project: string,
    revision: number,
  ) => Promise<{ status: 'prepared' | 'skipped' | 'denied' }>;
  executeBusiness?: (organization: string, event: string, rule: string, run: string, project: string,
    revision: number, probe: boolean, canStart: () => boolean) =>
      Promise<{status: 'applied'|'prepared'|'skipped'|'denied'|'conflict'|'review'|'canceled'}>;
  httpAuth?: HttpAuth;
  maxHttpResponseBytes?: number;
  maxCallDepth?: number;
  capacity?: number;
  maxParallelBatches?: number;
  dedupMs?: number;
  maxDetailBytes?: number;
  onWorkerError?: (error: unknown) => void;
}

export class WebhookGone extends Error {}

export class NodeHost {
  readonly #ledger: ExecutionLedger;
  readonly #engine: ExecutionEngineOptions;
  #operatorEffects: { commit: (() => void)[]; rollback: (() => void)[] } | undefined;
  readonly #capacity: number;
  readonly #ttl: number;
  readonly #scheduleClock: NonNullable<HostOptions['scheduleClock']>;
  #cancelSchedule: (() => void) | undefined;
  #stopping = false;
  #closed = false;
  readonly #active = new Map<string, AbortController>();
  readonly #parallel = new Set<Promise<void>>();
  readonly #parallelLimit: number;
  #latestCooldown = 0;
  #poll?: ReturnType<typeof setInterval>;
  #worker: Promise<void> | undefined;
  #fault: Error | undefined;

  constructor(
    path: string,
    private readonly options: HostOptions,
  ) {
    this.#scheduleClock = options.scheduleClock ?? {
      now: () => this.#ledger?.shared?.now() ?? Date.now(),
      arm(callback, delay) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    };
    this.#parallelLimit = options.maxParallelBatches ?? 4;
    if (!Number.isSafeInteger(this.#parallelLimit) || this.#parallelLimit < 1 || this.#parallelLimit > 32)
      throw new RangeError('Invalid host batch concurrency');
    this.#capacity = options.capacity ?? 100;
    this.#ttl = options.dedupMs ?? 86_400_000;
    const budget = options.maxDetailBytes ?? 4 * 1024 * 1024;
    for (const n of [this.#capacity, this.#ttl, budget, options.maxCallDepth ?? 8]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Invalid host limit');
    }
    if (options.organization && options.shared && options.organization !== options.shared.organization)
      throw Error('Ledger organization mismatch');
    const organization = options.shared?.organization ?? options.organization;
    if (options.businessOnly && (!organization || !options.prepareBusiness))
      throw Error('A business worker requires an organization and preparation callback');
    if (organization && options.httpAuth && options.httpAuth.organization !== organization)
      throw Error('HTTP credentials belong to a different organization');
    const fetchFn = options.fetch ?? fetch;
    const transport: typeof fetchFn = (url, init) => {
      if (this.#ledger.shared) {
        this.#ledger.shared.checkDispatch();
        const token = this.#ledger.shared.lease.getStore();
        if (token && this.#ledger.canceled(token.id)) throw Error('Run canceled');
      }
      return fetchFn(url, init);
    };
    this.#engine = {
      ...options,
      fetch: transport,
      credentialFetch: serverHttp(
        transport,
        options.maxHttpResponseBytes ?? 1024 * 1024,
        organization && options.httpAuth
          ? {
              get grants() {
                return options.httpAuth!.grants;
              },
              currentVersion: (id) => {
                const access = this.#ledger.operators.credentialAccess(id);
                if (access?.enabled === 0) return null;
                if (access?.version != null && !this.credentialVersions(id).includes(String(access.version)))
                  return null;
                return access?.version == null ? undefined : String(access.version);
              },
              resolve: (id, version) => options.httpAuth!.resolve(id, version),
            }
          : options.httpAuth,
        () =>
          this.options.shared || this.#latestCooldown > this.#scheduleClock.now()
            ? this.#rateGate()
            : undefined,
      ),
    };
    this.#ledger = new ExecutionLedger(
      path,
      budget,
      options.maxCallDepth ?? 8,
      options.shared,
      options.organization,
    );
    if (this.#ledger.shared)
      this.#ledger.shared.onDisconnect = () =>
        this.#workerFailed(new Error('PostgreSQL session disconnected'));
    try {
      this.#latestCooldown = this.#ledger.latestCooldown();
      if (this.#executes()) this.#ledger.recover();
      const checked = new Set<string>();
      for (const row of this.#ledger.requiredPublications(this.#executionLane(), !!options.executeBusiness)) {
        this.#checkPublication(
          this.#ledger.publication(String(row.workflowId), Number(row.revision)),
          checked,
        );
      }
      if (options.shared && options.shared.role !== 'intake') {
        const shared = this.#ledger.shared!;
        const every = Math.min(options.shared.pollMs ?? 250, Math.floor(shared.leaseMs / 3));
        this.#poll = setInterval(() => {
          if (this.#fault || (this.#stopping && !this.#active.size)) return;
          try {
            if (this.#executes()) {
              shared.heartbeat();
              if (!this.#stopping) this.#ledger.recover();
              for (const [id, controller] of this.#active) {
                if (this.#ledger.canceled(id) || !shared.ownsLiveRun(id)) controller.abort();
              }
              if (!this.#stopping) this.#wake();
            }
            if (!this.#stopping && this.#schedules()) this.#tickSchedules();
          } catch (error) {
            this.#workerFailed(error);
          }
        }, every);
      }
      if (organization && !options.shared) {
        const beat = () => this.#ledger.operators.heartbeat('sqlite');
        beat();
        this.#poll = setInterval(beat, 1000);
        this.#poll.unref();
      }
      this.#armSchedules();
      this.#wake();
    } catch (error) {
      this.#ledger.close();
      throw error;
    }
  }

  acceptBusiness(delivery: BusinessDelivery) {
    this.#ready();
    if (!this.organization || delivery.organization !== this.organization)
      throw Error('Business organization mismatch');
    const run = this.#ledger.acceptBusiness(delivery, this.#capacity, (workflow) => this.publish(workflow));
    this.#wake();
    return run;
  }
  get organization() {
    return this.options.shared?.organization ?? this.options.organization;
  }
  recordOperatorAlerts(
    evaluate: (metrics: ReturnType<NodeHost['operatorMetrics']>) => { kind: string; run: string | null }[],
  ) {
    if (!this.organization) throw Error('Organization required');
    return this.#ledger.operators.recordAlerts(this.organization, evaluate);
  }
  operatorMetrics() {
    return this.#ledger.operators.metrics();
  }
  credentialVersions(id: string) {
    const profiles = this.options.httpAuth?.versions;
    return profiles && Object.hasOwn(profiles, id) ? (profiles[id] ?? []) : [];
  }
  get credentialIds() {
    return (this.options.httpAuth?.grants ?? []).map((g) => g.id);
  }
  operate(identity: Identity, command: Record<string, unknown>) {
    this.#ready();
    const effects: { commit: (() => void)[]; rollback: (() => void)[] } = { commit: [], rollback: [] };
    this.#operatorEffects = effects;
    let result: unknown;
    try {
      result = this.#ledger.operators.execute(this, identity, command);
    } catch (error) {
      for (const undo of effects.rollback) undo();
      throw error;
    } finally {
      this.#operatorEffects = undefined;
    }
    for (const apply of effects.commit) apply();
    return result;
  }
  get history() {
    return this.#ledger.history;
  }
  receipt(runId: string) {
    return this.#ledger.get(runId);
  }
  cancel(runId: string) {
    this.#ready();
    const ids = this.#ledger.cancelTree(runId);
    const abort = () => {
      for (const id of ids) this.#active.get(id)?.abort();
    };
    if (this.#operatorEffects) this.#operatorEffects.commit.push(abort);
    else abort();
    if (ids.length) this.#wake();
    return ids.length > 0;
  }
  inspect(runId: string) {
    return this.#ledger.inspect(runId);
  }
  progress(runId: string) {
    return this.#ledger.progress(runId);
  }
  relations(runId: string) {
    return this.#ledger.relations(runId);
  }
  effects(runId: string) {
    return this.#ledger.effects(runId);
  }
  redrive(runId: string, failureId: string) {
    this.#ready();
    const point = this.#ledger.recoveryInfo(runId).find((p) => p.failure === failureId);
    if (point?.attempt) return String(point.attempt);
    const receipt = this.#ledger.get(runId);
    if (point?.retained && receipt)
      this.#checkPublication(this.#ledger.publication(receipt.workflowId, receipt.revision));
    const attempt = this.#ledger.redrive(runId, failureId, this.#scheduleClock.now());
    this.#wake();
    return attempt;
  }

  compensate(runId: string) {
    this.#ready();
    const receipt = this.#ledger.get(runId);
    if (receipt) this.#checkPublication(this.#ledger.publication(receipt.workflowId, receipt.revision));
    const id = this.#ledger.compensate(runId);
    this.#wake();
    return id;
  }

  compensationInfo(runId: string) {
    return this.#ledger.compensationInfo(runId);
  }

  retryCompensation(runId: string, failureId: string) {
    this.#ready();
    const id = this.#ledger.retryCompensation(runId, failureId);
    this.#wake();
    return id;
  }

  recoveryInfo(runId: string) {
    return this.#ledger.recoveryInfo(runId);
  }

  resetSync(workflowId: string, nodeId: string, scope: string) {
    this.#ready();
    const reset = this.#ledger.resetSync(workflowId, nodeId, scope);
    this.#wake();
    return reset;
  }

  reconcile(runId: string, key: string, decision: Reconciliation, result: JsonObject = {}) {
    this.#ready();
    if (!isPlainObject(result)) throw new Error('Expected a JSON object');
    const changed = this.#ledger.reconcile(runId, key, decision, result);
    if (changed) this.#wake();
    return changed;
  }
  waitInfo(runId: string) {
    return this.#ledger.waitInfo(runId);
  }
  transitions(runId: string) {
    return this.#ledger.transitions(runId);
  }
  resolveWait(runId: string, token: string, reason: 'event' | 'canceled', data: JsonObject = {}) {
    this.#ready();
    if (!['event', 'canceled'].includes(reason) || !isPlainObject(data))
      throw new Error('Invalid wait response');
    const accepted = this.#ledger.resolveWait(runId, token, reason, data, this.#scheduleClock.now());
    // Consuming a wait can only remove a deadline. The existing timer may wake
    // early, but cannot miss an earlier deadline or invalidate a committed reply.
    this.#wake();
    return accepted;
  }
  byEvent(id: string, trigger: string, key: string, source?: DeliverySource) {
    return this.#ledger.byEvent(id, trigger, key, source);
  }
  stats() {
    return this.#ledger.stats();
  }

  #ready() {
    if (this.#fault) throw this.#fault;
    if (this.#stopping) throw new Error('Host stopping');
  }

  publish(workflow: Workflow): number {
    this.#ready();
    const runtime = new MemoryRuntime(this.#engine);
    runtime.saveDraft(workflow);
    return this.#ledger.publish(runtime.publish(workflow.id).workflow);
  }

  #checkPublication(publication: PublishedWorkflow, checked = new Set<string>()) {
    const key = JSON.stringify([publication.workflow.id, publication.revision]);
    if (checked.has(key)) return;
    new MemoryRuntime(this.#engine).restore(publication);
    checked.add(key);
    for (const node of publication.workflow.nodes) {
      const undo = !node.disabled && compensationSpec(node);
      if (undo) this.#checkPublication(this.#ledger.publication(undo.workflowId, undo.revision), checked);
      if (node.disabled || (node.type !== 'draflow.call' && node.type !== 'draflow.pages')) continue;
      const { workflowId, revision } = node.parameters;
      this.#checkPublication(this.#ledger.publication(String(workflowId), Number(revision)), checked);
    }
  }

  activate(id: string, revision: number) {
    this.#ready();
    const publication = this.#ledger.publication(id, revision);
    this.#checkPublication(publication);
    const routes = publication.workflow.nodes
      .filter((n) => !n.disabled && n.type === 'draflow.webhook')
      .map((node) => {
        const path = node.parameters.path;
        if (typeof path !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(path))
          throw new Error('Invalid Webhook path');
        return { path: '/webhook/' + path, triggerNodeId: node.id };
      });
    const now = this.#scheduleClock.now();
    const schedules = publication.workflow.nodes
      .filter((n) => !n.disabled && n.type === 'draflow.schedule')
      .map((node) => {
        const spec = scheduleFor(node);
        return { triggerNodeId: node.id, spec, nextAt: nextTime(spec, now) };
      });
    this.#updateRegistration((prepare) => this.#ledger.activate(id, revision, routes, schedules, prepare));
  }

  listenTest(workflow: Workflow, triggerNodeId: string, ttlMs = 60_000) {
    this.#ready();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 86_400_000)
      throw new Error('Invalid test URL lifetime');
    const token = randomUUID();
    const path = '/webhook-test/' + token;
    const workflowId = 'webhook-test-' + token;
    const runtime = new MemoryRuntime(this.#engine);
    runtime.saveDraft({ ...workflow, id: workflowId });
    const snapshot = runtime.publish(workflowId).workflow;
    if (!snapshot.nodes.some((n) => n.id === triggerNodeId && n.type === 'draflow.webhook' && !n.disabled)) {
      throw new Error('Expected an enabled Webhook node');
    }
    const expiresAt = (this.#ledger.shared?.now() ?? Date.now()) + ttlMs;
    this.#ledger.registerTestWebhook(path, snapshot, triggerNodeId, expiresAt);
    return { path, workflowId, expiresAt };
  }

  webhook(path: string) {
    this.#ready();
    return this.#ledger.webhook(path);
  }

  acceptWebhook(path: string, target: NonNullable<ReturnType<NodeHost['webhook']>>, event: TriggerEvent) {
    this.#ready();
    const runId = this.#ledger.accept(
      target.workflowId,
      target.triggerNodeId,
      { ...event, mode: 'webhook' },
      this.#capacity,
      this.#ttl,
      () => {
        const current = this.webhook(path);
        if (
          !current ||
          current.registration !== target.registration ||
          current.workflowId !== target.workflowId ||
          current.revision !== target.revision ||
          current.triggerNodeId !== target.triggerNodeId
        )
          throw new WebhookGone();
        if (path.startsWith('/webhook-test/')) this.#ledger.retainTestSnapshot(path, target.workflowId);
      },
      target.revision,
    );
    this.#wake();
    return runId;
  }

  deactivate(id: string) {
    this.#ready();
    this.#updateRegistration((prepare) => this.#ledger.deactivate(id, prepare));
  }

  accept(id: string, trigger: string, event: Omit<TriggerEvent, 'runId'>): string {
    this.#ready();
    if (event.key !== undefined && typeof event.key !== 'string')
      throw new Error('Expected a string event key');
    if (event.mode !== undefined && event.mode !== 'trigger' && event.mode !== 'webhook') {
      throw new Error('Expected trigger or webhook mode');
    }
    if (!Array.isArray(event.items)) throw new Error('Expected event items');
    for (const item of event.items) {
      if (!isPlainObject(item) || !isPlainObject(item.json))
        throw new Error('Expected an item with a JSON object');
    }
    const runId = this.#ledger.accept(id, trigger, event, this.#capacity, this.#ttl, (revision) => {
      const { workflow } = this.#ledger.publication(id, revision);
      const node = workflow.nodes.find((node) => node.id === trigger);
      if (
        !node ||
        node.type === 'draflow.childInput' ||
        node.disabled ||
        this.options.registry.require(node.type, node.typeVersion).meta.category !== 'trigger'
      ) {
        throw new Error(`Unknown active trigger: ${trigger}`);
      }
    });
    this.#wake();
    return runId;
  }

  #updateRegistration(change: (prepare: () => void) => boolean) {
    let cancelPrepared: (() => void) | undefined;
    try {
      // Read the transaction's schedule and keep the current timer live until COMMIT.
      if (
        !change(() => {
          cancelPrepared = this.#prepareScheduleTimer();
        })
      )
        return;
    } catch (error) {
      cancelPrepared?.();
      throw error;
    }
    const install = () => {
      this.#cancelSchedule?.();
      this.#cancelSchedule = cancelPrepared;
    };
    if (this.#operatorEffects) {
      this.#operatorEffects.commit.push(install);
      if (cancelPrepared) this.#operatorEffects.rollback.push(cancelPrepared);
    } else install();
  }

  #prepareScheduleTimer(minDelay = 0) {
    if (this.options.shared || this.options.businessOnly) return;
    const next = this.#ledger.nextScheduleTime();
    if (next === undefined) return;
    // Recheck long waits periodically in case the wall clock moves.
    const delay = Math.max(minDelay, Math.min(60_000, next - this.#scheduleClock.now()));
    return this.#scheduleClock.arm(() => this.#tickSchedules(), delay);
  }

  #executionLane() {
    return this.options.businessOnly ? 'business' : this.options.prepareBusiness ? 'all' : 'ordinary';
  }
  #executes() {
    return !['intake', 'scheduler'].includes(this.options.shared?.role ?? 'all');
  }
  #schedules() {
    return !this.options.businessOnly && !['intake', 'worker'].includes(this.options.shared?.role ?? 'all');
  }
  #armSchedules(minDelay = 0) {
    if (this.options.shared || this.options.businessOnly) return; // Every scheduler polls the durable due times.
    const cancel = this.#prepareScheduleTimer(minDelay);
    this.#cancelSchedule?.();
    this.#cancelSchedule = cancel;
  }

  #tickSchedules() {
    if (this.#stopping || this.#fault) return;
    try {
      const now = this.#ledger.shared?.now() ?? this.#scheduleClock.now();
      if (this.#ledger.wakeRetries(now)) this.#wake();
      for (const row of this.#ledger.dueWaits(now)) {
        this.#ledger.resolveWait(String(row.runId), String(row.token), 'timer', {}, now);
        this.#wake();
      }
      for (const row of this.#ledger.dueSchedules(now)) {
        const due = latestDue(row.spec, row.nextAt, now);
        this.#ledger.acceptSchedule(
          row.workflowId,
          row.triggerNodeId,
          due,
          nextTime(row.spec, due),
          this.#capacity,
          row,
        );
        this.#wake();
      }
      this.#armSchedules();
    } catch (error) {
      if (error instanceof QueueFull) this.#armSchedules(1000);
      else this.#workerFailed(error);
    }
  }

  #workerFailed(error: unknown) {
    if (this.#fault) return;
    this.#cancelSchedule?.();
    this.#fault = new Error('Worker stopped', { cause: error });
    this.options.onWorkerError?.(this.#fault);
  }

  #wake() {
    if (this.#worker || !this.#executes()) return;
    this.#worker = this.#drain().catch((error) => {
      // A failed completion commit leaves the durable claim intact for recovery.
      this.#workerFailed(error);
    });
  }

  #rateGate(): RateGate {
    const clock = this.#scheduleClock;
    const shared = this.#ledger.shared;
    return {
      ...(shared && {
        reserve: (target: string) => {
          const localHold =
            this.#latestCooldown > clock.now() ? this.#ledger.rateLimit(target) - clock.now() : 0;
          return localHold > 0 ? { delay: localHold } : shared.reserveTarget(target);
        },
      }),
      remaining: (target) => this.#ledger.rateLimit(target) - clock.now(),
      hold: (target, header) => {
        const until = Math.min(Number.MAX_SAFE_INTEGER, retryTime(header, shared?.now() ?? clock.now(), 1));
        if (shared) {
          shared.holdTarget(target, until);
          return;
        }
        this.#ledger.holdRate(target, until);
        this.#latestCooldown = Math.max(this.#latestCooldown, until);
      },
      wait: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          signal?.throwIfAborted();
          const cancel = clock.arm(
            () => {
              signal?.removeEventListener('abort', abort);
              resolve();
            },
            Math.min(ms, 60000),
          );
          const abort = () => {
            cancel();
            reject(signal?.reason);
          };
          signal?.addEventListener('abort', abort, { once: true });
        }),
    };
  }

  #withRateLimit<T>(action: () => T) {
    return sharedRateLimit.run(this.#rateGate(), action);
  }

  async #drain() {
    while (true) {
      await yieldToHost();
      if (this.#stopping || this.#fault) return;
      const job = this.#ledger.claim(
        this.#parallel.size < this.#parallelLimit,
        this.#parallelLimit,
        this.#executionLane(), !!this.options.executeBusiness,
      );
      if (!job) {
        this.#worker = undefined;
        return;
      }
      const id = job.receipt.runId;
      const controller = new AbortController();
      this.#active.set(id, controller);
      const parallel = this.#ledger.parallelChild(id);
      const run = () => this.#runJob(job, controller);
      const invoke = () => (parallel ? this.#withRateLimit(run) : run());
      const shared = this.#ledger.shared;
      const executing = shared ? shared.lease.run({ id, generation: job.generation! }, invoke) : invoke();
      const task = executing
        .catch((error) => {
          if (!(error instanceof OwnershipLost)) throw error;
        })
        .finally(() => {
          if (this.#active.get(id) === controller) this.#active.delete(id);
        });
      if (parallel) {
        const pending = task
          .catch((error) => this.#workerFailed(error))
          .finally(() => {
            this.#parallel.delete(pending);
            if (!this.#stopping && !this.#fault) this.#wake();
          });
        this.#parallel.add(pending);
      } else await task;
    }
  }

  async #runJob(job: NonNullable<ReturnType<ExecutionLedger['claim']>>, controller: AbortController) {
    const { receipt: r } = job;
    let items = job.items;
    let effectConfirmed = false;
    if (this.#ledger.canceled(r.runId) && !this.#ledger.businessStarted(r.runId)) {
      this.#ledger.finishCanceled(r);
      return;
    }
    const publication = this.#ledger.publication(r.workflowId, r.revision);
    if (this.organization && r.workflowId.startsWith('business-') && this.#ledger.isBusinessRun(r.runId)) {
      const context = items[0]!.json;
      const args = [
        this.organization,
        String(context.event),
        String(context.rule),
        r.runId,
        String(context.project),
        Number(context.revision),
      ] as const;
      let decision;
      if (this.organization === context.organization && context.apply === true) {
        const canStart = () => {
          this.#ledger.shared?.checkDispatch();
          return !controller.signal.aborted && !this.#ledger.canceled(r.runId);
        };
        while (canStart()) {
          const attempt = this.#ledger.nextBusinessAttempt(r.runId);
          const probe = attempt > 3;
          try {
            decision = await this.options.executeBusiness?.(...args, probe, canStart);
            break;
          } catch (error) {
            if (error instanceof OwnershipLost) throw error;
            if (probe) {
              decision = { status: 'review' };
              break;
            }
            await new Promise((done) => setTimeout(done, 50 * attempt));
          }
        }
        if (this.#ledger.canceled(r.runId) && !decision) {
          try {
            decision = await this.options.executeBusiness?.(...args, true, canStart);
          } catch (error) {
            if (error instanceof OwnershipLost) throw error;
            decision = { status: 'review' };
          }
        }
        if (decision?.status === 'canceled') {
          this.#ledger.finishCanceled(r);
          return;
        }
        if (decision?.status === 'review') {
          this.#ledger.pauseBusiness(r.runId);
          return;
        }
      } else if (this.organization === context.organization) {
        decision = await this.options.prepareBusiness?.(...args);
      }
      if (
        !decision ||
        ![context.apply === true ? 'applied' : 'prepared', 'skipped'].includes(decision.status)
      ) {
        this.#ledger.finish(
          r,
          {
            id: r.runId,
            workflowId: r.workflowId,
            workflowName: publication.workflow.name,
            mode: r.mode,
            startNodeId: r.triggerNodeId,
            status: 'error',
            startedAt: r.startedAt!,
            stoppedAt: this.#scheduleClock.now(),
            executed: 0,
            reused: 0,
          },
          {
            workflow: publication.workflow,
            tasks: [],
            error:
              decision?.status === 'conflict'
                ? {
                    name: 'BusinessConflict',
                    message: 'Business operation does not match the receiver receipt',
                  }
                : { name: 'BusinessAuthorization', message: 'Business action unavailable' },
          },
        );
        return;
      }
      effectConfirmed = context.apply === true;
      items = [{ json: { businessStatus: decision.status } }];
    }
    const operation = this.#ledger.pendingMode(r.runId);
    if (operation === 'pages') {
      const entry = this.#ledger.continuation(r.runId)!.checkpoint.stack[0]!;
      const node = publication.workflow.nodes.find((n) => n.id === entry.nodeId)!;
      const state = this.#ledger.pageState(r.runId, node.id, entry.runIndex);
      const now = this.#scheduleClock.now();
      if (now >= Number(state.created) + pageConfig(node).deadlineMs) {
        this.#ledger.pageFailure(r.runId, node.id, entry.runIndex, 'Page sync deadline exceeded');
        return;
      }
      if (state.rows === null) {
        let page;
        try {
          if (Number(state.pages) >= pageConfig(node).maxPages) throw new Error('Page count limit exceeded');
          const read = () =>
            readPage(
              this.#engine.credentialFetch!,
              r.workflowId,
              node,
              state.cursor as string | null,
              AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(
                  Math.min(30000, Number(state.created) + pageConfig(node).deadlineMs - now),
                ),
              ]),
              node.parameters.syncScope
                ? (this.#ledger.syncScope(r.runId)?.token as string | null)
                : undefined,
            );
          page = await (pageConfig(node).concurrency > 1 ? this.#withRateLimit(read) : read());
          if (controller.signal.aborted) {
            this.#ledger.finishCanceled(r);
            return;
          }
        } catch (err) {
          if (controller.signal.aborted) {
            this.#ledger.finishCanceled(r);
            return;
          }
          if (err instanceof ReadDeferred) {
            const deadline = Number(state.created) + pageConfig(node).deadlineMs;
            const due = Math.min(deadline, this.#scheduleClock.now() + err.delayMs);
            this.#ledger.waitForPage(r.runId, node.id, entry.runIndex, Number(state.attempts), due);
            this.#armSchedules();
            return;
          }
          if (err instanceof ReadThrottled) {
            this.#ledger.throttle(
              r.runId,
              node,
              entry.runIndex,
              err.status,
              err.retryAfter,
              this.#scheduleClock.now(),
            );
            this.#armSchedules();
            return;
          }
          this.#ledger.pageFailure(
            r.runId,
            node.id,
            entry.runIndex,
            err instanceof Error ? err.message : 'Page read failed',
          );
          return;
        }
        this.#ledger.savePage(r, node, entry.runIndex, page);
      }
      if (this.#ledger.pendingMode(r.runId) === 'pages') this.#ledger.batch(r, node, entry.runIndex);
      return;
    }
    if (operation === 'child') {
      const entry = this.#ledger.continuation(r.runId)!.checkpoint.stack[0]!;
      this.#ledger.dispatchChild(r, publication.workflow.nodes.find((n) => n.id === entry.nodeId)!);
      return;
    }
    // Run the accepted revision even after a replacement or deactivation.
    const runtime = new MemoryRuntime({
      ...this.#engine,
      persistence: {
        ...this.#ledger.continuation(r.runId),
        beginJournal: (state, mode) =>
          this.#ledger.beginJournal(
            state,
            mode,
            compensationSpec(publication.workflow.nodes.find((n) => n.id === state.stack[0]!.nodeId)!),
          ),
        leaveCheckpoint: () => this.#ledger.leaveCheckpoint(r.runId),
        endJournal: () => this.#ledger.endJournal(r.runId),
        suspend: (state, request) => this.#ledger.suspend(state, request, this.#scheduleClock.now()),
      },
    });
    runtime.restore(publication);
    await runtime.activate(r.workflowId, r.revision);
    const { result } = await runtime.fire(
      r.workflowId,
      r.triggerNodeId,
      {
        items,
        runId: r.runId,
        mode: r.mode,
        ...(r.eventKey !== null && { key: r.eventKey }),
      },
      // This generated trigger only records the receiver outcome. A late cancel cannot undo it.
      effectConfirmed ? undefined : controller.signal,
    );
    if (result.status === 'waiting') {
      this.#armSchedules();
      return;
    }
    const tasks = executionTasks(result.runData);
    const summary: ExecutionSummary = {
      id: result.id,
      workflowId: r.workflowId,
      workflowName: publication.workflow.name,
      mode: r.mode,
      startNodeId: r.triggerNodeId,
      status: result.status,
      startedAt: result.startedAt,
      stoppedAt: result.stoppedAt,
      executed: tasks.length,
      reused: 0,
    };
    this.#ledger.finish(r, summary, {
      workflow: publication.workflow,
      tasks,
      ...(result.error && { error: result.error }),
    });
  }

  /** On timeout retain ownership until the process exits or close is called again. */
  async close(deadlineMs = 5000) {
    if (this.#closed) return;
    this.#stopping = true;
    this.#cancelSchedule?.();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([this.#worker, ...this.#parallel]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Worker shutdown deadline exceeded')), deadlineMs);
        }),
      ]);
      clearInterval(this.#poll);
      if (!this.#closed) this.#ledger.close();
      this.#closed = true;
    } finally {
      clearTimeout(timer);
    }
  }
}
