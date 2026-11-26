import {
  ExecutionEngine, NodeRegistry, createWorkflow,
  type EngineEvents, type ExecutionEngineOptions, type NodeType,
  type RunHandle, type RunOptions, type RunResult, type Workflow,
} from '@draflow/core';
import { createCanvas } from './canvas/view.js';
import { styles } from './styles.js';

export interface EditorOptions {
  workflow?: Workflow;
  nodeTypes?: readonly NodeType[];
  theme?: 'auto' | 'light' | 'dark';
  locale?: 'en' | 'ja';
  readonly?: boolean;
  ports?: Pick<ExecutionEngineOptions, 'clock' | 'fetch'>;
  onRun?: (event: EditorRunEvent) => void;
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
  const canvas = createCanvas(host, registry);
  shell.append(header, canvas.panel, outputTitle, status, output);
  root.append(style, shell);

  function updateButton() {
    button.disabled = !!active || readonly || workflow.nodes.length === 0;
    button.textContent = active ? labels.running : labels.run;
  }

  function refresh() {
    outputTitle.textContent = labels.output;
    status.textContent = active ? labels.running : failure ?? (summary
      ? [summary.node, labels.count(summary.count)].filter(Boolean).join(' · ')
      : labels.empty);
    updateButton();
  }

  function resetView() {
    title.textContent = workflow.name;
    canvas.setWorkflow(workflow);
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
        if (readonly) active?.cancel();
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
      resetView();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      abandon();
      button.onclick = null;
      canvas.destroy();
      shell.remove();
      style.remove();
    },
  };
}

export type WorkflowEditor = ReturnType<typeof createWorkflowEditor>;
