import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { isPlainObject, type ExecutionEngineOptions, type Workflow } from '@draflow/core';
import { MemoryRuntime, type TriggerEvent } from '@draflow/runtime';
import type { ExecutionSummary } from '@draflow/storage';
import { serverHttp, type HttpAuth } from './http-auth.js';
import { latestDue, nextTime, scheduleFor } from './schedule.js';
import { QueueFull, SqliteLedger } from './sqlite.js';

interface HostOptions extends Omit<ExecutionEngineOptions, 'credentialFetch'> {
  scheduleClock?: {
    now(): number;
    arm(callback: () => void, delayMs: number): () => void;
  };
  httpAuth?: HttpAuth;
  maxHttpResponseBytes?: number;
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
    for (const n of [this.#capacity, this.#ttl, budget]) {
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
    this.#ledger = new SqliteLedger(path, budget);
    try {
      this.#ledger.recover();
      for (const row of this.#ledger.requiredPublications()) {
        new MemoryRuntime(this.#engine).restore(
          this.#ledger.publication(String(row.workflowId), Number(row.revision)),
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
  byEvent(id: string, trigger: string, key: string) {
    return this.#ledger.byEvent(id, trigger, key);
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

  activate(id: string, revision: number) {
    this.#ready();
    const publication = this.#ledger.publication(id, revision);
    new MemoryRuntime(this.#engine).restore(publication);
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
    this.#ledger.activate(id, revision, routes, schedules);
    this.#armSchedules();
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
    this.#ledger.deactivate(id);
    this.#armSchedules();
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
        node.disabled ||
        this.options.registry.require(node.type, node.typeVersion).meta.category !== 'trigger'
      ) {
        throw new Error(`Unknown active trigger: ${trigger}`);
      }
    });
    this.#wake();
    return runId;
  }

  #armSchedules(minDelay = 0) {
    this.#cancelSchedule?.();
    this.#cancelSchedule = undefined;
    const next = this.#ledger.nextScheduleTime();
    if (next === undefined) return;
    // Recheck long waits periodically in case the wall clock moves.
    const delay = Math.max(minDelay, Math.min(60_000, next - this.#scheduleClock.now()));
    this.#cancelSchedule = this.#scheduleClock.arm(() => this.#tickSchedules(), delay);
  }

  #tickSchedules() {
    if (this.#stopping || this.#fault) return;
    try {
      const now = this.#scheduleClock.now();
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
      await yieldToHost();
      if (this.#stopping || this.#fault) return;
      const job = this.#ledger.claim();
      if (!job) {
        this.#worker = undefined;
        return;
      }
      const { receipt: r, items } = job;
      const publication = this.#ledger.publication(r.workflowId, r.revision);
      // Run the accepted revision even after a replacement or deactivation.
      const runtime = new MemoryRuntime(this.#engine);
      runtime.restore(publication);
      await runtime.activate(r.workflowId, r.revision);
      const { result } = await runtime.fire(r.workflowId, r.triggerNodeId, {
        items,
        runId: r.runId,
        mode: r.mode,
        ...(r.eventKey !== null && { key: r.eventKey }),
      });
      const tasks = Object.values(result.runData)
        .flat()
        .sort((a, b) => a.executionIndex - b.executionIndex)
        .map((task) => ({ nodeId: task.nodeId, runIndex: task.runIndex, reused: false, task }));
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
