import { describe, expect, it } from 'vitest';
import { buildGraph, downstreamOf, findCycles, hasPath, upstreamOf } from '../src/graph.js';
import { createConnection, createNode, createWorkflow } from '../src/serialize.js';
import type { Workflow } from '../src/types.js';

function workflow(): Workflow {
  const a = createNode({ id: 'a', type: 'test.a', name: 'A', position: { x: 0, y: 0 } });
  const b = createNode({ id: 'b', type: 'test.b', name: 'B', position: { x: 200, y: 0 } });
  const c = createNode({ id: 'c', type: 'test.c', name: 'C', position: { x: 200, y: 200 } });
  const d = createNode({ id: 'd', type: 'test.d', name: 'D', position: { x: 400, y: 100 } });
  return createWorkflow({
    nodes: [a, b, c, d],
    connections: [
      createConnection({ node: 'a', port: 'main', index: 0 }, { node: 'b', port: 'main', index: 0 }),
      createConnection({ node: 'a', port: 'main', index: 0 }, { node: 'c', port: 'main', index: 0 }),
      createConnection({ node: 'b', port: 'main', index: 0 }, { node: 'd', port: 'main', index: 0 }),
      createConnection({ node: 'c', port: 'main', index: 0 }, { node: 'd', port: 'main', index: 0 }),
    ],
  });
}

describe('graph', () => {
  it('finds starts, sinks, and topological order', () => {
    const graph = buildGraph(workflow());
    expect(graph.startNodes.map((node) => node.id)).toEqual(['a']);
    expect(graph.sinkNodes.map((node) => node.id)).toEqual(['d']);
    expect(graph.topologicalOrder).toHaveLength(4);
    expect(graph.cycles).toEqual([]);
  });

  it('walks upstream and downstream', () => {
    const graph = buildGraph(workflow());
    expect([...upstreamOf(graph, 'd')].sort()).toEqual(['a', 'b', 'c']);
    expect([...downstreamOf(graph, 'a')].sort()).toEqual(['b', 'c', 'd']);
    expect(hasPath(graph, 'a', 'd')).toBe(true);
    expect(hasPath(graph, 'd', 'a')).toBe(false);
  });

  it('detects cycles', () => {
    const graph = buildGraph(workflow());
    const cyclic: Workflow = {
      ...graph.workflow,
      connections: [
        ...graph.workflow.connections,
        createConnection({ node: 'd', port: 'main', index: 0 }, { node: 'a', port: 'main', index: 0 }),
      ],
    };
    const built = buildGraph(cyclic);
    expect(built.cycles.length).toBeGreaterThan(0);
    expect(findCycles(cyclic).length).toBeGreaterThan(0);
  });

  it('rejects connections to unknown nodes', () => {
    const wf = workflow();
    wf.connections.push(
      createConnection({ node: 'a', port: 'main', index: 0 }, { node: 'missing', port: 'main', index: 0 }),
    );
    expect(() => buildGraph(wf)).toThrow(/unknown node/);
  });
});
