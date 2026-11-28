import { buildGraph, type NodeRegistry, type NodeType, type Workflow, type WorkflowNode } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { compensationSpec } from './compensation.js';
import { scheduleFor } from './schedule.js';

export interface PublicationImpact {
  workflowId: string;
  revision: number | null;
  nodeId: string;
  nodeName: string;
  phase: 'execution' | 'compensation';
  kind: 'read' | 'write' | 'unknown' | 'undeclared';
  method?: string | null;
  destination?: string | null;
  credentialRefs: string[];
}

// Expose the HTTP origin and path. Never echo expression source, userinfo, query or fragment.
function destination(value: unknown): string | null {
  if (typeof value !== 'string' || value.startsWith('=')) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : null;
  } catch {
    return null;
  }
}

// Recognize the installed implementation, not just its type string: hosts can replace a node.
const localTypes = new Set([
  'draflow.manualTrigger', 'draflow.webhook', 'draflow.schedule', 'draflow.childInput',
  'draflow.set', 'draflow.noOp', 'draflow.if', 'draflow.filter', 'draflow.splitOut',
  'draflow.aggregate', 'draflow.merge', 'draflow.wait', 'draflow.call', 'draflow.return',
]);
const localNodes = new Set(standardNodes.filter((node) => localTypes.has(node.type)));

function impact(node: WorkflowNode, installed: NodeType): Pick<PublicationImpact, 'kind' | 'method' | 'destination' | 'credentialRefs'> | undefined {
  if (localNodes.has(installed)) return;
  if (!standardNodes.includes(installed) || !['draflow.httpRequest', 'draflow.pages'].includes(node.type)) {
    const declared = installed.meta.externalEffect;
    if (declared === 'none') return;
    const kind = declared === 'read' || declared === 'write' ? declared : 'undeclared';
    return { kind, destination: null, credentialRefs: Object.values(node.credentials ?? {}) };
  }
  const raw = node.type === 'draflow.pages' ? 'GET' : node.parameters.method ?? 'GET';
  const method = typeof raw === 'string' && /^[a-z]+$/i.test(raw) ? raw.toUpperCase() : null;
  return {
    kind: method === null ? 'unknown' : ['GET', 'HEAD'].includes(method) ? 'read' : 'write',
    method, destination: destination(node.parameters.url),
    credentialRefs: node.credentials?.httpAuth ? [node.credentials.httpAuth] : [],
  };
}

export function webhookPath(node: WorkflowNode) {
  const path = node.parameters.path;
  if (typeof path !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(path)) throw Error('Invalid Webhook path');
  return '/webhook/' + path;
}

export function previewWorkflow(root: Workflow, registry: NodeRegistry, load: (id: string, revision: number) => Workflow) {
  const graphs = new Map<Workflow, ReturnType<typeof buildGraph>>();
  const children = new Map<string, Workflow>();
  let visits = 0;
  let effectBytes = 0;
  const triggers = root.nodes.filter((n) => !n.disabled && registry.require(n.type, n.typeVersion).meta.category === 'trigger');
  return {
    workflowId: root.id,
    workflowName: root.name,
    triggers: triggers.map((trigger) => {
      const effects: PublicationImpact[] = [];
      const seen = new Set<string>();
      function walk(flow: Workflow, revision: number | null, start: string, phase: PublicationImpact['phase']) {
        const graph = graphs.get(flow) ?? buildGraph(flow);
        graphs.set(flow, graph);
        const pending = [start];
        while (pending.length) {
          const id = pending.pop()!;
          const key = JSON.stringify([flow.id, revision, id, phase]);
          if (seen.has(key)) continue;
          seen.add(key);
          if (++visits > 50000) throw Error('Publication preview exceeds the traversal limit');
          const node = graph.nodes.get(id)!;
          for (const edge of graph.outgoing.get(id) ?? []) {
            if (edge.from.port !== 'main' && edge.from.port !== 'error') continue;
            // Multi-input nodes can synchronize even on empty outputs.
            const target = graph.nodes.get(edge.to.node)!;
            if (!node.disabled || (edge.from.port === 'main' && edge.from.index === 0) ||
                registry.require(target.type, target.typeVersion).ports.inputs.length > 1) pending.push(target.id);
          }
          if (node.disabled) continue;
          const installed = registry.require(node.type, node.typeVersion);
          if (installed.version !== node.typeVersion) throw Error('Pinned node version unavailable');
          const entry = impact(node, installed);
          if (entry) {
            const effect = { workflowId: flow.id, revision, nodeId: id, nodeName: node.name, phase, ...entry };
            effectBytes += Buffer.byteLength(JSON.stringify(effect));
            if (effectBytes > 1024 * 1024) throw Error('Publication preview exceeds the output limit');
            effects.push(effect);
          }
          const undo = compensationSpec(node);
          if (undo) child(undo.workflowId, undo.revision, 'compensation');
          if (node.type === 'draflow.call' || node.type === 'draflow.pages')
            child(String(node.parameters.workflowId), Number(node.parameters.revision), phase);
        }
      }
      function child(id: string, revision: number, phase: PublicationImpact['phase']) {
        const key = JSON.stringify([id, revision]);
        const flow = children.get(key) ?? load(id, revision);
        children.set(key, flow);
        const entry = flow.nodes.find((n) => n.type === 'draflow.childInput' && !n.disabled);
        if (!entry) throw Error('Missing child input');
        walk(flow, revision, entry.id, phase);
      }
      walk(root, null, trigger.id, 'execution');
      return {
        nodeId: trigger.id, nodeName: trigger.name, type: trigger.type,
        ...(trigger.type === 'draflow.webhook' && { path: webhookPath(trigger) }),
        ...(trigger.type === 'draflow.schedule' && { schedule: scheduleFor(trigger) }),
        effects,
      };
    }),
  };
}
