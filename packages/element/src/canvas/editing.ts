import { parseWorkflow, type NodePortRef, type Workflow } from '@draflow/core';
import { compatible, fragment, type Edit } from '../store/edit.js';
import type { CanvasScene, Point } from './scene.js';

export interface EditActions {
  openDetails(id: string): void;
  enabled(): boolean;
  document(): Workflow;
  commit(edit: Edit): void;
  createFrom(from: NodePortRef): void;
  selectEdge(id?: string): void;
  undo(): void;
  redo(): void;
}
const snap = (n: number) => Math.round(n / 16) * 16;
const empty = { x: 0, y: 0 };
const mime = 'application/x-draflow-selection+json';

export function bindEditing(surface: HTMLElement, scene: CanvasScene, actions: EditActions,
  selection: () => Set<string>, select: (ids: Set<string>) => void,
  worldPoint: (event: PointerEvent) => Point, signal: AbortSignal) {
  let edge: SVGPathElement | undefined;
  let drag: {
    pointer: number; nodeId: string; start: Point; anchor: Point; ids: Set<string>; offset: Point;
    preview: (offset: Point) => void; moved: boolean; startClient: Point;
  } | undefined;
  let wire: { pointer: number; from: NodePortRef; start: Point; path: SVGPathElement } | undefined;
  let frame = 0;
  function clearEdge() {
    if (edge) actions.selectEdge();
    edge?.classList.remove('selected-edge');
    edge = undefined;
  }
  function cancel() {
    cancelAnimationFrame(frame);
    frame = 0;
    const pointer = drag?.pointer ?? wire?.pointer;
    if (drag?.moved) drag.preview(empty);
    wire?.path.remove();
    drag = undefined;
    wire = undefined;
    if (pointer !== undefined && surface.hasPointerCapture(pointer)) surface.releasePointerCapture(pointer);
  }
  function port(el: Element | null, side: string): NodePortRef | undefined {
    const dot = el?.closest<HTMLElement>('.port.' + side);
    const id = dot?.closest<HTMLElement>('.node-card')?.dataset.nodeId;
    if (!dot || !id || !surface.contains(dot)) return;
    return { node: id, port: dot.dataset.port!, index: Number(dot.dataset.index) };
  }
  function pointerdown(event: PointerEvent): boolean {
    if (!actions.enabled() || event.button !== 0 || !(event.target instanceof Element)) return false;
    if (drag || wire) return true;
    clearEdge();
    const target = event.target;
    const start = worldPoint(event);
    const from = port(target, 'output');
    const id = target.closest<HTMLElement>('.node-card')?.dataset.nodeId;
    if (from) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('wire-preview');
      scene.world.querySelector('svg')!.append(path);
      wire = { pointer: event.pointerId, from, start, path };
    } else if (target instanceof SVGPathElement && target.dataset.edgeId) {
      select(new Set());
      edge = target;
      edge.classList.add('selected-edge');
      actions.selectEdge(target.dataset.edgeId);
    } else if (id && !event.shiftKey) {
      const ids = selection().has(id) ? new Set(selection()) : new Set([id]);
      const anchor = scene.cards.get(id)!.node.position;
      drag = { pointer: event.pointerId, nodeId: id, ids, start, anchor, moved: false, preview: scene.previewMove(ids),
        offset: empty, startClient: { x: event.clientX, y: event.clientY } };
      select(ids);
    } else {
      return false;
    }
    event.preventDefault();
    surface.focus({ preventScroll: true });
    surface.setPointerCapture(event.pointerId);
    return true;
  }
  function move(event: PointerEvent) {
    if (wire?.pointer === event.pointerId) {
      const p = worldPoint(event);
      wire.path.setAttribute('d', `M ${wire.start.x} ${wire.start.y} L ${p.x} ${p.y}`);
      return;
    }
    if (drag?.pointer !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startClient.x, event.clientY - drag.startClient.y) < 4) return;
    drag.moved = true;
    const p = worldPoint(event);
    drag.offset = { x: snap(drag.anchor.x + p.x - drag.start.x) - drag.anchor.x,
      y: snap(drag.anchor.y + p.y - drag.start.y) - drag.anchor.y };
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      if (drag) drag.preview(drag.offset);
    });
  }
  function moveNodes(ids: Set<string>, offset: Point) {
    if (!offset.x && !offset.y) return;
    const positions = new Map<string, Point>();
    for (const id of ids) {
      const pos = scene.cards.get(id)?.node.position;
      if (pos) positions.set(id, { x: pos.x + offset.x, y: pos.y + offset.y });
    }
    if (positions.size) actions.commit({ type: 'move', positions });
  }
  surface.addEventListener('pointermove', move, { signal });
  surface.addEventListener('pointerup', event => {
    if (drag?.pointer === event.pointerId) {
      move(event);
      const { nodeId, ids, offset, moved } = drag;
      cancel();
      if (moved) moveNodes(ids, offset);
      else select(new Set([nodeId]));
    } else if (wire?.pointer === event.pointerId) {
      const from = wire.from;
      const root = surface.getRootNode() as ShadowRoot;
      const hit = root.elementFromPoint(event.clientX, event.clientY);
      const to = port(hit, 'input');
      const clicked = port(hit, 'output');
      cancel();
      if (to && compatible(from.port, to.port)) {
        actions.commit({ type: 'connect', from, to });
      } else if (clicked && clicked.node === from.node && clicked.port === from.port && clicked.index === from.index) {
        actions.createFrom(from);
      }
    }
  }, { signal });
  const interrupted = (event: PointerEvent) => {
    if (event.pointerId === (drag?.pointer ?? wire?.pointer)) cancel();
  };
  surface.addEventListener('lostpointercapture', interrupted, { signal });
  surface.addEventListener('pointercancel', interrupted, { signal });
  function remove() {
    const id = edge?.dataset.edgeId;
    actions.commit({ type: 'delete', nodes: selection(), ...(id ? { edge: id } : {}) });
  }
  surface.addEventListener('keydown', event => {
    if (event.isComposing || !actions.enabled()) return;
    const key = event.key.toLowerCase();
    if (event.metaKey || event.ctrlKey) {
      if (key === 'z') event.shiftKey ? actions.redo() : actions.undo();
      else if (key === 'y') actions.redo();
      else if (key === 'd') actions.commit({ type: 'paste', fragment: fragment(actions.document(), selection()) });
      else return;
    } else if (key === 'delete' || key === 'backspace') remove();
    else if (key === 'escape') { cancel(); clearEdge(); }
    else if (key.startsWith('arrow') && selection().size) {
      moveNodes(selection(), { x: key === 'arrowleft' ? -16 : key === 'arrowright' ? 16 : 0,
        y: key === 'arrowup' ? -16 : key === 'arrowdown' ? 16 : 0 });
    } else return;
    event.preventDefault();
  }, { signal });
  surface.addEventListener('copy', event => {
    if (!selection().size || !event.clipboardData) return;
    event.clipboardData.setData(mime, JSON.stringify(fragment(actions.document(), selection())));
    event.preventDefault();
  }, { signal });
  surface.addEventListener('paste', event => {
    const json = event.clipboardData?.getData(mime);
    if (!actions.enabled() || !json) return;
    event.preventDefault();
    let copied: Workflow;
    try { copied = parseWorkflow(json); } catch { return; }
    actions.commit({ type: 'paste', fragment: copied });
  }, { signal });
  return { pointerdown, cancel, remove, clearEdge };
}
