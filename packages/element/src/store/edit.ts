import { createConnection, createId, createNode, type Connection, type NodePortRef, type NodeType, type Workflow } from '@draflow/core';
import type { Point } from '../canvas/scene.js';

export type Placement = { from: NodePortRef; edge?: Connection };

export function compatible(output: string, input: string) {
  return output === input || (output === 'error' && input === 'main');
}

// Prefer an exact match before using the error-to-main fallback.
export function creatorPorts(type: NodeType, placement: Placement) {
  const from = placement.from.port;
  const to = placement.edge?.to.port;
  const input = type.ports.inputs.find(p => p.type === from) ??
    type.ports.inputs.find(p => compatible(from, p.type));
  const output = type.ports.outputs.find(p => p.type === to) ??
    type.ports.outputs.find(p => to !== undefined && compatible(p.type, to));
  if (!input || (to !== undefined && !output)) return;
  return { input: input.type, output: output?.type };
}

export type Edit =
  | { type: 'move'; positions: Map<string, Point> }
  | { type: 'connect'; from: NodePortRef; to: NodePortRef }
  | { type: 'delete'; nodes: Set<string>; edge?: string }
  | { type: 'add'; nodeType: NodeType; position: Point; placement?: Placement }
  | { type: 'paste'; fragment: Workflow };

function uniqueName(base: string, names: Set<string>) {
  let name = base;
  for (let i = 2; names.has(name); i++) name = base + ' ' + i;
  names.add(name);
  return name;
}

export function fragment(workflow: Workflow, ids: Set<string>): Workflow {
  const nodes = workflow.nodes.filter(n => ids.has(n.id));
  const connections = workflow.connections.filter(e => ids.has(e.from.node) && ids.has(e.to.node));
  const pinData = Object.fromEntries(Object.entries(workflow.pinData ?? {}).filter(([id]) => ids.has(id)));
  return { schema: 'draflow/v1', id: 'clipboard', name: 'Selection', nodes, connections, settings: {}, pinData };
}

export function applyEdit(w: Workflow, edit: Edit): Workflow {
  switch (edit.type) {
    case 'move':
      return { ...w, nodes: w.nodes.map(n => {
        const position = edit.positions.get(n.id);
        return position ? { ...n, position } : n;
      }) };
    case 'connect': {
      const same = (a: NodePortRef, b: NodePortRef) => a.node === b.node && a.port === b.port && a.index === b.index;
      if (w.connections.some(c => same(c.from, edit.from) && same(c.to, edit.to))) return w;
      return { ...w, connections: [...w.connections, createConnection(edit.from, edit.to)] };
    }
    case 'delete': {
      const nodes = w.nodes.filter(n => !edit.nodes.has(n.id));
      const connections = w.connections.filter(e => e.id !== edit.edge && !edit.nodes.has(e.from.node) && !edit.nodes.has(e.to.node));
      if (nodes.length === w.nodes.length && connections.length === w.connections.length) return w;
      const next = { ...w, nodes, connections };
      if (w.pinData) next.pinData = Object.fromEntries(Object.entries(w.pinData).filter(([id]) => !edit.nodes.has(id)));
      return next;
    }
    case 'add': {
      const type = edit.nodeType;
      const name = uniqueName(type.meta.label, new Set(w.nodes.map(n => n.name)));
      const node = createNode({ name, type: type.type, typeVersion: type.version, position: edit.position });
      const nodes = [...w.nodes, node];
      const placement = edit.placement;
      if (!placement) return { ...w, nodes };
      const ports = creatorPorts(type, placement);
      const edge = placement.edge;
      if (!ports || !w.nodes.some(n => n.id === placement.from.node) || (edge && !w.connections.includes(edge))) return w;
      const incoming = createConnection(placement.from, { node: node.id, port: ports.input, index: 0 });
      const connections = edge
        ? w.connections.flatMap(c => c === edge ? [incoming, createConnection({ node: node.id, port: ports.output!, index: 0 }, edge.to)] : [c])
        : [...w.connections, incoming];
      return { ...w, nodes, connections };
    }
    case 'paste': {
      const src = structuredClone(edit.fragment);
      if (!src.nodes.length) return w;
      const ids = new Map(src.nodes.map(node => [node.id, createId('node')]));
      const names = new Set(w.nodes.map(n => n.name));
      const nodes = src.nodes.map(n => ({ ...n, id: ids.get(n.id)!, name: uniqueName(n.name, names),
        position: { x: n.position.x + 32, y: n.position.y + 32 } }));
      const connections = src.connections.flatMap(c => {
        const from = ids.get(c.from.node), to = ids.get(c.to.node);
        return from && to ? [createConnection({ ...c.from, node: from }, { ...c.to, node: to })] : [];
      });
      const next = { ...w, nodes: [...w.nodes, ...nodes], connections: [...w.connections, ...connections] };
      for (const [id, items] of Object.entries(src.pinData ?? {})) {
        const copy = ids.get(id);
        if (copy) next.pinData = { ...next.pinData, [copy]: items };
      }
      return next;
    }
  }
}

/** Immutable document versions share unchanged nodes and edges. One gesture commits one version. */
export class History {
  #past: Workflow[] = [];
  #future: Workflow[] = [];
  get canUndo() { return this.#past.length > 0; }
  get canRedo() { return this.#future.length > 0; }
  record(previous: Workflow) {
    this.#past.push(previous);
    if (this.#past.length > 100) this.#past.shift();
    this.#future = [];
  }
  undo(current: Workflow) {
    if (!this.canUndo) return current;
    this.#future.push(current);
    return this.#past.pop()!;
  }
  redo(current: Workflow) {
    if (!this.canRedo) return current;
    this.#past.push(current);
    return this.#future.pop()!;
  }
}
