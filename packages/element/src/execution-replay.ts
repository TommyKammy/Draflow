import type { NodeRegistry, NodePortRef, Workflow } from '@draflow/core';
import type { ExecutionDetail, ExecutionSummary } from '@draflow/storage';
import { CanvasScene } from './canvas/scene.js';
import { dataPanel } from './details/data.js';
import { button } from './details/fields.js';
import type { Locale, Translate } from './locale.js';
import { groupsOf } from './store/groups.js';

export function executionReplay(detail: ExecutionDetail, summary: ExecutionSummary, registry: NodeRegistry,
  locale: Locale, t: Translate, copy: ((workflow: Workflow) => void) | undefined) {
  const { workflow, tasks } = detail;
  const root = document.createElement('section');
  root.setAttribute('aria-label', t('Execution replay'));
  const title = document.createElement('h3');
  title.textContent = workflow.name + ' · ' + summary.id + ' · ' + t(summary.status);
  title.tabIndex = -1;
  const names = new Map(workflow.nodes.map(n => [n.id, n.name]));
  const scene = new CanvasScene();
  scene.setWorkflow(workflow, registry, new Map(groupsOf(workflow)?.map(group => [group.id, false])));
  scene.setLocale(locale);
  const graph = document.createElement('div');
  graph.className = 'canvas replay-graph';
  graph.inert = true;
  graph.append(scene.world);
  const resize = new ResizeObserver(() => {
    const b = scene.bounds, w = graph.clientWidth, h = graph.clientHeight;
    if (!b || !w || !h) return;
    const scale = Math.min(1, (w - 16) / (b.right - b.left), (h - 16) / (b.bottom - b.top));
    scene.world.style.transform = `translate(${(w - (b.left + b.right) * scale) / 2}px,${(h - (b.top + b.bottom) * scale) / 2}px) scale(${scale})`;
  });
  resize.observe(graph);
  const topology = document.createElement('details');
  const caption = document.createElement('summary');
  caption.textContent = t('Recorded workflow');
  const ports = (ref: NodePortRef) => (names.get(ref.node) ?? ref.node) + ' · ' + ref.port + '[' + ref.index + ']';
  const wiring = document.createElement('ul');
  for (const edge of workflow.connections) {
    const li = document.createElement('li');
    li.textContent = ports(edge.from) + ' → ' + ports(edge.to);
    wiring.append(li);
  }
  const json = document.createElement('pre');
  topology.ontoggle = () => { json.textContent = topology.open ? JSON.stringify(workflow, null, 2) : ''; };
  topology.append(caption, wiring, json);
  const visited = new Set(tasks.map(entry => entry.nodeId));
  const skipped = workflow.nodes.filter(node => !visited.has(node.id));
  root.append(title, graph, topology);
  for (const line of [detail.error?.message, !summary.interrupted && skipped.length && t('Not visited') + ' · ' + skipped.map(n => n.name).join(', ')]) {
    if (line) { const p = document.createElement('p'); p.textContent = line; root.append(p); }
  }

  let index = 0;
  const previous = button(t('Previous task'), () => step(-1)), next = button(t('Next task'), () => step(1));
  const state = document.createElement('p');
  state.setAttribute('aria-live', 'polite');
  const input = dataPanel('Input', t, () => {}), output = dataPanel('Output', t, () => {});
  const panes = document.createElement('div');
  panes.className = 'replay-data';
  panes.append(input.root, output.root);
  const raw = document.createElement('details');
  const rawLabel = document.createElement('summary');
  rawLabel.textContent = t('Recorded task');
  const rawData = document.createElement('pre');
  function showRaw() { rawData.textContent = raw.open ? JSON.stringify(tasks[index], null, 2) : ''; }
  raw.ontoggle = showRaw;
  raw.append(rawLabel, rawData);
  raw.hidden = !tasks.length;
  function step(delta: number) {
    const old = tasks[index];
    if (old) scene.cards.get(old.nodeId)?.element.removeAttribute('aria-pressed');
    index += delta;
    const entry = tasks[index];
    const focused = (root.getRootNode() as ShadowRoot).activeElement;
    previous.disabled = index <= 0;
    next.disabled = index >= tasks.length - 1;
    if (focused === next && next.disabled && !previous.disabled) previous.focus();
    if (focused === previous && previous.disabled && !next.disabled) next.focus();
    input.reset(); output.reset();
    if (!entry) { state.textContent = t('No recorded tasks'); return; }
    const { task } = entry;
    state.textContent = [`${index + 1} / ${tasks.length}`, names.get(entry.nodeId) ?? entry.nodeId, t('Run') + ' ' + entry.runIndex,
      t(task?.status ?? 'Interrupted'), entry.reused && t('reused'), task?.error?.message].filter(Boolean).join(' · ');
    scene.cards.get(entry.nodeId)?.element.setAttribute('aria-pressed', 'true');
    input.set(task?.input ?? entry.input);
    output.set(task?.output);
    showRaw();
  }
  root.append(previous, next, state, panes, raw);
  const copyButton = copy && button(t('Copy to editor'), () => copy(workflow));
  if (copyButton) root.append(copyButton);
  step(0);
  return { root, updateCopy(enabled: boolean) { if (copyButton) copyButton.disabled = !enabled; }, focus: () => title.focus(), destroy() { resize.disconnect(); root.remove(); } };
}
