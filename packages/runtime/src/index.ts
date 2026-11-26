import {
  assertValidWorkflow, ExecutionEngine,
  type ExecutionEngineOptions, type Item, type RunResult, type Workflow, type WorkflowNode,
} from '@draflow/core';

/** Node typeVersion values in the published document are the resolved implementation versions. */
export interface PublishedWorkflow {
  revision: number;
  workflow: Workflow;
}

export interface TriggerEvent {
  items: Item[];
  key?: string;
  runId?: string;
  mode?: 'trigger' | 'webhook';
}

export interface RuntimeExecution {
  workflowId: string;
  revision: number;
  triggerNodeId: string;
  eventKey?: string;
  nodeVersions: Record<string, { type: string; version: number }>;
  result: RunResult;
}

export interface TriggerRegistration {
  workflowId: string;
  revision: number;
  node: WorkflowNode;
  /** Own all registration resources with this signal, including partial setup on failure. */
  signal: AbortSignal;
  fire(event: TriggerEvent): Promise<RuntimeExecution>;
}

interface ActivePublication {
  publication: PublishedWorkflow;
  triggers: Set<string>;
  controller: AbortController;
}

export class MemoryRuntime {
  readonly #engine: ExecutionEngine;
  readonly #register?: (registration: TriggerRegistration) => void | Promise<void>;
  readonly #drafts = new Map<string, Workflow>();
  readonly #releases = new Map<string, Map<number, PublishedWorkflow>>();
  readonly #active = new Map<string, ActivePublication>();
  #lifecycle = Promise.resolve();

  constructor(options: ExecutionEngineOptions & {
    registerTrigger?: (registration: TriggerRegistration) => void | Promise<void>;
  }) {
    this.#engine = new ExecutionEngine(options);
    if (options.registerTrigger) this.#register = options.registerTrigger;
  }

  saveDraft(workflow: Workflow): void {
    this.#drafts.set(workflow.id, structuredClone(workflow));
  }

  loadDraft(id: string): Workflow | undefined {
    return structuredClone(this.#drafts.get(id));
  }

  publish(id: string): PublishedWorkflow {
    const workflow = this.loadDraft(id);
    if (!workflow) throw new Error(`Unknown draft: ${id}`);
    assertValidWorkflow(workflow, this.#engine.registry);
    for (const node of workflow.nodes) {
      node.typeVersion = this.#engine.registry.require(node.type, node.typeVersion).version;
    }
    delete workflow.pinData;
    const releases = this.#releases.get(id);
    let latest = 0;
    for (const revision of releases?.keys() ?? []) latest = Math.max(latest, revision);
    const publication = { revision: latest + 1, workflow };
    this.restore(publication);
    return publication;
  }

  /** Import a published snapshot into memory. Activation is a separate operation. */
  restore(snapshot: PublishedWorkflow): void {
    const publication = structuredClone(snapshot);
    const { revision, workflow } = publication;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid publication revision');
    for (const node of workflow.nodes) {
      const installed = this.#engine.registry.get(node.type, node.typeVersion);
      if (!installed || installed.version !== node.typeVersion) {
        throw new Error(`Node ${node.id} requires ${node.type}@${node.typeVersion}, resolved ${installed?.version ?? 'none'}`);
      }
    }
    assertValidWorkflow(workflow, this.#engine.registry);
    const releases = this.#releases.get(workflow.id) ?? new Map<number, PublishedWorkflow>();
    if (releases.has(revision)) throw new Error(`Duplicate publication: ${workflow.id}@${revision}`);
    releases.set(revision, publication);
    this.#releases.set(workflow.id, releases);
  }

  activeRevision(id: string): number | undefined {
    return this.#active.get(id)?.publication.revision;
  }

  activate(id: string, revision: number): Promise<void> {
    return this.#serialize(async () => {
      const previous = this.#active.get(id);
      if (previous?.publication.revision === revision) return;
      const publication = this.#releases.get(id)?.get(revision);
      if (!publication) throw new Error(`Unknown publication: ${id}@${revision}`);
      const controller = new AbortController();
      const active: ActivePublication = { publication, triggers: new Set(), controller };
      try {
        for (const node of publication.workflow.nodes) {
          const type = this.#engine.registry.require(node.type, node.typeVersion);
          if (node.disabled || type.meta.category !== 'trigger') continue;
          active.triggers.add(node.id);
          await this.#register?.({
            workflowId: id, revision, node: structuredClone(node), signal: controller.signal,
            fire: (event) => this.#dispatch(active, node.id, event),
          });
        }
      } catch (error) {
        controller.abort();
        throw error;
      }
      this.#active.set(id, active);
      previous?.controller.abort();
    });
  }

  deactivate(id: string): Promise<void> {
    return this.#serialize(async () => {
      const previous = this.#active.get(id);
      this.#active.delete(id);
      previous?.controller.abort();
    });
  }

  async fire(id: string, triggerNodeId: string, event: TriggerEvent): Promise<RuntimeExecution> {
    const active = this.#active.get(id);
    if (!active) throw new Error(`Inactive workflow: ${id}`);
    return this.#dispatch(active, triggerNodeId, event);
  }

  async #dispatch(active: ActivePublication, triggerNodeId: string, event: TriggerEvent): Promise<RuntimeExecution> {
    const { workflow, revision } = active.publication;
    if (this.#active.get(workflow.id) !== active) throw new Error('Inactive trigger registration');
    if (!active.triggers.has(triggerNodeId)) throw new Error(`Unknown active trigger: ${triggerNodeId}`);
    const { key, mode = 'trigger', runId } = event;
    const run = this.#engine.run(workflow, {
      ...(runId !== undefined && { runId }), mode, startNodeId: triggerNodeId, triggerData: { main: [event.items] }, pinData: {},
    });
    return {
      workflowId: workflow.id, revision, triggerNodeId,
      ...(key !== undefined && { eventKey: key }),
      nodeVersions: Object.fromEntries(workflow.nodes.map(node => [
        node.id, { type: node.type, version: node.typeVersion },
      ])),
      result: await run.done,
    };
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.#lifecycle.then(operation);
    this.#lifecycle = next.catch(() => {});
    return next;
  }
}
