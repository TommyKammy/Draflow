import {
  ExecutionEngine, NodeRegistry, createWorkflow,
  type EngineEvents, type ExecutionEngineOptions, type NodeType,
  type RunHandle, type RunOptions, type RunResult, type Workflow,
} from '@draflow/core';
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
  const engine = new ExecutionEngine({ ...options.ports, registry });
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
  const canvas = createCanvas(host, registry, { enabled: canEdit, document: () => workflow, commit, undo, redo });
  const tools = document.createElement('div');
  tools.className = 'edit-tools';
  const types = document.createElement('select');
  for (const type of registry.types()) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = registry.require(type).meta.label;
    types.append(option);
  }
  function tool(action: () => void) {
    const control = document.createElement('button');
    control.type = 'button';
    control.onclick = action;
    return control;
  }
  const add = tool(() => {
    const nodeType = registry.get(types.value);
    if (nodeType) commit({ type: 'add', nodeType, position: canvas.centerPoint() });
  });
  const remove = tool(canvas.remove);
  const backward = tool(undo), forward = tool(redo);
  const saveState = document.createElement('span');
  saveState.setAttribute('aria-live', 'polite');
  const retry = tool(() => saves.flush());
  tools.append(types, add, remove, backward, forward, saveState, retry);
  shell.append(header, tools, canvas.panel, outputTitle, status, output);
  root.append(style, shell);

  function updateButton() {
    button.disabled = !!active || readonly || workflow.nodes.length === 0;
    button.textContent = active ? labels.running : labels.run;
  }

  function refreshEditing() {
    const ja = shell.lang === 'ja';
    tools.hidden = readonly;
    types.setAttribute('aria-label', ja ? 'ノードの種類' : 'Node type');
    add.textContent = ja ? '追加' : 'Add';
    remove.textContent = ja ? '削除' : 'Delete';
    backward.textContent = ja ? '元に戻す' : 'Undo';
    forward.textContent = ja ? 'やり直す' : 'Redo';
    retry.textContent = ja ? '保存を再試行' : 'Retry save';
    types.disabled = remove.disabled = !canEdit();
    add.disabled = !canEdit() || !types.length;
    backward.disabled = !canEdit() || !history.canUndo;
    forward.disabled = !canEdit() || !history.canRedo;
    retry.hidden = !saves.error;
    saveState.textContent = saves.error || (options.ports?.storage
      ? (saves.activePending ? (ja ? '未保存' : 'Unsaved') : (ja ? '保存済み' : 'Saved')) : '');
  }
  function change(next: Workflow, source: ChangeMeta['source']) {
    if (next === workflow) return;
    const previous = workflow;
    workflow = next;
    const added = ['add', 'paste'].includes(source)
      ? new Set(next.nodes.slice(previous.nodes.length).map(n => n.id)) : undefined;
    canvas.applyWorkflow(next, added);
    if (source === 'add') canvas.focusNode(next.nodes[next.nodes.length - 1]!.id);
    if (source !== 'move') {
      canvas.scene.resetRun();
      output.textContent = '';
      summary = undefined;
      failure = undefined;
    }
    saves.changed(next);
    refresh();
    const meta = { source, dirty: saves.dirty };
    const snapshot = structuredClone(next);
    host.dispatchEvent(new CustomEvent('draflow-change', { detail: { workflow: snapshot, ...meta }, bubbles: true, composed: true }));
    options.onChange?.(snapshot, meta);
  }
  function commit(edit: Edit) {
    if (!canEdit()) return;
    const next = applyEdit(workflow, edit);
    if (next === workflow) return;
    history.record(workflow);
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
    title.textContent = workflow.name;
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
    const tasks = Object.values(result.runData).flat();
    const last = tasks.reduce<typeof tasks[number] | undefined>(
      (latest, task) => !latest || task.executionIndex > latest.executionIndex ? task : latest, undefined,
    );
    const items = last?.output?.main?.flatMap(port => port ?? []) ?? [];
    const node = workflow.nodes.find(entry => entry.id === last?.nodeId);
    summary = { count: items.length, ...(node ? { node: node.name } : {}) };
    output.textContent = JSON.stringify(items.map(item => item.json), null, 2);
  }

  function run(runOptions: RunOptions = {}): RunHandle {
    if (disposed || readonly || active) throw new Error('Editor cannot start a run');
    const handle = engine.run(workflow, runOptions);
    canvas.cancelEdit();
    active = handle;
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
        showResult(detail.result);
        refresh();
        publish({ type: 'run:finish', detail });
      }),
    ];
    void handle.done.catch((error: unknown) => {
      if (active !== handle) return;
      detach();
      failure = String(error);
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
    run,
    setPresentation(settings: Pick<EditorOptions, 'locale' | 'theme' | 'readonly'>) {
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
      abandon();
      workflow = snapshot;
      history = new History();
      saves.open(snapshot);
      resetView();
    },
    destroy() {
      if (disposed) return;
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
