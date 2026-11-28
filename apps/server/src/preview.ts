import { buildGraph, compileTemplate, type NodeRegistry, type NodeType, type Workflow, type WorkflowNode } from '@draflow/core';
import { httpRequestNode, standardNodes } from '@draflow/nodes';
import { compensationSpec } from './compensation.js';
import { permitsCredentialDestination } from './http-auth.js';
import { scheduleFor } from './schedule.js';

export interface PublicationImpact {
  workflowId: string;
  revision: number | null;
  nodeId: string;
  nodeName: string;
  phase: 'execution' | 'compensation';
  kind: 'read' | 'write' | 'unknown' | 'undeclared' | 'blocked';
  mayRedirect?: true;
  method?: string | null;
  destination?: string | null;
  credentialRefs: string[];
}

// Recognize the installed implementation, not just its type string: hosts can replace a node.
const localTypes = new Set([
  'draflow.manualTrigger', 'draflow.webhook', 'draflow.schedule', 'draflow.childInput',
  'draflow.set', 'draflow.noOp', 'draflow.if', 'draflow.filter', 'draflow.splitOut',
  'draflow.aggregate', 'draflow.merge', 'draflow.wait', 'draflow.call', 'draflow.return',
]);
const localNodes = new Set(standardNodes.filter((node) => localTypes.has(node.type)));

const pages = standardNodes.find((node) => node.type === 'draflow.pages')!;
const dynamic = Symbol('expression');
function literal(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const template = compileTemplate(value);
  return template.hasExpressions ? dynamic : template.segments.map((segment) => segment.value).join('');
}

type Effect = Pick<PublicationImpact, 'kind' | 'method' | 'destination' | 'credentialRefs' | 'mayRedirect'>;

function httpEffect(node: WorkflowNode, page: boolean): Effect {
  const params = node.parameters;
  const ref = node.credentials?.httpAuth;
  const auth = page ? undefined : literal(params.authentication === undefined ? 'none' : params.authentication);
  const endpoint = page ? params.url : literal(params.url);
  const url = typeof endpoint === 'string' ? URL.parse(endpoint) : null;
  if (ref && endpoint !== dynamic && (!url || !permitsCredentialDestination(url)))
    return { kind: 'blocked', credentialRefs: [] };
  const blocked = page ? ref === '' :
    (auth !== dynamic && auth !== 'none' && auth !== 'credential') ||
    (auth === 'credential' && !ref) ||
    (ref !== undefined && (!ref || auth === 'none' || node.typeVersion !== 2));
  if (blocked) return { kind: 'blocked', credentialRefs: [] };
  const raw = page ? 'GET' : literal(params.method === undefined ? 'GET' : params.method);
  const method = typeof raw === 'string' && /^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(raw) ? raw.toUpperCase() : null;
  return {
    kind: method === null ? 'unknown' : ['GET', 'HEAD'].includes(method) ? 'read' : 'write',
    method, destination: url && ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : null,
    credentialRefs: ref ? [ref] : [],
    ...(!page && !ref && { mayRedirect: true }),
  };
}

function* impacts(node: WorkflowNode, installed: NodeType): Generator<Effect> {
  if (localNodes.has(installed)) return;
  if (node.type === 'draflow.pages' && installed.wait === pages.wait) {
    yield httpEffect(node, true);
    if (installed.execute === pages.execute) return;
  }
  if (node.type === 'draflow.httpRequest' && installed.execute === httpRequestNode.execute && !installed.wait) {
    yield httpEffect(node, false);
    return;
  }
  const declared = installed.meta.externalEffect;
  if (declared !== 'none') yield {
    kind: declared === 'read' || declared === 'write' ? declared : 'undeclared',
    destination: null, credentialRefs: Object.values(node.credentials ?? {}),
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
          const installed = registry.require(node.type, node.typeVersion);
          if (installed.version !== node.typeVersion) throw Error('Pinned node version unavailable');
          let blocked = false;
          for (const entry of node.disabled ? [] : impacts(node, installed)) {
            blocked ||= entry.kind === 'blocked';
            const effect = { workflowId: flow.id, revision, nodeId: id, nodeName: node.name, phase, ...entry };
            effectBytes += Buffer.byteLength(JSON.stringify(effect));
            if (effectBytes > 1024 * 1024) throw Error('Publication preview exceeds the output limit');
            effects.push(effect);
          }
          for (const edge of graph.outgoing.get(id) ?? []) {
            if (edge.from.port !== 'main' && edge.from.port !== 'error') continue;
            // Multi-input nodes can synchronize even on empty outputs.
            const target = graph.nodes.get(edge.to.node)!;
            const primary = edge.from.port === 'main' && edge.from.index === 0;
            let canRoute = !node.disabled || primary;
            if (blocked) {
              const onError = node.settings?.onError;
              canRoute = primary && (onError === 'continue' || node.settings?.alwaysOutputData === true) ||
                edge.from.port === 'error' && edge.from.index === 0 && onError === 'errorOutput';
            }
            if (canRoute || registry.require(target.type, target.typeVersion).ports.inputs.length > 1)
              pending.push(target.id);
          }
          if (node.disabled || blocked) continue;
          const undo = !installed.wait && installed.journalMode && compensationSpec(node);
          if (undo) child(undo.workflowId, undo.revision, 'compensation');
          if (installed.wait && (node.type === 'draflow.call' || node.type === 'draflow.pages'))
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

type Preview = ReturnType<typeof previewWorkflow>;
type Trigger = Preview['triggers'][number];

function effectKey(e: PublicationImpact) {
  return JSON.stringify([e.workflowId, e.revision, e.nodeId, e.phase, e.kind, e.method,
    e.destination, e.mayRedirect, [...e.credentialRefs].sort()]);
}

function triggerCondition(trigger: Trigger | undefined) {
  if (!trigger) return null;
  const { nodeId, nodeName, type, path, schedule } = trigger;
  return { nodeId, nodeName, type, path, schedule };
}

export function comparePreviews(active: Preview | null, draft: Preview) {
  const before = new Map(active?.triggers.map((t) => [t.nodeId, t]));
  const after = new Map(draft.triggers.map((t) => [t.nodeId, t]));
  const changes = [];
  for (const id of new Set([...after.keys(), ...before.keys()])) {
    const previous = before.get(id), next = after.get(id);
    const previousEffects = new Map(previous?.effects.map((e) => [effectKey(e), e]));
    const nextEffects = new Map(next?.effects.map((e) => [effectKey(e), e]));
    const added = [...nextEffects].filter(([key]) => !previousEffects.has(key)).map(([, effect]) => effect);
    const removed = [...previousEffects].filter(([key]) => !nextEffects.has(key)).map(([, effect]) => effect);
    const conditionChanged = !previous || !next || previous.type !== next.type || previous.path !== next.path ||
      JSON.stringify(previous.schedule) !== JSON.stringify(next.schedule);
    if (conditionChanged || added.length || removed.length)
      changes.push({ before: triggerCondition(previous), after: triggerCondition(next), conditionChanged, added, removed });
  }
  return changes;
}
