import { parseWorkflow, serializeWorkflow, type Workflow } from '@draflow/core';

export interface WorkflowStore {
  load(id: string): Promise<Workflow | null>;
  save(workflow: Workflow): Promise<void>;
}

export class MemoryWorkflowStore implements WorkflowStore {
  readonly #documents = new Map<string, Workflow>();
  async load(id: string) { return structuredClone(this.#documents.get(id) ?? null); }
  async save(workflow: Workflow) { this.#documents.set(workflow.id, structuredClone(workflow)); }
}

export class LocalStorageWorkflowStore implements WorkflowStore {
  constructor(private readonly namespace = 'draflow', private readonly storage: Storage = globalThis.localStorage) {}

  #key(id: string) { return JSON.stringify([this.namespace, id]); }

  async load(id: string) {
    const json = this.storage.getItem(this.#key(id));
    return json === null ? null : parseWorkflow(json);
  }
  async save(workflow: Workflow) {
    this.storage.setItem(this.#key(workflow.id), serializeWorkflow(workflow));
  }
}

export * from './executions.js';
