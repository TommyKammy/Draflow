import { executionHistory } from './execution-history.js';
import { recordExecution } from './record-execution.js';
import { commandPalette } from './command-palette.js';
import { groupDialog } from './group-dialog.js';
import { noteDialog } from './sticky.js';
import {
  createId, ExecutionEngine, NodeRegistry, buildGraph, createWorkflow, downstreamOf, upstreamOf,
  type EngineEvents, type ExecutionEngineOptions, type NodeType,
  type RunData, type TaskData, type RunHandle, type RunOptions, type RunResult, type Workflow,
} from '@draflow/core';
import { translator } from './locale.js';
import { connectionDialog } from './connect.js';
import { executionLog } from './execution-log.js';
import { nodeDetails } from './details/view.js';
import { fragment } from './store/edit.js';
import { createNodeCreator } from './creator.js';
import { tidyPositions } from './canvas/tidy.js';
import { createCanvas } from './canvas/view.js';
import { Autosave } from './store/autosave.js';
import { History, applyEdit, type Edit } from './store/edit.js';
import type { ExecutionStore, WorkflowStore } from '@draflow/storage';
import { styles } from './styles.js';

export interface EditorOptions {
  workflow?: Workflow;
  nodeTypes?: readonly NodeType[];
  theme?: 'auto' | 'light' | 'dark';
  locale?: 'en' | 'ja';
  readonly?: boolean;
  ports?: Pick<ExecutionEngineOptions, 'clock' | 'fetch'> & { storage?: WorkflowStore; executions?: ExecutionStore };
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
  const stopButton = tool(stop);
  header.append(title, button, stopButton);
  const log = executionLog(clearExecution, translator(options.locale ?? 'en'));
  let history = new History();
  const saves = new Autosave(options.ports?.storage, () => { if (!disposed) refreshEditing(); }, (workflowId, message) => {
    if (!disposed) host.dispatchEvent(new CustomEvent('draflow-toast', {
      detail: { workflowId, message }, bubbles: true, composed: true,
    }));
  });
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
  const previewInputs = new Map<string, TaskData[]>();
  const makeDetails = () => nodeDetails({ registry, engine, canEdit,
    get: id => workflow.nodes.find(n => n.id === id),
    tasks: id => previewInputs.get(id) ?? [],
    hasOutput: id => displayed.has(id),
    ancestors: id => {
      const ids = upstreamOf(buildGraph(workflow), id);
      return workflow.nodes.filter(n => n.id !== id && ids.has(n.id)).map(n => n.name);
    },
    pinned: id => workflow.pinData && Object.hasOwn(workflow.pinData, id) ? workflow.pinData[id] : undefined,
    pin: (id, items) => commit({ type: 'pin', id, items }),
    commit: (node, control) => {
      const before = workflow.nodes.find(n => n.id === node.id);
      const declared = registry.get(node.type, node.typeVersion)?.ports.outputs;
      const removeErrorOutput = before?.settings?.onError === 'errorOutput' && node.settings?.onError !== 'errorOutput' &&
        !!declared && !declared.some(p => p.type === 'error');
      const removePin = node.settings?.onError === 'errorOutput' && before?.settings?.onError !== 'errorOutput';
      commit({ type: 'configure', node, removeErrorOutput, removePin }, control);
    },
    execute: runNode, previous: runPreviousNodes, stop, running: () => !!active, failure: () => failure,
    duplicate: id => commit({ type: 'paste', fragment: fragment(workflow, new Set([id])) }),
  }, translator(locale()));
  let details = makeDetails();
  const sticky = noteDialog((id, value) => {
    commit({ type: 'note', id, ...(value && { value }) });
    if (value) canvas.focusNote(id);
    else addNote.focus();
  });
  const groupForm = groupDialog((id, value) => {
    commit({ type: 'group', id, ...(value && { value }) });
    if (value) canvas.focusGroup(id);
    else canvas.panel.querySelector<HTMLElement>('.canvas')?.focus();
  });
  const canvas = createCanvas(host, registry, { enabled: canEdit, document: () => workflow, commit, undo, redo,
    editGroup: g => groupForm.open(g, true, translator(locale())), selectionChanged: refreshEditing,
    openNote: note => sticky.open(note, true, canEdit(), translator(locale())),
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
  const wiring = connectionDialog(canvas.scene, (from, to) => commit({ type: 'connect', from, to }));
  const connect = tool(() => wiring.open(translator(locale())));
  const addNote = tool(() => {
    if (!canEdit() || !canvas.notesEditable()) return;
    sticky.open({ id: createId('note'), text: '', color: 'yellow', ...canvas.centerPoint(undefined, 208, 128), width: 208, height: 128 },
      false, true, translator(locale()));
  });
  const group = tool(() => {
    const members = [...canvas.selection()];
    groupForm.open({ id: createId('group'), label: translator(locale())('Group'), members, collapsed: false }, false, translator(locale()));
  });
  const tidy = tool(() => {
    if (!canEdit()) return;
    const positions = tidyPositions(workflow, canvas.selection());
    if (positions.size) commit({ type: 'move', positions });
  });
  const remove = tool(canvas.remove);
  const backward = tool(undo), forward = tool(redo);
  const saveState = document.createElement('span');
  saveState.setAttribute('aria-live', 'polite');
  const retry = tool(() => saves.flush());
  tools.append(add, connect, addNote, group, tidy, remove, backward, forward, saveState, retry);
  const palette = commandPalette([
    { id: 'add', label: () => selectedEdge ? 'Insert node' : 'Add node', control: add },
    { id: 'fit', label: 'Fit view', control: canvas.fitButton },
    { id: 'tidy', label: 'Tidy Up', control: tidy },
    { id: 'group', label: 'Group nodes', control: group },
    { id: 'note', label: 'Add sticky note', control: addNote },
    { id: 'run', label: 'Run workflow', control: button },
    { id: 'stop', label: 'Stop', control: stopButton },
  ], locale);
  const commands = tool(() => { commands.focus(); palette.open(); });
  commands.setAttribute('aria-keyshortcuts', 'Control+K Meta+K');
  header.append(commands);
  shell.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.altKey || e.shiftKey ||
        !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k' || shell.querySelector('dialog[open]')) return;
    if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest('input,textarea,select'))) return;
    e.preventDefault();
    e.stopPropagation();
    palette.open();
  }, { capture: true });
  shell.append(palette.dialog, header, tools, canvas.panel, outputTitle, status, output, log.panel, groupForm.dialog, sticky.dialog, wiring.dialog, creator.dialog, details.dialog);
  const executions = options.ports?.executions;
  const archive = executions && executionHistory(executions, () => workflow, () => !readonly, translator(locale()));
  if (archive) {
    header.append(archive.button);
    header.after(archive.warning);
    shell.append(archive.dialog);
  }
  root.append(style, shell);

  function updateButton() {
    button.disabled = !!active || readonly || workflow.nodes.length === 0;
    stopButton.hidden = !active;
    stopButton.textContent = shell.lang === 'ja' ? '停止' : 'Stop';
    button.textContent = active ? labels.running : labels.run;
  }

  function refreshEditing() {
    const ja = shell.lang === 'ja';
    commands.textContent = translator(locale())('Command palette');
    tools.hidden = readonly;
    add.textContent = selectedEdge ? (ja ? '接続にノードを挿入' : 'Insert node') : (ja ? 'ノードを追加' : 'Add node');
    remove.textContent = ja ? '削除' : 'Delete';
    backward.textContent = ja ? '元に戻す' : 'Undo';
    forward.textContent = ja ? 'やり直す' : 'Redo';
    retry.textContent = ja ? '保存を再試行' : 'Retry save';
    connect.textContent = translator(locale())('Connect nodes');
    connect.disabled = !canEdit() || !workflow.nodes.length;
    addNote.textContent = translator(locale())('Add sticky note');
    addNote.disabled = !canEdit() || !canvas.notesEditable();
    group.textContent = translator(locale())('Group nodes');
    group.disabled = !canEdit() || !canvas.scene.groups || !canvas.selection().size ||
      [...canvas.selection()].some(id => canvas.scene.owner.has(id));
    canvas.refreshGroups();
    tidy.textContent = ja ? '自動整列' : 'Tidy Up';
    tidy.disabled = !canEdit() || !workflow.nodes.length;
    remove.disabled = !canEdit();
    add.disabled = !canEdit() || !catalog.some(t => !t.meta.hidden);
    backward.disabled = !canEdit() || !history.canUndo;
    forward.disabled = !canEdit() || !history.canRedo;
    palette.refresh();
    retry.hidden = !saves.error;
    saveState.textContent = saves.error || (options.ports?.storage
      ? (saves.activePending ? (ja ? '未保存' : 'Unsaved') : (ja ? '保存済み' : 'Saved')) : '');
  }
  function change(next: Workflow, source: ChangeMeta['source']) {
    if (next === workflow) return;
    if (source !== 'configure') lastControl = undefined;
    const previous = workflow;
    groupForm.dialog.close();
    sticky.dialog.close();
    wiring.dialog.close();
    creator.dialog.close();
    workflow = next;
    const added = ['add', 'paste'].includes(source)
      ? new Set(next.nodes.slice(previous.nodes.length).map(n => n.id)) : undefined;
    canvas.applyWorkflow(next, added);
    if (source === 'add') canvas.focusNode(next.nodes[next.nodes.length - 1]!.id);
    // Undo of a move shares all computation-relevant fields with the previous revision.
    let structural = previous.connections !== next.connections ||
      previous.nodes.length !== next.nodes.length;
    const changed = new Set<string>();
    previous.nodes.forEach((before, i) => {
      const after = next.nodes[i];
      if (!after || before.id !== after.id || before.name !== after.name) structural = true;
      else if (before.parameters !== after.parameters || before.settings !== after.settings ||
        before.disabled !== after.disabled || previous.pinData?.[after.id] !== next.pinData?.[after.id]) changed.add(after.id);
    });
    if (structural || changed.size) {
      if (structural) {
        cached = undefined;
        dirty.clear();
        previewInputs.clear();
      } else {
        // A configuration edit changes this node's output, but not its incoming items.
        const newlyDirty = [...changed].filter(id => !dirty.has(id));
        if (newlyDirty.length && previewInputs.size) {
          const graph = buildGraph(next);
          for (const id of newlyDirty) {
            for (const downstream of downstreamOf(graph, id)) previewInputs.delete(downstream);
          }
        }
        for (const id of newlyDirty) dirty.add(id);
      }
      log.reset(!!cached || previewInputs.size > 0);
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
    archive?.reset();
    details.close();
    log.reset();
    cached = undefined;
    dirty.clear();
    displayed.clear();
    previewInputs.clear();
    lastControl = undefined;
    title.textContent = workflow.name;
    palette.dialog.close();
    groupForm.dialog.close();
    sticky.dialog.close();
    wiring.dialog.close();
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
    if (!readonly) canvas.resetGroupView();
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

  function clearExecution() {
    if (disposed || active) return;
    cached = undefined;
    dirty.clear();
    displayed.clear();
    previewInputs.clear();
    log.reset();
    canvas.scene.resetRun();
    output.textContent = '';
    summary = undefined;
    failure = undefined;
    details.refreshData();
    refresh();
  }

  function stop() { active?.cancel(); }

  function runPartial(id: string, destinationMode: 'exclusive' | 'inclusive') {
    if (!details.flush(true)) throw new Error('Invalid node parameters');
    return run({ destinationNodeId: id, destinationMode, ...(cached && { runData: cached }), dirtyNodeIds: [...dirty, id] });
  }
  function runNode(id: string) { return runPartial(id, 'inclusive'); }
  function runPreviousNodes(id: string) { return runPartial(id, 'exclusive'); }

  function run(runOptions: RunOptions = {}): RunHandle {
    if (disposed || readonly || active) throw new Error('Editor cannot start a run');
    if (!details.flush(true)) throw new Error('Invalid node parameters');
    const snapshot = workflow; // Edits replace the document. The host receives clones.
    let handle: RunHandle;
    try {
      handle = engine.run(snapshot, runOptions);
    } catch (error) {
      clearExecution();
      failure = String(error);
      log.fail(failure, snapshot.name);
      details.refreshData();
      refresh();
      throw error;
    }
    if (executions && archive && snapshot.settings.saveExecutionData !== 'none') {
      const visible = () => !disposed && snapshot.id === workflow.id;
      recordExecution(executions, handle, snapshot, runOptions,
        () => { if (visible()) void archive.refresh(); },
        error => { if (visible()) archive.failed(error); });
    }
    log.start(handle.id, snapshot.name);
    groupForm.dialog.close();
    sticky.dialog.close();
    wiring.dialog.close();
    creator.dialog.close();
    canvas.cancelEdit();
    active = handle;
    displayed.clear();
    previewInputs.clear();
    canvas.scene.resetRun();
    output.textContent = '';
    failure = undefined;
    summary = undefined;
    details.refresh();
    refresh();
    subscriptions = [
      handle.on('run:start', detail => publish({ type: 'run:start', detail })),
      handle.on('node:start', detail => {
        if (active !== handle) return;
        log.nodeStart(detail);
        canvas.scene.mark(detail.nodeId, 'running');
        publish({ type: 'node:start', detail });
      }),
      handle.on('node:finish', detail => {
        if (active !== handle) return;
        log.nodeFinish(detail);
        displayed.set(detail.nodeId, detail.task);
        const tasks = previewInputs.get(detail.nodeId) ?? [];
        tasks[detail.runIndex] = detail.task;
        previewInputs.set(detail.nodeId, tasks);
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
        log.finish(result, snapshot.name);
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
      log.fail(failure, snapshot.name, handle.id);
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
    run, runNode, runPreviousNodes, clearExecution, stop,
    setPresentation(settings: Pick<EditorOptions, 'locale' | 'theme' | 'readonly'>) {
      const nextLocale = settings.locale;
      const localeChanged = nextLocale !== undefined && nextLocale !== shell.lang;
      if (localeChanged || (settings.readonly !== undefined && settings.readonly !== readonly)) {
        archive?.reset();
        palette.dialog.close();
        details.flush();
        details.close();
        groupForm.dialog.close();
        sticky.dialog.close();
        wiring.dialog.close();
        creator.dialog.close();
      }
      if (settings.theme !== undefined) shell.dataset.theme = settings.theme;
      if (localeChanged) {
        labels = messages[nextLocale];
        shell.lang = nextLocale;
        canvas.setLocale(nextLocale);
        const oldDialog = details.dialog;
        details = makeDetails();
        oldDialog.replaceWith(details.dialog);
        log.setLocale(translator(nextLocale));
        archive?.setLocale(translator(nextLocale));
      }
      if (settings.readonly !== undefined && settings.readonly !== readonly) {
        readonly = settings.readonly;
        canvas.resetGroupView();
        if (readonly) { canvas.cancelEdit(); active?.cancel(); }
      }
      refresh();
    },
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
      archive?.reset();
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
