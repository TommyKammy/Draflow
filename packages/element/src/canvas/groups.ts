import type { Group } from '../store/groups.js';
import type { Translate } from '../locale.js';
import type { Box } from './group-box.js';
import type { Point } from './scene.js';

export function groupLayer(actions: {
  toggle(id: string): void; edit(id: string): void; enabled(): boolean; scale(): number;
  preview(id: string): (offset: Point) => void; move(id: string, offset: Point): void;
}) {
  const layer = document.createElement('div');
  const elements = new Map<string, HTMLElement>();
  let drag: { id: string; pointer: number; button: HTMLButtonElement; start: Point; offset: Point;
    preview: (offset: Point) => void } | undefined;
  function cancel() {
    if (!drag) return;
    const old = drag;
    drag = undefined;
    old.preview({ x: 0, y: 0 });
    if (old.button.hasPointerCapture(old.pointer)) old.button.releasePointerCapture(old.pointer);
  }
  function updatePointer(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const offset = { x: 16 * Math.round((event.clientX - drag.start.x) / actions.scale() / 16),
      y: 16 * Math.round((event.clientY - drag.start.y) / actions.scale() / 16) };
    drag.offset = offset;
    drag.preview(offset);
  }
  function create(id: string) {
    const frame = document.createElement('section');
    frame.className = 'group-frame';
    frame.dataset.groupId = id;
    const bar = document.createElement('div');
    const toggle = document.createElement('button'), label = document.createElement('button');
    toggle.type = label.type = 'button';
    toggle.onclick = () => actions.toggle(id);
    let moved = false;
    label.onclick = e => { if (actions.enabled() && (!moved || !e.detail)) actions.edit(id); moved = false; };
    bar.onpointerdown = e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (e.target !== label || !actions.enabled() || drag) return;
      moved = false;
      label.setPointerCapture(e.pointerId);
      drag = { id, pointer: e.pointerId, button: label, start: { x: e.clientX, y: e.clientY },
        offset: { x: 0, y: 0 }, preview: actions.preview(id) };
    };
    label.onpointermove = updatePointer;
    label.onpointerup = e => {
      if (!drag || e.pointerId !== drag.pointer) return;
      updatePointer(e);
      const { offset } = drag;
      moved = !!(offset.x || offset.y);
      cancel();
      if (moved) actions.move(id, offset);
    };
    label.onlostpointercapture = label.onpointercancel = e => { if (drag?.pointer === e.pointerId) cancel(); };
    bar.onkeydown = e => {
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') cancel();
      const steps: Record<string, Point> = { ArrowLeft: { x: -16, y: 0 }, ArrowRight: { x: 16, y: 0 },
        ArrowUp: { x: 0, y: -16 }, ArrowDown: { x: 0, y: 16 } };
      const step = steps[e.key];
      if (e.target === label && actions.enabled() && step) { e.preventDefault(); actions.move(id, step); }
    };
    bar.append(toggle, label);
    frame.append(bar);
    layer.append(frame);
    elements.set(id, frame);
    return frame;
  }
  function position(id: string, box: Box) {
    const el = elements.get(id);
    if (el) Object.assign(el.style, { left: box.x + 'px', top: box.y + 'px', width: box.width + 'px', height: box.height + 'px' });
  }
  function render(groups: readonly Group[], boxes: Map<string, Box>, collapsed: Set<string>, t: Translate) {
    for (const [id, el] of elements) if (!boxes.has(id)) { el.remove(); elements.delete(id); }
    for (const g of groups) {
      const el = elements.get(g.id) ?? create(g.id);
      position(g.id, boxes.get(g.id)!);
      const [toggle, label] = el.querySelectorAll('button');
      toggle!.textContent = collapsed.has(g.id) ? '▸' : '▾';
      toggle!.setAttribute('aria-expanded', String(!collapsed.has(g.id)));
      toggle!.setAttribute('aria-label', t(collapsed.has(g.id) ? 'Expand' : 'Collapse') + ' · ' + g.label);
      label!.textContent = g.label;
      label!.disabled = !actions.enabled();
      el.setAttribute('aria-label', g.label);
    }
  }
  return { layer, render, position, cancel, focus: (id: string) => elements.get(id)?.querySelector('button')?.focus() };
}
