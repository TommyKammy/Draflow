import type { Connection, NodePortRef, NodeRegistry, PortDef, Workflow, WorkflowNode } from '@draflow/core';

export const cardWidth = 180;
export const cardHeight = 72;
export interface Point { x: number; y: number }
export interface Bounds { left: number; top: number; right: number; bottom: number }
type State = 'running' | 'success' | 'error' | 'canceled';
interface Card {
  element: HTMLButtonElement;
  node: WorkflowNode;
  inputs: PortDef[];
  outputs: PortDef[];
  badge: HTMLElement;
  state?: State;
  count?: number;
}

const svgNS = 'http://www.w3.org/2000/svg';
const words = {
  en: { running: 'Running', success: 'Success', error: 'Error', canceled: 'Canceled', disabled: 'Disabled', pinned: 'Pinned' },
  ja: { running: '実行中', success: '成功', error: 'エラー', canceled: '停止', disabled: '無効', pinned: 'ピン留め' },
};
const portY = (slot: number, total: number) => cardHeight * (slot + 1) / (total + 1);

function anchor(card: Card, ref: NodePortRef, output: boolean): Point {
  const ports = output ? card.outputs : card.inputs;
  const matching = ports.filter(port => port.type === ref.port);
  const port = matching[ref.index];
  const slot = port ? ports.indexOf(port) : -1;
  return {
    x: card.node.position.x + (output ? cardWidth : 0),
    y: card.node.position.y + (slot < 0 ? cardHeight / 2 : portY(slot, ports.length)),
  };
}

const zero = { x: 0, y: 0 };
function edgePath(edge: Connection, source: Card, target: Card, sourceOffset: Point, targetOffset: Point,
  include?: (x: number, y: number) => void) {
  const a = anchor(source, edge.from, true);
  const b = anchor(target, edge.to, false);
  a.x += sourceOffset.x;
  a.y += sourceOffset.y;
  b.x += targetOffset.x;
  b.y += targetOffset.y;
  const bend = Math.max(20, Math.min(100, Math.abs(b.x - a.x) / 2));
  let d: string;
  if (a.x <= b.x) {
    d = `M ${a.x} ${a.y} C ${a.x + bend} ${a.y} ${b.x - bend} ${b.y} ${b.x} ${b.y}`;
  } else {
    // Route feedback above the cards, including a self-loop at the same height.
    const y = Math.min(source.node.position.y + sourceOffset.y, target.node.position.y + targetOffset.y) - 24;
    const right = a.x + 20, left = b.x - 20;
    d = `M ${a.x} ${a.y} Q ${right} ${a.y} ${right} ${a.y - 12} V ${y + 12} Q ${right} ${y} ${right - 12} ${y} H ${left + 12} Q ${left} ${y} ${left} ${y + 12} V ${b.y - 12} Q ${left} ${b.y} ${b.x} ${b.y}`;
    include?.(left, y);
    include?.(right, y);
  }
  return d;
}

export class CanvasScene {
  readonly world = document.createElement('div');
  readonly cards = new Map<string, Card>();
  readonly #edges = document.createElementNS(svgNS, 'svg');
  readonly #paths = new Map<string, SVGPathElement>();
  #connections: Connection[] = [];
  bounds: Bounds | undefined;
  #locale: keyof typeof words = 'en';
  #pins: Workflow['pinData'];

  constructor() {
    this.world.className = 'world';
    this.#edges.setAttribute('width', '1');
    this.#edges.setAttribute('height', '1');
    this.#edges.setAttribute('aria-hidden', 'true');
    this.world.append(this.#edges);
  }

  setWorkflow(workflow: Workflow, registry: NodeRegistry) {
    this.#pins = workflow.pinData;
    this.#connections = workflow.connections;
    this.bounds = undefined;
    const oldCards = new Set(this.cards.keys());
    for (const node of workflow.nodes) {
      oldCards.delete(node.id);
      this.#include(node.position.x, node.position.y);
      this.#include(node.position.x + cardWidth, node.position.y + cardHeight);
      const previous = this.cards.get(node.id);
      if (previous?.node === node) continue;
      const type = registry.get(node.type, node.typeVersion);
      const inputs = type?.ports.inputs ?? [];
      const outputs = [...(type?.ports.outputs ?? [])];
      if (node.settings?.onError === 'errorOutput' && !outputs.some(p => p.type === 'error')) {
        outputs.push({ type: 'error' });
      }
      const element = this.cards.get(node.id)?.element ?? document.createElement('button');
      element.type = 'button';
      element.className = 'node-card';
      element.dataset.nodeId = node.id;
      element.style.left = node.position.x + 'px';
      element.style.top = node.position.y + 'px';
      element.setAttribute('aria-pressed', 'false');
      const title = document.createElement('strong');
      title.textContent = node.name;
      const kind = document.createElement('small');
      kind.textContent = type?.meta.label ?? node.type;
      const badge = document.createElement('span');
      badge.className = 'node-state';
      element.replaceChildren(title, kind, badge);
      for (const [side, ports] of [['input', inputs], ['output', outputs]] as const) {
        const indices = new Map<string, number>();
        ports.forEach((port, slot) => {
          const dot = document.createElement('span');
          dot.className = 'port ' + side;
          dot.style.top = portY(slot, ports.length) + 'px';
          const index = indices.get(port.type) ?? 0;
          indices.set(port.type, index + 1);
          dot.dataset.port = port.type;
          dot.dataset.index = String(index);
          dot.title = port.label ?? port.type;
          element.append(dot);
        });
      }
      if (!element.parentNode) this.world.append(element);
      this.cards.set(node.id, { ...previous, element, node, inputs, outputs, badge });
    }
    for (const id of oldCards) {
      this.cards.get(id)?.element.remove();
      this.cards.delete(id);
    }
    const oldEdges = new Set(this.#paths.keys());
    for (const edge of workflow.connections) {
      const source = this.cards.get(edge.from.node);
      const target = this.cards.get(edge.to.node);
      if (!source || !target) continue;
      oldEdges.delete(edge.id);
      const path = this.#paths.get(edge.id) ?? document.createElementNS(svgNS, 'path');
      path.dataset.edgeId = edge.id;
      const d = edgePath(edge, source, target, zero, zero, (x, y) => this.#include(x, y));
      if (path.getAttribute('d') !== d) path.setAttribute('d', d);
      if (!path.parentNode) this.#edges.append(path);
      this.#paths.set(edge.id, path);
    }
    for (const id of oldEdges) {
      this.#paths.get(id)?.remove();
      this.#paths.delete(id);
    }
    this.setLocale(this.#locale);
  }

  previewMove(ids: Set<string>) {
    const cards = [...ids].map(id => this.cards.get(id)!);
    const adjacent = this.#connections.filter(edge => ids.has(edge.from.node) || ids.has(edge.to.node));
    return (offset: Point) => {
      for (const card of cards) {
        card.element.style.transform = offset.x || offset.y ? `translate(${offset.x}px,${offset.y}px)` : '';
      }
      for (const edge of adjacent) {
        const source = this.cards.get(edge.from.node), target = this.cards.get(edge.to.node);
        if (!source || !target) continue;
        this.#paths.get(edge.id)?.setAttribute('d', edgePath(edge, source, target,
          ids.has(edge.from.node) ? offset : zero, ids.has(edge.to.node) ? offset : zero));
      }
    };
  }

  #include(x: number, y: number) {
    const bounds = this.bounds ??= { left: x, right: x, top: y, bottom: y };
    bounds.left = Math.min(bounds.left, x);
    bounds.right = Math.max(bounds.right, x);
    bounds.top = Math.min(bounds.top, y);
    bounds.bottom = Math.max(bounds.bottom, y);
  }

  setLocale(locale: keyof typeof words) {
    this.#locale = locale;
    for (const card of this.cards.values()) this.#label(card);
  }

  resetRun() {
    for (const card of this.cards.values()) {
      delete card.state;
      delete card.count;
      this.#label(card);
    }
  }

  mark(id: string, state: State, count?: number) {
    const card = this.cards.get(id);
    if (!card) return;
    card.state = state;
    if (count === undefined) delete card.count;
    else card.count = count;
    this.#label(card);
  }

  #label(card: Card) {
    const labels = words[this.#locale];
    const parts = [];
    if (card.node.notesInFlow && card.node.notes) parts.push(card.node.notes);
    if (card.node.disabled) parts.push(labels.disabled);
    if (this.#pins && Object.hasOwn(this.#pins, card.node.id)) parts.push(labels.pinned);
    if (card.state) parts.push(labels[card.state]);
    if (card.count !== undefined) parts.push(this.#locale === 'ja' ? card.count + '件' : String(card.count) + (card.count === 1 ? ' item' : ' items'));
    card.badge.textContent = parts.join(' · ');
    card.element.dataset.state = card.state ?? '';
  }
}
