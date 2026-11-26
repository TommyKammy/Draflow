import {
  ExecutionEngine, NodeRegistry, createWorkflow,
  type EngineEvents, type ExecutionEngineOptions, type NodeType,
  type RunData, type TaskData, type RunHandle, type RunOptions, type RunResult, type Workflow,
} from '@draflow/core';
import { nodeDetails } from './details/view.js';
import { fragment } from './store/edit.js';
import { createNodeCreator } from './creator.js';
import { createCanvas } from './canvas/view.js';
import { Autosave } from './store/autosave.js';
import { History, applyEdit, type Edit } from './store/edit.js';
import type { WorkflowStore } from '@draflow/storage';
import { styles } from './styles.js';

export interface EditorOptions {
  workflow?: Workflow;
  nodeTypes?: readonly NodeType[];
  theme?: 'auto' | 'light' | 'dark';
  locale?: 'en' | 'ja';
  readonly?: boolean;
  ports?: Pick<ExecutionEngineOptions, 'clock' | 'fetch'> & { storage?: WorkflowStore };
  onChange?: (workflow: Workflow, meta: ChangeMeta) => void;
  onRun?: (event: EditorRunEvent) => void;
}

export interface ChangeMeta {
  source: Edit['type'] | 'undo' | 'redo';
  dirty: boolean;
}

export type EditorRunEvent = {
  [K in keyof EngineEvents]: { type: K; detail: EngineEvents[K] }
}[keyof EngineEvents];

const messages = {
  en: { run: 'Run workflow', running: 'Running…', output: 'Output', empty: 'Run the workflow to see its output.', count: (n: number) => n + (n === 1 ? ' item' : ' items') },
  ja: { run: '実行', running: '実行中…', output: '出力', empty: '実行すると結果が表示されます。', count: (n: number) => n + '件' },
};

export function createWorkflowEditor(host: HTMLElement, options: EditorOptions = {}) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (root.childNodes.length) throw new Error('Editor host is already in use');
  let workflow = structuredClone(options.workflow ?? createWorkflow());
  const registry = new NodeRegistry().registerAll([...(options.nodeTypes ?? [])]);
  const engine = new ExecutionEngine({ ...options.ports, registry, preview: true });
  let active: RunHandle | undefined;
  let disposed = false;
  let subscriptions: (() => void)[] = [];
  let labels = messages[options.locale ?? 'en'];
  let readonly = options.readonly ?? false;
  let summary: { node?: string; count: number } | undefined;
  let failure: string | undefined;

  const style = document.createElement('style');
  style.textContent = styles;
  const shell = document.createElement('section');
  shell.className = 'editor';
  shell.dataset.theme = options.theme ?? 'auto';
  shell.lang = options.locale ?? 'en';
  const header = document.createElement('header');
  const title = document.createElement('h2');
  const button = document.createElement('button');
  button.type = 'button';
  const outputTitle = document.createElement('h3');
  outputTitle.textContent = labels.output;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const output = document.createElement('pre');
  header.append(title, button);
  let history = new History();
  const saves = new Autosave(options.ports?.storage, () => { if (!disposed) refreshEditing(); });
  saves.open(workflow);
  const canEdit = () => !disposed && !readonly && !active;
  const catalog = registry.types().map(id => registry.require(id));
  const creator = createNodeCreator(catalog, (nodeType, placement) => {
    let preferred;
    if (placement) {
      const start = canvas.scene.cards.get(placement.from.node)?.node.position;
      const end = placement.edge && canvas.scene.cards.get(placement.edge.to.node)?.node.position;
      if (start) preferred = end ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        : { x: start.x + 256, y: start.y };
    }
    commit({ type: 'add', nodeType, position: canvas.centerPoint(preferred), ...(placement && { placement }) });
  });
  let selectedEdge: string | undefined;
  const locale = () => shell.lang === 'ja' ? 'ja' : 'en';
  let cached: RunData | undefined;
  const dirty = new Set<string>();
  const displayed = new Map<string, TaskData>();
  const oldInputs = new Map<string, TaskData>();
  const details = nodeDetails({ registry, engine, canEdit,
    get: id => workflow.nodes.find(n => n.id === id),
    task: id => displayed.get(id) ?? oldInputs.get(id),
    output: id => displayed.get(id)?.output,
    commit: (node, control) => {
      const before = workflow.nodes.find(n => n.id === node.id);
      const declared = registry.get(node.type, node.typeVersion)?.ports.outputs;
      const removeErrorOutput = before?.settings?.onError === 'errorOutput' && node.settings?.onError !== 'errorOutput' &&
        !!declared && !declared.some(p => p.type === 'error');
      commit({ type: 'configure', node, removeErrorOutput }, control);
    },
    execute: runNode,
    duplicate: id => commit({ type: 'paste', fragment: fragment(workflow, new Set([id])) }),
  });
  const canvas = createCanvas(host, registry, { enabled: canEdit, document: () => workflow, commit, undo, redo,
    openDetails: id => details.open(id),
    createFrom: from => { if (canEdit()) creator.open(locale(), { from }); },
    selectEdge: id => { selectedEdge = id; refreshEditing(); },
  });
  const tools = document.createElement('div');
  tools.className = 'edit-tools';
  function tool(action: () => void) {
    const control = document.createElement('button');
    control.type = 'button';
    control.onclick = action;
    return control;
  }
  const add = tool(() => {
    const edge = workflow.connections.find(e => e.id === selectedEdge);
    creator.open(locale(), edge ? { from: edge.from, edge } : undefined);
  });
  const remove = tool(canvas.remove);
  const backward = tool(undo), forward = tool(redo);
  const saveState = document.createElement('span');
  saveState.setAttribute('aria-live', 'polite');
  const retry = tool(() => saves.flush());
  tools.append(add, remove, backward, forward, saveState, retry);
  shell.append(header, tools, canvas.panel, outputTitle, status, output, creator.dialog, details.dialog);
  root.append(style, shell);

  function updateButton() {
    button.disabled = !!active || readonly || workflow.nodes.length === 0;
    button.textContent = active ? labels.running : labels.run;
  }

  function refreshEditing() {
    const ja = shell.lang === 'ja';
    tools.hidden = readonly;
    add.textContent = selectedEdge ? (ja ? '接続にノードを挿入' : 'Insert node') : (ja ? 'ノードを追加' : 'Add node');
    remove.textContent = ja ? '削除' : 'Delete';
    backward.textContent = ja ? '元に戻す' : 'Undo';
    forward.textContent = ja ? 'やり直す' : 'Redo';
    retry.textContent = ja ? '保存を再試行' : 'Retry save';
    remove.disabled = !canEdit();
    add.disabled = !canEdit() || !catalog.some(t => !t.meta.hidden);
    backward.disabled = !canEdit() || !history.canUndo;
    forward.disabled = !canEdit() || !history.canRedo;
    retry.hidden = !saves.error;
    saveState.textContent = saves.error || (options.ports?.storage
      ? (saves.activePending ? (ja ? '未保存' : 'Unsaved') : (ja ? '保存済み' : 'Saved')) : '');
  }
  function change(next: Workflow, source: ChangeMeta['source']) {
    if (next === workflow) return;
    if (source !== 'configure') lastControl = undefined;
    const previous = workflow;
    creator.dialog.close();
    workflow = next;
    const added = ['add', 'paste'].includes(source)
      ? new Set(next.nodes.slice(previous.nodes.length).map(n => n.id)) : undefined;
    canvas.applyWorkflow(next, added);
    if (source === 'add') canvas.focusNode(next.nodes[next.nodes.length - 1]!.id);
    // Undo of a move shares all computation-relevant fields with the previous revision.
    let structural = previous.connections !== next.connections || previous.pinData !== next.pinData ||
      previous.nodes.length !== next.nodes.length;
    const changed = new Set<string>();
    previous.nodes.forEach((before, i) => {
      const after = next.nodes[i];
      if (!after || before.id !== after.id || before.name !== after.name) structural = true;
      else if (before.parameters !== after.parameters || before.settings !== after.settings ||
        before.disabled !== after.disabled) changed.add(after.id);
    });
    if (structural || changed.size) {
      const priorInputs = new Map(oldInputs);
      oldInputs.clear();
      if (structural) { cached = undefined; dirty.clear(); }
      else for (const id of changed) {
        dirty.add(id);
        const task = displayed.get(id) ?? priorInputs.get(id);
        if (task) oldInputs.set(id, task);
      }
      displayed.clear();
      details.refreshData();
      canvas.scene.resetRun();
      output.textContent = '';
      summary = undefined;
      failure = undefined;
    }
    if (source === 'undo' || source === 'redo') details.close();
    saves.changed(next);
    refresh();
    const meta = { source, dirty: saves.dirty };
    const snapshot = structuredClone(next);
    host.dispatchEvent(new CustomEvent('draflow-change', { detail: { workflow: snapshot, ...meta }, bubbles: true, composed: true }));
    options.onChange?.(snapshot, meta);
  }
  let lastControl: HTMLElement | undefined;
  let lastEditAt = 0;
  function commit(edit: Edit, control?: HTMLElement) {
    if (!canEdit()) return;
    const next = applyEdit(workflow, edit);
    if (next === workflow) return;
    const now = performance.now();
    if (!control || control !== lastControl || now - lastEditAt > 300) history.record(workflow);
    lastControl = control;
    lastEditAt = now;
    change(next, edit.type);
  }
  function undo() { if (canEdit()) change(history.undo(workflow), 'undo'); }
  function redo() { if (canEdit()) change(history.redo(workflow), 'redo'); }
  const win = host.ownerDocument.defaultView!;
  const lifetime = new AbortController();
  win.addEventListener('beforeunload', event => {
    if (saves.pending) { event.preventDefault(); event.returnValue = true; }
  }, { signal: lifetime.signal });
  win.addEventListener('pagehide', () => saves.flush(), { signal: lifetime.signal });

  function refresh() {
    outputTitle.textContent = labels.output;
    status.textContent = active ? labels.running : failure ?? (summary
      ? [summary.node, labels.count(summary.count)].filter(Boolean).join(' · ')
      : labels.empty);
    updateButton();
    refreshEditing();
  }

  function resetView() {
    details.close();
    cached = undefined;
    dirty.clear();
    displayed.clear();
    oldInputs.clear();
    lastControl = undefined;
    title.textContent = workflow.name;
    creator.dialog.close();
    canvas.setWorkflow(workflow);
    canvas.scene.resetRun();
    failure = undefined;
    summary = undefined;
    output.textContent = '';
    refresh();
  }

  function detach() {
    for (const off of subscriptions) off();
    subscriptions = [];
    active = undefined;
  }

  function abandon() {
    active?.cancel();
    detach();
  }

  function publish(event: EditorRunEvent) {
    host.dispatchEvent(new CustomEvent('draflow-' + event.type.replace(':', '-'), {
      detail: event.detail, bubbles: true, composed: true,
    }));
    options.onRun?.(event);
  }

  function showResult(result: RunResult) {
    if (result.status !== 'success') {
      failure = result.error?.message ?? result.status;
      return;
    }
    const tasks = [...displayed.values()];
    const last = tasks.reduce<typeof tasks[number] | undefined>(
      (latest, task) => !latest || task.executionIndex > latest.executionIndex ? task : latest, undefined,
    );
    const items = last?.output?.main?.flatMap(port => port ?? []) ?? [];
    const node = workflow.nodes.find(entry => entry.id === last?.nodeId);
    summary = { count: items.length, ...(node ? { node: node.name } : {}) };
    output.textContent = JSON.stringify(items.map(item => item.json), null, 2);
  }

  function runNode(id: string): RunHandle {
    if (!details.flush(true)) throw new Error('Invalid node parameters');
    return run({ destinationNodeId: id, ...(cached && { runData: cached }), dirtyNodeIds: [...dirty, id] });
  }

  function run(runOptions: RunOptions = {}): RunHandle {
    if (disposed || readonly || active) throw new Error('Editor cannot start a run');
    if (!details.flush(true)) throw new Error('Invalid node parameters');
    const handle = engine.run(workflow, runOptions);
    creator.dialog.close();
    canvas.cancelEdit();
    active = handle;
    displayed.clear();
    oldInputs.clear();
    details.refresh();
    canvas.scene.resetRun();
    output.textContent = '';
    failure = undefined;
    summary = undefined;
    refresh();
    subscriptions = [
      handle.on('run:start', detail => publish({ type: 'run:start', detail })),
      handle.on('node:start', detail => {
        canvas.scene.mark(detail.nodeId, 'running');
        publish({ type: 'node:start', detail });
      }),
      handle.on('node:finish', detail => {
        displayed.set(detail.nodeId, detail.task);
        const count = Object.values(detail.task.output ?? {}).reduce(
          (total, ports) => total + ports.reduce((sum, items) => sum + (items?.length ?? 0), 0), 0,
        );
        if (detail.task.status !== 'waiting') canvas.scene.mark(detail.nodeId, detail.task.status, count);
        publish({ type: 'node:finish', detail });
      }),
      handle.on('run:finish', detail => {
        if (active !== handle) return;
        if (detail.result.status === 'error' || detail.result.status === 'canceled') {
          for (const [id, card] of canvas.scene.cards) {
            if (card.state === 'running') canvas.scene.mark(id, detail.result.status);
          }
        }
        detach();
        const result = detail.result;
        cached = result.status === 'success' ? Object.fromEntries([...displayed.keys()].map(id => [id, result.runData[id]!])) : undefined;
        dirty.clear();
        showResult(result);
        details.refresh();
        refresh();
        publish({ type: 'run:finish', detail });
      }),
    ];
    void handle.done.catch((error: unknown) => {
      if (active !== handle) return;
      detach();
      failure = String(error);
      cached = undefined;
      details.refresh();
      refresh();
    });
    return handle;
  }

  button.onclick = () => {
    try { run(); } catch (error) {
      output.textContent = '';
      failure = String(error);
      refresh();
    }
  };
  canvas.setLocale(options.locale ?? 'en');
  resetView();
  return {
    undo, redo,
    fitView: canvas.fitView,
    focusNode: canvas.focusNode,
    run, runNode,
    setPresentation(settings: Pick<EditorOptions, 'locale' | 'theme' | 'readonly'>) {
      details.flush();
      details.close();
      creator.dialog.close();
      if (settings.theme !== undefined) shell.dataset.theme = settings.theme;
      if (settings.locale !== undefined) {
        labels = messages[settings.locale];
        shell.lang = settings.locale;
        canvas.setLocale(settings.locale);
      }
      if (settings.readonly !== undefined) {
        readonly = settings.readonly;
        if (readonly) { canvas.cancelEdit(); active?.cancel(); }
      }
      refresh();
    },
    stop: () => active?.cancel(),
    getWorkflow: () => structuredClone(workflow),
    setWorkflow(next: Workflow) {
      if (disposed) throw new Error('Editor has been destroyed');
      const snapshot = structuredClone(next);
      details.flush();
      abandon();
      workflow = snapshot;
      history = new History();
      saves.open(snapshot);
      resetView();
    },
    destroy() {
      if (disposed) return;
      details.flush();
      details.close();
      disposed = true;
      lifetime.abort();
      saves.flush();
      abandon();
      button.onclick = null;
      canvas.destroy();
      shell.remove();
      style.remove();
    },
  };
}

export type WorkflowEditor = ReturnType<typeof createWorkflowEditor>;
