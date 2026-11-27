import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { isPlainObject, type ExecutionEngineOptions, type JsonObject, type Workflow } from '@draflow/core';
import { MemoryRuntime, type PublishedWorkflow, type TriggerEvent } from '@draflow/runtime';
import type { ExecutionSummary } from '@draflow/storage';
import { ReadThrottled, serverHttp, type HttpAuth } from './http-auth.js';
import { pageConfig, readPage } from './pages.js';
import { latestDue, nextTime, scheduleFor } from './schedule.js';
import { executionTasks, QueueFull, SqliteLedger, type DeliverySource, type Reconciliation } from './sqlite.js';

interface HostOptions extends Omit<ExecutionEngineOptions, 'credentialFetch'> {
  scheduleClock?: {
    now(): number;
    arm(callback: () => void, delayMs: number): () => void;
  };
  httpAuth?: HttpAuth;
  maxHttpResponseBytes?: number;
  maxCallDepth?: number;
  capacity?: number;
  dedupMs?: number;
  maxDetailBytes?: number;
  onWorkerError?: (error: unknown) => void;
}

export class WebhookGone extends Error {}

export class NodeHost {
  readonly #ledger: SqliteLedger;
  readonly #engine: ExecutionEngineOptions;
  // Only in-flight uploads need to distinguish successive activations of the same revision.
  readonly #webhookActivations = new Map<string, { revision: number; token: symbol }>();
  readonly #capacity: number;
  readonly #ttl: number;
  readonly #scheduleClock: NonNullable<HostOptions['scheduleClock']>;
  #cancelSchedule: (() => void) | undefined;
  #stopping = false;
  #closed = false;
  #active: { id: string; controller: AbortController } | undefined;
  #worker: Promise<void> | undefined;
  #fault: Error | undefined;

  constructor(
    path: string,
    private readonly options: HostOptions,
  ) {
    this.#scheduleClock = options.scheduleClock ?? {
      now: Date.now,
      arm(callback, delay) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    };
    this.#capacity = options.capacity ?? 100;
    this.#ttl = options.dedupMs ?? 86_400_000;
    const budget = options.maxDetailBytes ?? 4 * 1024 * 1024;
    for (const n of [this.#capacity, this.#ttl, budget, options.maxCallDepth ?? 8]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Invalid host limit');
    }
    this.#engine = {
      ...options,
      credentialFetch: serverHttp(
        options.fetch ?? fetch,
        options.maxHttpResponseBytes ?? 1024 * 1024,
        options.httpAuth,
      ),
    };
    this.#ledger = new SqliteLedger(path, budget, options.maxCallDepth ?? 8);
    try {
      this.#ledger.recover();
      const checked = new Set<string>();
      for (const row of this.#ledger.requiredPublications()) {
        this.#checkPublication(
          this.#ledger.publication(String(row.workflowId), Number(row.revision)), checked,
        );
      }
      this.#armSchedules();
      this.#wake();
    } catch (error) {
      this.#ledger.close();
      throw error;
    }
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
    if (this.#active && ids.includes(this.#active.id)) this.#active.controller.abort();
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
    if (this.#webhookActivations.get(id)?.revision !== revision) this.#webhookActivations.delete(id);
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
    const expiresAt = Date.now() + ttlMs;
    this.#ledger.registerTestWebhook(path, snapshot, triggerNodeId, expiresAt);
    return { path, workflowId, expiresAt };
  }

  webhook(path: string) {
    this.#ready();
    const route = this.#ledger.webhook(path);
    if (!route) return undefined;
    // A test URL already has a unique, non-reusable session ID.
    if (path.startsWith('/webhook-test/')) return { ...route, registration: route.workflowId };
    let activation = this.#webhookActivations.get(route.workflowId);
    if (!activation) {
      activation = { revision: route.revision, token: Symbol() };
      this.#webhookActivations.set(route.workflowId, activation);
    }
    return { ...route, registration: activation.token };
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
    this.#webhookActivations.delete(id);
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
    this.#cancelSchedule?.();
    this.#cancelSchedule = cancelPrepared;
  }

  #prepareScheduleTimer(minDelay = 0) {
    const next = this.#ledger.nextScheduleTime();
    if (next === undefined) return;
    // Recheck long waits periodically in case the wall clock moves.
    const delay = Math.max(minDelay, Math.min(60_000, next - this.#scheduleClock.now()));
    return this.#scheduleClock.arm(() => this.#tickSchedules(), delay);
  }

  #armSchedules(minDelay = 0) {
    const cancel = this.#prepareScheduleTimer(minDelay);
    this.#cancelSchedule?.();
    this.#cancelSchedule = cancel;
  }

  #tickSchedules() {
    if (this.#stopping || this.#fault) return;
    try {
      const now = this.#scheduleClock.now();
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
    if (this.#worker) return;
    this.#worker = this.#drain().catch((error) => {
      // A failed completion commit leaves the durable claim intact for recovery.
      this.#workerFailed(error);
    });
  }

  async #drain() {
    while (true) {
      this.#active = undefined;
      await yieldToHost();
      if (this.#stopping || this.#fault) return;
      const job = this.#ledger.claim();
      if (!job) {
        this.#worker = undefined;
        return;
      }
      const { receipt: r, items } = job;
      if (this.#ledger.canceled(r.runId)) {
        this.#ledger.finishCanceled(r);
        continue;
      }
      const controller = new AbortController();
      this.#active = { id: r.runId, controller };
      const publication = this.#ledger.publication(r.workflowId, r.revision);
      const operation = this.#ledger.pendingMode(r.runId);
      if (operation === 'pages') {
        const entry = this.#ledger.continuation(r.runId)!.checkpoint.stack[0]!;
        const node = publication.workflow.nodes.find((n) => n.id === entry.nodeId)!;
        const state = this.#ledger.pageState(r.runId, node.id, entry.runIndex);
        const now = this.#scheduleClock.now();
        if (now >= Number(state.created) + pageConfig(node).deadlineMs) {
          this.#ledger.pageFailure(r.runId, node.id, entry.runIndex, 'Page sync deadline exceeded');
          continue;
        }
        if (state.rows === null) {
          let page;
          try {
            if (Number(state.pages) >= pageConfig(node).maxPages)
              throw new Error('Page count limit exceeded');
            page = await readPage(
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
            );
            if (controller.signal.aborted) {
              this.#ledger.finishCanceled(r);
              continue;
            }
          } catch (err) {
            if (controller.signal.aborted) {
              this.#ledger.finishCanceled(r);
              continue;
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
              continue;
            }
            this.#ledger.pageFailure(
              r.runId,
              node.id,
              entry.runIndex,
              err instanceof Error ? err.message : 'Page read failed',
            );
            continue;
          }
          this.#ledger.savePage(r, node, entry.runIndex, page);
        }
        if (this.#ledger.pendingMode(r.runId) === 'pages') this.#ledger.batch(r, node, entry.runIndex);
        continue;
      }
      if (operation === 'child') {
        const entry = this.#ledger.continuation(r.runId)!.checkpoint.stack[0]!;
        this.#ledger.dispatchChild(r, publication.workflow.nodes.find((n) => n.id === entry.nodeId)!);
        continue;
      }
      // Run the accepted revision even after a replacement or deactivation.
      const runtime = new MemoryRuntime({
        ...this.#engine,
        persistence: {
          ...this.#ledger.continuation(r.runId),
          beginJournal: (state, mode) => this.#ledger.beginJournal(state, mode),
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
        controller.signal,
      );
      if (result.status === 'waiting') {
        this.#armSchedules();
        continue;
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
  }

  /** On timeout retain ownership until the process exits or close is called again. */
  async close(deadlineMs = 5000) {
    if (this.#closed) return;
    this.#stopping = true;
    this.#cancelSchedule?.();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#worker,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Worker shutdown deadline exceeded')), deadlineMs);
        }),
      ]);
      if (!this.#closed) this.#ledger.close();
      this.#closed = true;
    } finally {
      clearTimeout(timer);
    }
  }
}
