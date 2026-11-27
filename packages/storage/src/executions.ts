import type { ExecutionMode, PortData, RunStatus, SerializedError, TaskData, Workflow } from '@draflow/core';

export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  mode: ExecutionMode;
  startNodeId?: string;
  destinationNodeId?: string;
  destinationMode?: 'inclusive' | 'exclusive';
  startedAt: number;
  stoppedAt: number;
  status: RunStatus;
  /** Host stopped before task counts could be recovered. */
  interrupted?: boolean;
  waitingFor?: string;
  dueAt?: number;
  executed: number;
  reused: number;
}

export interface ExecutionDetail {
  orchestration?: {
    pages: Record<string,string|number|null>[];
    calls: Record<string,string|number|null>[];
    uncertain: Record<string,string|number|null>[];
    canceled: boolean;
  };
  transitions?: { nodeId: string; at: number; reason: string }[];
  workflow: Workflow;
  /** In visitation order, including cached tasks that participated in this run. */
  tasks: {
    nodeId: string;
    runIndex: number;
    reused: boolean;
    /** Present for finished tasks. An interrupted start keeps only its input. */
    task?: TaskData;
    input?: PortData;
  }[];
  error?: SerializedError;
}

export interface ExecutionStore {
  append(summary: ExecutionSummary, detail: ExecutionDetail): Promise<void>;
  list(workflowId: string, status?: RunStatus): Promise<(ExecutionSummary & { hasDetail: boolean })[]>;
  get(workflowId: string, id: string): Promise<ExecutionDetail | null>;
  delete(workflowId: string, id: string): Promise<void>;
}

export class MemoryExecutionStore implements ExecutionStore {
  readonly #records = new Map<string, { summary: ExecutionSummary; json: string | null; bytes: number }>();
  #bytes = 0;
  readonly #limit: number;
  readonly #budget: number;

  constructor({ maxRecords = 20, maxDetailBytes = 4 * 1024 * 1024 } = {}) {
    for (const n of [maxRecords, maxDetailBytes]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Invalid execution history limit');
    }
    this.#limit = maxRecords;
    this.#budget = maxDetailBytes;
  }

  async append(summary: ExecutionSummary, detail: ExecutionDetail) {
    const json = JSON.stringify(detail);
    const size = new TextEncoder().encode(json).byteLength;
    const keep = size <= this.#budget;
    const entry = { summary: structuredClone(summary), json: keep ? json : null, bytes: keep ? size : 0 };
    const key = JSON.stringify([summary.workflowId, summary.id]);
    this.#remove(key);
    this.#records.set(key, entry);
    this.#bytes += entry.bytes;
    // Late writes from another document retain their original chronological position.
    for (const [oldest] of [...this.#records].sort((a, b) => a[1].summary.startedAt - b[1].summary.startedAt)) {
      if (this.#records.size <= this.#limit && this.#bytes <= this.#budget) break;
      this.#remove(oldest);
    }
  }

  async list(workflowId: string, status?: RunStatus) {
    return [...this.#records.values()].reverse()
      .filter(r => r.summary.workflowId === workflowId && (!status || r.summary.status === status))
      .sort((a, b) => b.summary.startedAt - a.summary.startedAt)
      .map(r => ({ ...r.summary, hasDetail: r.json !== null }));
  }

  async get(workflowId: string, id: string): Promise<ExecutionDetail | null> {
    const json = this.#records.get(JSON.stringify([workflowId, id]))?.json;
    return json ? JSON.parse(json) as ExecutionDetail : null;
  }

  async delete(workflowId: string, id: string) { this.#remove(JSON.stringify([workflowId, id])); }

  #remove(key: string) {
    const old = this.#records.get(key);
    if (old) { this.#bytes -= old.bytes; this.#records.delete(key); }
  }
}
