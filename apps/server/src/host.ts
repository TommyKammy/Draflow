import { setImmediate as yieldToHost } from 'node:timers/promises';
import { isPlainObject, type ExecutionEngineOptions, type Workflow } from '@draflow/core';
import { MemoryRuntime, type TriggerEvent } from '@draflow/runtime';
import type { ExecutionSummary } from '@draflow/storage';
import { SqliteLedger } from './sqlite.js';

interface HostOptions extends ExecutionEngineOptions {
  capacity?: number;
  dedupMs?: number;
  maxDetailBytes?: number;
  onWorkerError?: (error: unknown) => void;
}

export class NodeHost {
  readonly #ledger: SqliteLedger;
  readonly #capacity: number;
  readonly #ttl: number;
  #stopping = false;
  #closed = false;
  #worker: Promise<void> | undefined;
  #fault: Error | undefined;

  constructor(
    path: string,
    private readonly options: HostOptions,
  ) {
    this.#capacity = options.capacity ?? 100;
    this.#ttl = options.dedupMs ?? 86_400_000;
    const budget = options.maxDetailBytes ?? 4 * 1024 * 1024;
    for (const n of [this.#capacity, this.#ttl, budget]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Invalid host limit');
    }
    this.#ledger = new SqliteLedger(path, budget);
    try {
      this.#ledger.recover();
      for (const row of this.#ledger.requiredPublications()) {
        new MemoryRuntime(options).restore(
          this.#ledger.publication(String(row.workflowId), Number(row.revision)),
        );
      }
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
    const runtime = new MemoryRuntime(this.options);
    runtime.saveDraft(workflow);
    return this.#ledger.publish(runtime.publish(workflow.id).workflow);
  }

  activate(id: string, revision: number) {
    this.#ready();
    new MemoryRuntime(this.options).restore(this.#ledger.publication(id, revision));
    this.#ledger.activate(id, revision);
  }

  deactivate(id: string) {
    this.#ready();
    this.#ledger.deactivate(id);
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

  #wake() {
    if (this.#worker) return;
    this.#worker = this.#drain().catch((error) => {
      // A failed completion commit leaves the durable claim intact for recovery.
      this.#fault = new Error('Worker stopped', { cause: error });
      this.options.onWorkerError?.(this.#fault);
    });
  }

  async #drain() {
    while (true) {
      await yieldToHost();
      if (this.#stopping) return;
      const job = this.#ledger.claim();
      if (!job) {
        this.#worker = undefined;
        return;
      }
      const { receipt: r, items } = job;
      const publication = this.#ledger.publication(r.workflowId, r.revision);
      // Run the accepted revision even after a replacement or deactivation.
      const runtime = new MemoryRuntime(this.options);
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
