import { WorkflowValidationError } from './errors.js';
import type { Connection, Workflow, WorkflowNode } from './types.js';
import { isUnsafeObjectKey } from './utils.js';

export interface WorkflowGraph {
  workflow: Workflow;
  nodes: Map<string, WorkflowNode>;
  byName: Map<string, WorkflowNode>;
  outgoing: Map<string, Connection[]>;
  incoming: Map<string, Connection[]>;
  startNodes: WorkflowNode[];
  sinkNodes: WorkflowNode[];
  topologicalOrder: string[];
  cycles: string[][];
}

export function buildGraph(workflow: Workflow): WorkflowGraph {
  const nodes = new Map<string, WorkflowNode>();
  const byName = new Map<string, WorkflowNode>();

  for (const node of workflow.nodes) {
    if (nodes.has(node.id)) {
      throw new WorkflowValidationError(`Duplicate node id "${node.id}"`, { nodeId: node.id });
    }
    if (isUnsafeObjectKey(node.id)) {
      throw new WorkflowValidationError(`Unsafe node id "${node.id}"`, { nodeId: node.id });
    }
    if (byName.has(node.name)) {
      throw new WorkflowValidationError(`Duplicate node name "${node.name}"`, { nodeId: node.id });
    }
    nodes.set(node.id, node);
    byName.set(node.name, node);
  }

  const outgoing = new Map<string, Connection[]>();
  const incoming = new Map<string, Connection[]>();

  for (const node of workflow.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }

  for (const connection of workflow.connections) {
    if (!nodes.has(connection.from.node)) {
      throw new WorkflowValidationError(
        `Connection "${connection.id}" starts at unknown node "${connection.from.node}"`,
        { connectionId: connection.id },
      );
    }
    if (!nodes.has(connection.to.node)) {
      throw new WorkflowValidationError(
        `Connection "${connection.id}" ends at unknown node "${connection.to.node}"`,
        { connectionId: connection.id },
      );
    }
    outgoing.get(connection.from.node)?.push(connection);
    incoming.get(connection.to.node)?.push(connection);
  }

  const startNodes = workflow.nodes.filter((node) => {
    const edges = incoming.get(node.id) ?? [];
    return !edges.some((edge) => edge.to.port === 'main' && edge.to.index === 0);
  });

  const sinkNodes = workflow.nodes.filter((node) => (outgoing.get(node.id) ?? []).length === 0);

  const { order, cycles } = topologicalSort(workflow, outgoing, incoming);

  return {
    workflow,
    nodes,
    byName,
    outgoing,
    incoming,
    startNodes,
    sinkNodes,
    topologicalOrder: order,
    cycles,
  };
}

function topologicalSort(
  workflow: Workflow,
  outgoing: Map<string, Connection[]>,
  incoming: Map<string, Connection[]>,
): { order: string[]; cycles: string[][] } {
  const indegree = new Map<string, number>();
  for (const node of workflow.nodes) {
    indegree.set(node.id, (incoming.get(node.id) ?? []).length);
  }

  const queue = workflow.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .sort(compareNodes);
  const order: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    order.push(node.id);

    for (const edge of outgoing.get(node.id) ?? []) {
      const next = indegree.get(edge.to.node);
      if (next === undefined) continue;
      const value = next - 1;
      indegree.set(edge.to.node, value);
      if (value === 0) {
        const target = workflow.nodes.find((entry) => entry.id === edge.to.node);
        if (target !== undefined) {
          queue.push(target);
          queue.sort(compareNodes);
        }
      }
    }
  }

  if (order.length === workflow.nodes.length) {
    return { order, cycles: [] };
  }

  return { order, cycles: findCycles(workflow, outgoing) };
}

function compareNodes(a: WorkflowNode, b: WorkflowNode): number {
  if (a.position.y !== b.position.y) return a.position.y - b.position.y;
  if (a.position.x !== b.position.x) return a.position.x - b.position.x;
  return a.id.localeCompare(b.id);
}

export function findCycles(
  workflow: Workflow,
  outgoing: Map<string, Connection[]> = buildAdjacency(workflow),
): string[][] {
  const color = new Map<string, 0 | 1 | 2>();
  for (const node of workflow.nodes) color.set(node.id, 0);

  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (nodeId: string): void => {
    color.set(nodeId, 1);
    stack.push(nodeId);

    for (const edge of outgoing.get(nodeId) ?? []) {
      const target = edge.to.node;
      const state = color.get(target) ?? 0;
      if (state === 0) {
        visit(target);
      } else if (state === 1) {
        const start = stack.indexOf(target);
        if (start >= 0) {
          const cycle = [...stack.slice(start), target];
          const key = [...cycle].sort().join('|');
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cycle);
          }
        }
      }
    }

    stack.pop();
    color.set(nodeId, 2);
  };

  for (const node of workflow.nodes) {
    if ((color.get(node.id) ?? 0) === 0) visit(node.id);
  }

  return cycles;
}

function buildAdjacency(workflow: Workflow): Map<string, Connection[]> {
  const outgoing = new Map<string, Connection[]>();
  for (const node of workflow.nodes) outgoing.set(node.id, []);
  for (const connection of workflow.connections) {
    outgoing.get(connection.from.node)?.push(connection);
  }
  return outgoing;
}

export function upstreamOf(
  graph: WorkflowGraph,
  nodeId: string,
  options: { includeSelf?: boolean } = {},
): Set<string> {
  const result = new Set<string>();
  const visit = (id: string): void => {
    for (const edge of graph.incoming.get(id) ?? []) {
      if (result.has(edge.from.node)) continue;
      result.add(edge.from.node);
      visit(edge.from.node);
    }
  };
  visit(nodeId);
  if (options.includeSelf === true) result.add(nodeId);
  return result;
}

export function downstreamOf(
  graph: WorkflowGraph,
  nodeId: string,
  options: { includeSelf?: boolean } = {},
): Set<string> {
  const result = new Set<string>();
  const visit = (id: string): void => {
    for (const edge of graph.outgoing.get(id) ?? []) {
      if (result.has(edge.to.node)) continue;
      result.add(edge.to.node);
      visit(edge.to.node);
    }
  };
  visit(nodeId);
  if (options.includeSelf === true) result.add(nodeId);
  return result;
}

export function getNode(graph: WorkflowGraph, nodeId: string): WorkflowNode | undefined {
  return graph.nodes.get(nodeId);
}

export function getNodeByName(graph: WorkflowGraph, name: string): WorkflowNode | undefined {
  return graph.byName.get(name);
}

export function hasPath(
  graph: WorkflowGraph,
  fromNodeId: string,
  toNodeId: string,
): boolean {
  if (fromNodeId === toNodeId) return true;
  const queue = [fromNodeId];
  const visited = new Set<string>([fromNodeId]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const edge of graph.outgoing.get(current) ?? []) {
      if (edge.to.node === toNodeId) return true;
      if (!visited.has(edge.to.node)) {
        visited.add(edge.to.node);
        queue.push(edge.to.node);
      }
    }
  }
  return false;
}
