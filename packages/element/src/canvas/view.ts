import type { NodeRegistry, Workflow } from '@draflow/core';
import { bindEditing, type EditActions } from './editing.js';
import { CanvasScene, cardHeight, cardWidth, type Point } from './scene.js';

const labels = {
  en: ['Workflow canvas', 'Zoom out', 'Zoom in', 'Fit view'],
  ja: ['ワークフローキャンバス', '縮小', '拡大', '全体表示'],
} as const;

export function createCanvas(host: HTMLElement, registry: NodeRegistry, actions: EditActions) {
  const scene = new CanvasScene();
  const panel = document.createElement('section');
  panel.className = 'canvas-panel';
  const surface = document.createElement('div');
  surface.className = 'canvas';
  surface.tabIndex = 0;
  surface.setAttribute('role', 'group');
  const marquee = document.createElement('div');
  marquee.className = 'marquee';
  marquee.hidden = true;
  surface.append(scene.world, marquee);

  const controls = document.createElement('div');
  controls.className = 'view-controls';
  const percent = document.createElement('span');
  function control(text: string, action: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.onclick = action;
    return button;
  }
  const minus = control('−', () => zoomAt(1 / 1.25));
  const plus = control('+', () => zoomAt(1.25));
  const fitButton = control('', fitView);
  controls.append(minus, percent, plus, fitButton);
  panel.append(surface, controls);

  let scale = 1, x = 0, y = 0;
  let minScale = 0.1;
  let fitting = true;
  let frame = 0;
  let space = false;
  let selected = new Set<string>();
  let gesture: { id: number; pan: boolean; origin: Point; start: Point; additive: boolean } | undefined;
  const listeners = new AbortController();
  const opts = { signal: listeners.signal };

  function paint() {
    frame = 0;
    scene.world.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
    percent.textContent = Math.round(scale * 100) + '%';
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(paint); }

  function fitView() {
    editing.cancel();
    fitting = true;
    const { clientWidth: w, clientHeight: h } = surface;
    const b = scene.bounds;
    if (!w || !h) return;
    if (b) {
      scale = Math.min(1, Math.max(1, w - 48) / (b.right - b.left), Math.max(1, h - 48) / (b.bottom - b.top));
      minScale = Math.min(0.1, scale);
      x = (w - (b.left + b.right) * scale) / 2;
      y = (h - (b.top + b.bottom) * scale) / 2;
    } else {
      x = w / 2;
      y = h / 2;
      scale = 1;
      minScale = 0.1;
    }
    schedule();
  }

  function zoomAt(factor: number, point = { x: surface.clientWidth / 2, y: surface.clientHeight / 2 }) {
    editing.cancel();
    const next = Math.min(3, Math.max(minScale, scale * factor));
    x = point.x - (point.x - x) * next / scale;
    y = point.y - (point.y - y) * next / scale;
    scale = next;
    fitting = false;
    schedule();
  }

  function select(ids: Set<string>) {
    if (ids.size) editing.clearEdge();
    if (ids.size === selected.size && [...ids].every(id => selected.has(id))) return;
    for (const id of selected) if (!ids.has(id)) scene.cards.get(id)?.element.setAttribute('aria-pressed', 'false');
    for (const id of ids) scene.cards.get(id)?.element.setAttribute('aria-pressed', 'true');
    selected = ids;
    host.dispatchEvent(new CustomEvent('draflow-selection', {
      detail: { nodeIds: [...ids] }, bubbles: true, composed: true,
    }));
  }

  function point(event: MouseEvent): Point {
    const rect = surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function cardAt(event: Event) {
    return event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.node-card') : null;
  }
  function endGesture() {
    if (gesture && surface.hasPointerCapture(gesture.id)) surface.releasePointerCapture(gesture.id);
    gesture = undefined;
    marquee.hidden = true;
    surface.classList.remove('panning');
  }

  const editing = bindEditing(surface, scene, actions, () => selected, select, event => {
    const p = point(event);
    return { x: (p.x - x) / scale, y: (p.y - y) / scale };
  }, listeners.signal);

  surface.addEventListener('dblclick', event => {
    const hit = (surface.getRootNode() as ShadowRoot).elementFromPoint(event.clientX, event.clientY);
    const card = hit?.closest<HTMLElement>('.node-card');
    if (card?.dataset.nodeId && !hit?.closest('.port')) {
      card.focus({ preventScroll: true });
      actions.openDetails(card.dataset.nodeId);
    }
  }, opts);
  surface.addEventListener('click', event => {
    const id = cardAt(event)?.dataset.nodeId;
    if (id === undefined) return;
    const next = event.shiftKey ? new Set(selected) : new Set<string>();
    if (next.has(id)) next.delete(id);
    else next.add(id);
    select(next);
  }, opts);

  surface.addEventListener('pointerdown', event => {
    if (gesture || (event.button !== 0 && event.button !== 1)) return;
    const pan = event.button === 1 || space || (event.pointerType === 'touch' && !cardAt(event) && !(event.target instanceof SVGPathElement && actions.enabled()));
    if (!pan && editing.pointerdown(event)) return;
    if (!pan && cardAt(event)) return;
    event.preventDefault();
    surface.focus({ preventScroll: true });
    gesture = { id: event.pointerId, pan, start: point(event), origin: { x, y }, additive: event.shiftKey };
    surface.setPointerCapture(event.pointerId);
    surface.classList.toggle('panning', pan);
  }, opts);

  function move(event: PointerEvent) {
    if (gesture?.id !== event.pointerId) return;
    const p = point(event);
    const start = gesture.start;
    if (gesture.pan) {
      fitting = false;
      x = gesture.origin.x + p.x - start.x;
      y = gesture.origin.y + p.y - start.y;
      schedule();
    } else {
      marquee.hidden = false;
      marquee.style.left = Math.min(start.x, p.x) + 'px';
      marquee.style.top = Math.min(start.y, p.y) + 'px';
      marquee.style.width = Math.abs(start.x - p.x) + 'px';
      marquee.style.height = Math.abs(start.y - p.y) + 'px';
    }
  }
  surface.addEventListener('pointermove', move, opts);
  surface.addEventListener('pointerup', event => {
    if (gesture?.id !== event.pointerId) return;
    move(event);
    if (!gesture.pan) {
      const p = point(event);
      const { start } = gesture;
      const ids = gesture.additive ? new Set(selected) : new Set<string>();
      for (const [id, card] of scene.cards) {
        const left = card.node.position.x * scale + x, top = card.node.position.y * scale + y;
        if (left <= Math.max(start.x, p.x) && left + cardWidth * scale >= Math.min(start.x, p.x) &&
            top <= Math.max(start.y, p.y) && top + cardHeight * scale >= Math.min(start.y, p.y)) ids.add(id);
      }
      select(ids);
    }
    endGesture();
  }, opts);
  surface.addEventListener('lostpointercapture', event => {
    if (gesture?.id === event.pointerId) endGesture();
  }, opts);
  surface.addEventListener('pointercancel', event => {
    if (gesture?.id === event.pointerId) endGesture();
  }, opts);
  surface.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1;
    zoomAt(Math.exp(-event.deltaY * unit * 0.002), point(event));
  }, { ...opts, passive: false });

  // Space can be pressed before the first click, while the page still owns focus.
  const win = host.ownerDocument.defaultView!;
  win.addEventListener('keydown', event => {
    if (event.key === ' ' && event.target === host.ownerDocument.body && surface.matches(':hover')) {
      event.preventDefault();
      space = true;
    }
  }, opts);
  win.addEventListener('keyup', event => { if (event.key === ' ') space = false; }, opts);
  win.addEventListener('blur', () => { space = false; endGesture(); }, opts);

  surface.addEventListener('focusin', event => {
    const id = cardAt(event)?.dataset.nodeId;
    const card = id === undefined ? undefined : scene.cards.get(id);
    if (!card) return;
    const left = x + scale * card.node.position.x;
    const top = y + scale * card.node.position.y;
    if (left < 0 || top < 0 || left + scale * cardWidth > surface.clientWidth ||
        top + scale * cardHeight > surface.clientHeight) {
      center(card.node.position);
    }
  }, opts);
  function center(position: Point) {
    fitting = false;
    x = surface.clientWidth / 2 - (position.x + cardWidth / 2) * scale;
    y = surface.clientHeight / 2 - (position.y + cardHeight / 2) * scale;
    schedule();
  }
  surface.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case 'Enter': {
        const id = cardAt(event)?.dataset.nodeId ?? (selected.size === 1 ? [...selected][0] : undefined);
        if (!id) return;
        scene.cards.get(id)?.element.focus({ preventScroll: true });
        actions.openDetails(id);
        break;
      }
      case ' ': space = true; if (cardAt(event)) return; break;
      case '+': case '=': zoomAt(1.25); break;
      case '-': zoomAt(1 / 1.25); break;
      case '0': zoomAt(1 / scale); break;
      case '1': fitView(); break;
      case 'Escape': endGesture(); select(new Set()); break;
      default: return;
    }
    event.preventDefault();
  }, opts);
  surface.addEventListener('focusout', event => {
    if (!(event.relatedTarget instanceof Node) || !surface.contains(event.relatedTarget)) space = false;
  }, opts);
  const observer = new ResizeObserver(() => { if (fitting) fitView(); });
  observer.observe(surface);
  return {
    panel, scene, fitView,
    selection: (): ReadonlySet<string> => selected,
    remove: editing.remove,
    cancelEdit: editing.cancel,
    centerPoint(preferred?: Point) {
      const p = preferred ? { ...preferred } : {
        x: Math.round(((surface.clientWidth / 2 - x) / scale - cardWidth / 2) / 16) * 16,
        y: Math.round(((surface.clientHeight / 2 - y) / scale - cardHeight / 2) / 16) * 16,
      };
      while ([...scene.cards.values()].some(({ node }) =>
        Math.abs(node.position.x - p.x) < cardWidth + 16 && Math.abs(node.position.y - p.y) < cardHeight + 16)) {
        p.y += 96;
      }
      return p;
    },
    applyWorkflow(workflow: Workflow, newIds?: Set<string>) {
      editing.cancel();
      editing.clearEdge();
      scene.setWorkflow(workflow, registry);
      const ids = newIds ?? new Set([...selected].filter(id => scene.cards.has(id)));
      select(ids);
      for (const id of ids) scene.cards.get(id)?.element.setAttribute('aria-pressed', 'true');
    },
    setWorkflow(workflow: Workflow) {
      editing.cancel();
      editing.clearEdge();
      endGesture();
      select(new Set());
      scene.setWorkflow(workflow, registry);
      fitView();
    },
    setLocale(locale: keyof typeof labels) {
      const [name, out, into, fit] = labels[locale];
      surface.setAttribute('aria-label', name);
      minus.setAttribute('aria-label', out);
      plus.setAttribute('aria-label', into);
      fitButton.textContent = fit;
      scene.setLocale(locale);
    },
    focusNode(id: string) {
      const card = scene.cards.get(id);
      if (!card) return;
      center(card.node.position);
      select(new Set([id]));
      card.element.focus({ preventScroll: true });
    },
    destroy() {
      editing.cancel();
      listeners.abort();
      observer.disconnect();
      endGesture();
      cancelAnimationFrame(frame);
      panel.remove();
    },
  };
}
