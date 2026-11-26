import { isPlainObject, type Workflow } from '@draflow/core';

export type Group = { id: string; label: string; members: string[]; collapsed: boolean };

export function groupsOf(w: Workflow): Group[] | undefined {
  const data = w.meta?.draflowEditor;
  if (data === undefined) return [];
  if (!isPlainObject(data) || data.version !== 1) return;
  if (data.groups === undefined) return [];
  if (!Array.isArray(data.groups)) return;
  const ids = new Set<string>(), nodes = new Set(w.nodes.map(n => n.id));
  for (const group of data.groups) {
    if (!isPlainObject(group) || typeof group.id !== 'string' || ids.has(group.id) ||
        typeof group.label !== 'string' || typeof group.collapsed !== 'boolean' ||
        !Array.isArray(group.members) || !group.members.length) return;
    ids.add(group.id);
    for (const id of group.members) if (typeof id !== 'string' || !nodes.delete(id)) return;
  }
  return data.groups as Group[];
}

export function withGroups(w: Workflow, groups: Group[]): Workflow {
  const data = w.meta?.draflowEditor;
  return { ...w, meta: { ...w.meta, draflowEditor: { ...(isPlainObject(data) && data), version: 1, groups } } };
}
