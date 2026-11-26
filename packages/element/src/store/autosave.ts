import type { Workflow } from '@draflow/core';
import type { WorkflowStore } from '@draflow/storage';

interface DocumentSave {
  current: Workflow;
  content: string;
  saved: string;
  requested: string | null;
  revision: number;
  error: string | null;
  timer?: ReturnType<typeof setTimeout>;
}

// Reconnecting a custom element can start a new session while its previous save is in flight.
const writers = new WeakMap<WorkflowStore, Map<string, Promise<void>>>();
function writeSnapshot(store: WorkflowStore, workflow: Workflow): Promise<void> {
  let byId = writers.get(store);
  if (!byId) writers.set(store, byId = new Map());
  const previous = byId.get(workflow.id);
  const write = () => store.save(workflow);
  const task = previous ? previous.then(write, write) : write();
  byId.set(workflow.id, task);
  const cleanup = () => {
    if (byId.get(workflow.id) === task) byId.delete(workflow.id);
  };
  void task.then(cleanup, cleanup);
  return task;
}

/** Each document has its own debounce and writer. A completion only acknowledges its snapshot. */
export class Autosave {
  #docs = new Map<string, DocumentSave>();
  #active: DocumentSave | undefined;
  constructor(private store: WorkflowStore | undefined, private notify: () => void,
    private onError?: (workflowId: string, message: string) => void) {}

  open(w: Workflow) {
    const old = this.#active;
    this.flush();
    if (old && old.requested === null && (!this.store || old.content === old.saved)) this.#docs.delete(old.current.id);
    const content = JSON.stringify(w);
    const previous = this.#docs.get(w.id);
    if (previous) {
      previous.current = w;
      previous.content = content;
      this.#active = previous;
      this.#schedule(previous);
    } else {
      this.#active = { current: w, content, saved: content, requested: null, revision: 0, error: null };
      this.#docs.set(w.id, this.#active);
    }
  }
  get dirty() { return !!this.#active && this.#active.content !== this.#active.saved; }
  get activePending() { return this.dirty || this.#active?.requested != null; }
  get pending() {
    return !!this.store && [...this.#docs.values()].some(d => d.requested !== null || d.saved !== d.content);
  }
  get error() { return [...this.#docs.values()].find(d => d.error)?.error ?? null; }
  changed(w: Workflow) {
    const d = this.#active!;
    d.current = w;
    d.content = JSON.stringify(w);
    d.error = null;
    this.#schedule(d);
  }
  #schedule(d: DocumentSave) {
    clearTimeout(d.timer);
    if (this.store && d.content !== d.saved) d.timer = setTimeout(() => this.#write(d), 500);
  }
  flush() {
    for (const d of this.#docs.values()) {
      clearTimeout(d.timer);
      void this.#write(d, true);
    }
  }
  async #write(d: DocumentSave, flush = false) {
    if (!this.store) return;
    if (d.requested === null ? d.content === d.saved : !flush || d.requested === d.content) return;
    const content = d.content;
    // Capture the final revision on flush, even if an older revision is still writing.
    const revision = ++d.revision;
    d.requested = content;
    d.error = null;
    try {
      await writeSnapshot(this.store, structuredClone(d.current));
      d.saved = content;
    } catch (error) {
      if (d.revision === revision && d.content !== d.saved) {
        d.error = d.current.name + ' · ' + String(error);
        this.onError?.(d.current.id, d.error);
      }
    } finally {
      if (d.revision === revision) {
        d.requested = null;
        if (content !== d.content) void this.#write(d);
        if (d !== this.#active && !d.error && d.saved === d.content) this.#docs.delete(d.current.id);
      }
      this.notify();
    }
  }
}
