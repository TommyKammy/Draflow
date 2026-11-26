import type { Note } from '../store/notes.js';
import type { Translate } from '../locale.js';

export function noteLayer(enabled: () => boolean, scale: () => number, open: (note: Note) => void, move: (note: Note) => void) {
  const layer = document.createElement('div');
  layer.className = 'sticky-layer';
  const cards = new Map<string, { card: HTMLElement; body: HTMLButtonElement; grip: HTMLElement; note: Note }>();
  let drag: { pointer: number; clientX: number; clientY: number; note: Note; card: HTMLElement; grip: HTMLElement; scale: number } | undefined;
  function cancel() {
    if (!drag) return;
    const { pointer, card, grip } = drag;
    drag = undefined;
    card.style.transform = '';
    if (grip.hasPointerCapture(pointer)) grip.releasePointerCapture(pointer);
  }
  function delta(event: PointerEvent, origin: NonNullable<typeof drag>) {
    return { x: Math.round((event.clientX - origin.clientX) / origin.scale),
      y: Math.round((event.clientY - origin.clientY) / origin.scale) };
  }
  layer.onpointerdown = event => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const grip = event.target;
    if (!(grip instanceof HTMLElement) || !grip.classList.contains('sticky-grip') || !enabled() || drag) return;
    const entry = cards.get(grip.parentElement!.dataset.noteId!)!;
    event.preventDefault();
    entry.body.focus({ preventScroll: true });
    grip.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, scale: scale(), note: entry.note, card: entry.card, grip };
  };
  layer.onpointermove = event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const { x, y } = delta(event, drag);
    drag.card.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  };
  layer.onpointerup = event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const { note } = drag, { x, y } = delta(event, drag);
    cancel();
    if (enabled() && (x || y)) move({ ...note, x: note.x + x, y: note.y + y });
  };
  layer.onpointercancel = layer.onlostpointercapture = event => { if (drag?.pointer === event.pointerId) cancel(); };
  layer.onkeydown = event => {
    if (event.key === 'Escape' && drag) cancel();
    const historyKey = (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase());
    if (!historyKey) event.stopPropagation();
  };
  layer.onpaste = event => event.stopPropagation();
  function render(notes: readonly Note[], t: Translate) {
    const removed = new Set(cards.keys());
    for (const note of notes) {
      removed.delete(note.id);
      let entry = cards.get(note.id);
      if (!entry) {
        const card = document.createElement('div'), grip = document.createElement('div'), body = document.createElement('button');
        card.className = 'sticky-card';
        card.dataset.noteId = note.id;
        grip.className = 'sticky-grip';
        body.type = 'button';
        body.onclick = () => open(cards.get(note.id)!.note);
        card.append(grip, body);
        layer.append(card);
        cards.set(note.id, entry = { card, grip, body, note });
      }
      entry.note = note;
      const { card, body, grip } = entry;
      Object.assign(card.style, { left: note.x + 'px', top: note.y + 'px', width: note.width + 'px', height: note.height + 'px' });
      card.dataset.color = note.color;
      body.textContent = note.text || t('Sticky note');
      body.setAttribute('aria-label', t('Sticky note') + (note.text ? ' · ' + note.text : ''));
      grip.title = t('Move sticky note');
    }
    for (const id of removed) { cards.get(id)!.card.remove(); cards.delete(id); }
  }
  return { layer, render, cancel, focus: (id: string) => cards.get(id)?.body.focus({ preventScroll: true }) };
}
