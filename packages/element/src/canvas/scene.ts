import { groupsOf, type Group } from '../store/groups.js';
import { groupBox, visibleBox, type Box } from './group-box.js';
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
function edgePath(a: Point, b: Point, top: number, include?: (x: number, y: number) => void) {
  const bend = Math.max(20, Math.min(100, Math.abs(b.x - a.x) / 2));
  let d: string;
  if (a.x <= b.x) {
    d = `M ${a.x} ${a.y} C ${a.x + bend} ${a.y} ${b.x - bend} ${b.y} ${b.x} ${b.y}`;
  } else {
    // Route feedback above the cards, including a self-loop at the same height.
    const y = top - 24;
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
  groups: Group[] | undefined = [];
  owner = new Map<string, string>();
  boxes = new Map<string, Box>();
  collapsed = new Set<string>();
  #boundaryOutputs = new Map<string, Point>();
  #boundaryInputs = new Map<string, Point>();
  #nodes = new Map<string, WorkflowNode>();
  positionGroup?: (id: string, box: Box) => void;
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

  setWorkflow(workflow: Workflow, registry: NodeRegistry, overrides: ReadonlyMap<string, boolean>) {
    this.#pins = workflow.pinData;
    this.#connections = workflow.connections;
    this.bounds = undefined;
    this.groups = groupsOf(workflow);
    this.owner.clear(); this.boxes.clear(); this.collapsed.clear(); this.#nodes.clear();
    if (this.groups?.length) {
      for (const n of workflow.nodes) this.#nodes.set(n.id, n);
      for (const group of this.groups) {
        const folded = overrides.get(group.id) ?? group.collapsed;
        const box = visibleBox(groupBox(group.members, this.#nodes), folded);
        if (folded) this.collapsed.add(group.id);
        this.boxes.set(group.id, box);
        this.include(box.x, box.y); this.include(box.x + box.width, box.y + box.height);
        for (const id of group.members) this.owner.set(id, group.id);
      }
    }
    const oldCards = new Set(this.cards.keys());
    for (const node of workflow.nodes) {
      oldCards.delete(node.id);
      const hidden = this.collapsed.has(this.owner.get(node.id)!);
      if (!hidden) this.include(node.position.x, node.position.y);
      if (!hidden) this.include(node.position.x + cardWidth, node.position.y + cardHeight);
      const previous = this.cards.get(node.id);
      if (previous) previous.element.hidden = hidden;
      if (previous?.node === node) continue;
      const type = registry.get(node.type, node.typeVersion);
      const inputs = type?.ports.inputs ?? [];
      const outputs = [...(type?.ports.outputs ?? [])];
      if (node.settings?.onError === 'errorOutput' && !outputs.some(p => p.type === 'error')) {
        outputs.push({ type: 'error' });
      }
      const element = this.cards.get(node.id)?.element ?? document.createElement('button');
      element.hidden = hidden;
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
    this.#boundaryOutputs.clear();
    this.#boundaryInputs.clear();
    if (this.collapsed.size) {
      const inputs = new Map<string, string[]>(), outputs = new Map<string, string[]>();
      function append(lists: Map<string, string[]>, group: string | undefined, edgeId: string) {
        if (group === undefined) return;
        const edges = lists.get(group);
        if (edges) edges.push(edgeId);
        else lists.set(group, [edgeId]);
      }
      for (const edge of workflow.connections) {
        const from = this.foldedGroup(edge.from.node), to = this.foldedGroup(edge.to.node);
        if (from === to) continue;
        append(outputs, from, edge.id); append(inputs, to, edge.id);
      }
      for (const [lists, anchors] of [[inputs, this.#boundaryInputs], [outputs, this.#boundaryOutputs]] as const) {
        for (const [group, edges] of lists) {
          const box = this.boxes.get(group)!;
          const x = box.x + (lists === outputs ? box.width : 0);
          edges.forEach((edge, i) => anchors.set(edge, { x, y: box.y + box.height * (i + 1) / (edges.length + 1) }));
        }
      }
    }
    const oldEdges = new Set(this.#paths.keys());
    for (const edge of workflow.connections) {
      const source = this.cards.get(edge.from.node);
      const target = this.cards.get(edge.to.node);
      if (!source || !target) continue;
      const from = this.foldedGroup(edge.from.node), to = this.foldedGroup(edge.to.node);
      if (from !== undefined && from === to) continue;
      oldEdges.delete(edge.id);
      const path = this.#paths.get(edge.id) ?? document.createElementNS(svgNS, 'path');
      path.dataset.edgeId = edge.id;
      const d = this.route(edge, source, target, zero, zero, (x, y) => this.include(x, y));
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

  private foldedGroup(node: string) {
    const id = this.owner.get(node);
    return id !== undefined && this.collapsed.has(id) ? id : undefined;
  }

  private route(edge: Connection, source: Card, target: Card, sourceOffset: Point, targetOffset: Point,
    include?: (x: number, y: number) => void) {
    const a = this.#boundaryOutputs.get(edge.id) ?? anchor(source, edge.from, true);
    const b = this.#boundaryInputs.get(edge.id) ?? anchor(target, edge.to, false);
    const sourceTop = this.boxes.get(this.foldedGroup(edge.from.node)!)?.y ?? source.node.position.y;
    const targetTop = this.boxes.get(this.foldedGroup(edge.to.node)!)?.y ?? target.node.position.y;
    return edgePath({ x: a.x + sourceOffset.x, y: a.y + sourceOffset.y }, { x: b.x + targetOffset.x, y: b.y + targetOffset.y },
      Math.min(sourceTop + sourceOffset.y, targetTop + targetOffset.y), include);
  }

  previewMove(ids: Set<string>) {
    const cards = [...ids].map(id => this.cards.get(id)!);
    const adjacent = this.#connections.filter(edge => ids.has(edge.from.node) || ids.has(edge.to.node));
    const affected = new Set([...ids].map(id => this.owner.get(id)));
    const groups = this.groups?.filter(g => affected.has(g.id)) ?? [];
    return (offset: Point) => {
      for (const g of groups) this.positionGroup?.(g.id, visibleBox(groupBox(g.members, this.#nodes, ids, offset), this.collapsed.has(g.id)));
      for (const card of cards) {
        card.element.style.transform = offset.x || offset.y ? `translate(${offset.x}px,${offset.y}px)` : '';
      }
      for (const edge of adjacent) {
        const source = this.cards.get(edge.from.node), target = this.cards.get(edge.to.node);
        if (!source || !target) continue;
        this.#paths.get(edge.id)?.setAttribute('d', this.route(edge, source, target,
          ids.has(edge.from.node) ? offset : zero, ids.has(edge.to.node) ? offset : zero));
      }
    };
  }

  include(x: number, y: number) {
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
