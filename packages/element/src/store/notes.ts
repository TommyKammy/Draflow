import { isPlainObject, type JsonValue, type Workflow } from '@draflow/core';

export const colors = ['yellow', 'blue', 'green', 'pink'] as const;
export type Note = {
  id: string; text: string; color: typeof colors[number];
  x: number; y: number; width: number; height: number;
};
const empty: Note[] = [];
function valid(value: JsonValue): value is Note {
  return isPlainObject(value) && typeof value.id === 'string' && !!value.id && typeof value.text === 'string' &&
    colors.some(c => c === value.color) && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    typeof value.width === 'number' && Number.isFinite(value.width) && value.width >= 96 &&
    typeof value.height === 'number' && Number.isFinite(value.height) && value.height >= 64;
}

// An unrecognised envelope is opaque, including a malformed v1 payload.
export function notesOf(workflow: Workflow): readonly Note[] | undefined {
  const data = workflow.meta?.draflowEditor;
  if (data === undefined) return empty;
  if (!isPlainObject(data) || data.version !== 1) return;
  if (data.notes === undefined) return empty;
  if (!Array.isArray(data.notes) || !data.notes.every(valid)) return;
  const ids = new Set(data.notes.map(note => note.id));
  if (ids.size === data.notes.length) return data.notes;
}

export function editNote(w: Workflow, id: string, replacement?: Note): Workflow {
  const notes = notesOf(w);
  if (!notes) return w;
  const previous = notes.find(note => note.id === id);
  if (!previous && !replacement) return w;
  if (replacement && previous && (Object.keys(replacement) as (keyof Note)[]).every(k => replacement[k] === previous[k])) return w;
  let next: Note[];
  if (!replacement) next = notes.filter(note => note.id !== id);
  else if (previous) next = notes.map(note => note.id === id ? { ...note, ...replacement } : note);
  else next = [...notes, replacement];
  const data = w.meta?.draflowEditor;
  return { ...w, meta: { ...w.meta, draflowEditor: { ...(isPlainObject(data) && data), version: 1, notes: next } } };
}
