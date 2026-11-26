import type { Workflow } from '@draflow/core';
import { cardHeight, cardWidth, type Point } from './scene.js';

const columnWidth = Math.ceil((cardWidth + 48) / 16) * 16;
const rowHeight = Math.ceil((cardHeight + 32) / 16) * 16;

// Iterative Kosaraju. The reverse pass numbers SCCs in topological order,
// so a single forward pass below computes their longest-path layers.
function components(out: number[][], incoming: number[][]) {
  const visited = new Set<number>();
  const finished: number[] = [];
  for (let root = 0; root < out.length; root++) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack = [{ node: root, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const next = out[frame.node]![frame.next++];
      if (next === undefined) {
        finished.push(frame.node);
        stack.pop();
      } else if (!visited.has(next)) {
        visited.add(next);
        stack.push({ node: next, next: 0 });
      }
    }
  }
  const owner: number[] = [];
  const members: number[][] = [];
  for (const root of finished.reverse()) {
    if (owner[root] !== undefined) continue;
    const id = members.length;
    members.push([]);
    const stack = [root];
    owner[root] = id;
    while (stack.length) {
      for (const next of incoming[stack.pop()!]!) {
        if (owner[next] !== undefined) continue;
        owner[next] = id;
        stack.push(next);
      }
    }
  }
  owner.forEach((id, node) => members[id]!.push(node));
  return { owner, members };
}

export function tidyPositions(workflow: Workflow, selection: ReadonlySet<string>) {
  const positions = new Map<string, Point>();
  const nodes = selection.size ? workflow.nodes.filter(n => selection.has(n.id)) : workflow.nodes;
  if (!nodes.length) return positions;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const out: number[][] = nodes.map(() => []), incoming: number[][] = nodes.map(() => []);
  for (const edge of workflow.connections) {
    const from = index.get(edge.from.node), to = index.get(edge.to.node);
    if (from === undefined || to === undefined) continue;
    out[from]!.push(to);
    incoming[to]!.push(from);
  }
  const { owner, members } = components(out, incoming);
  const layer = members.map(() => 0);
  members.forEach((group, id) => {
    for (const node of group) for (const target of out[node]!) {
      const next = owner[target]!;
      if (next !== id) layer[next] = Math.max(layer[next]!, layer[id]! + 1);
    }
  });

  // Separate weakly connected components into bands, ordered by their first
  // document node. Order SCCs and their members within each band the same way.
  const bandOf: number[] = [];
  const bands: number[][] = [];
  nodes.forEach((_, root) => {
    if (bandOf[root] !== undefined) return;
    const band = bands.length;
    bands.push([]);
    bandOf[root] = band;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop()!;
      for (const edges of [out[node]!, incoming[node]!]) for (const next of edges) {
        if (bandOf[next] !== undefined) continue;
        bandOf[next] = band;
        stack.push(next);
      }
    }
  });
  owner.forEach((id, node) => {
    if (members[id]![0] === node) bands[bandOf[node]!]!.push(id);
  });

  const originX = 16 * Math.round(nodes.reduce((min, n) => Math.min(min, n.position.x), Infinity) / 16);
  const originY = 16 * Math.round(nodes.reduce((min, n) => Math.min(min, n.position.y), Infinity) / 16);
  // Each fixed card intersects at most four candidate cells, even off-grid.
  const blocked = new Map<number, Set<number>>();
  for (const { id, position } of workflow.nodes) {
    if (index.has(id)) continue;
    const x = position.x - originX, y = position.y - originY;
    const left = Math.floor((x - cardWidth) / columnWidth) + 1;
    const top = Math.floor((y - cardHeight) / rowHeight) + 1;
    for (const col of [left, left + 1]) {
      if (col < 0 || col >= members.length || col >= (x + cardWidth) / columnWidth) continue;
      const rows = blocked.get(col) ?? new Set<number>();
      blocked.set(col, rows);
      for (const row of [top, top + 1]) {
        if (row >= 0 && row < (y + cardHeight) / rowHeight) rows.add(row);
      }
    }
  }
  function freeRow(col: number, row: number) {
    const occupied = blocked.get(col);
    while (occupied?.has(row)) row++;
    return row;
  }
  // Anchor the first band at a free cell. Its minimum y remains the origin
  // on a second layout, including when fixed cards occupy the original anchor.
  let start = freeRow(layer[bands[0]![0]!]!, 0);
  for (const band of bands) {
    const nextRow = new Map<number, number>();
    let bottom = start;
    for (const id of band) {
      const col = layer[id]!;
      let row = nextRow.get(col) ?? start;
      for (const i of members[id]!) {
        row = freeRow(col, row);
        const x = originX + col * columnWidth, y = originY + row * rowHeight;
        const node = nodes[i]!;
        if (node.position.x !== x || node.position.y !== y) positions.set(node.id, { x, y });
        row++;
      }
      nextRow.set(col, row);
      bottom = Math.max(bottom, row);
    }
    start = bottom + 1;
  }
  return positions;
}
