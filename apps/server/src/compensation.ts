import { isPlainObject, type Workflow, type WorkflowNode } from '@draflow/core';

export interface CompensationSpec {
  workflowId: string;
  revision: number;
  order: number;
  onFailure?: boolean;
  when?: { field: string; equals: string | number | boolean | null };
}

export function compensationSpec(node: WorkflowNode): CompensationSpec | undefined {
  const spec = node.parameters.compensation;
  if (node.type !== 'draflow.httpRequest' || node.typeVersion !== 2 || spec === undefined || spec === null)
    return;
  if (
    !isPlainObject(spec) ||
    !['keyed', 'manual'].includes(String(node.parameters.delivery)) ||
    typeof spec.workflowId !== 'string' ||
    !spec.workflowId ||
    !Number.isSafeInteger(spec.revision) ||
    Number(spec.revision) < 1 ||
    !Number.isSafeInteger(spec.order) ||
    (spec.onFailure !== undefined && typeof spec.onFailure !== 'boolean') ||
    (spec.when !== undefined &&
      (!isPlainObject(spec.when) ||
        typeof spec.when.field !== 'string' ||
        !(spec.when.equals === null || ['boolean', 'string', 'number'].includes(typeof spec.when.equals))))
  )
    throw new Error('Invalid recorded compensation specification');
  return spec as unknown as CompensationSpec;
}

export function validateCompensations(root: Workflow, publication: (id: string, rev: number) => Workflow) {
  const configured = root.nodes.filter((n) => !n.disabled && compensationSpec(n));
  if (!configured.length) return;
  // The initial contract covers a single, ordered chain on the primary output.
  const chain = new Set<string>();
  let current = root.nodes.find((n) => !root.connections.some((c) => c.to.node === n.id));
  while (current && !chain.has(current.id)) {
    chain.add(current.id);
    const edges = root.connections.filter((c) => c.from.node === current!.id);
    if (edges.length > 1) break;
    current = root.nodes.find((n) => n.id === edges[0]?.to.node);
  }
  if (
    chain.size !== root.nodes.length ||
    root.connections.length !== root.nodes.length - 1 ||
    root.connections.some(
      (c) => c.from.port !== 'main' || c.from.index !== 0 || c.to.port !== 'main' || c.to.index !== 0,
    ) ||
    Object.keys(root.pinData ?? {}).length ||
    root.nodes.some((n) => n.disabled || (n.settings?.onError && n.settings.onError !== 'stop'))
  )
    throw new Error('Compensation requires a linear stop-on-error workflow');
  const orders = new Set<number>();
  for (const n of configured) {
    const spec = compensationSpec(n)!;
    const child = publication(spec.workflowId, spec.revision);
    const entry = child.nodes.find((n) => n.type === 'draflow.childInput');
    const write = child.nodes.find((n) => n.type === 'draflow.httpRequest' && n.typeVersion === 2);
    const ret = child.nodes.find((n) => n.type === 'draflow.return');
    const edge = (a: string, b: string) =>
      child.connections.some(
        (c) =>
          c.from.node === a &&
          c.to.node === b &&
          c.from.port === 'main' &&
          c.to.port === 'main' &&
          c.from.index === 0 &&
          c.to.index === 0,
      );
    if (
      orders.has(spec.order) ||
      child.id === root.id ||
      !entry ||
      !ret ||
      !write ||
      child.nodes.length !== 3 ||
      child.connections.length !== 2 ||
      !edge(entry.id, write.id) ||
      !edge(write.id, ret.id) ||
      !Array.isArray(entry.parameters.callers) ||
      !entry.parameters.callers.includes(root.id) ||
      !['manual', 'keyed'].includes(String(write.parameters.delivery)) ||
      Object.keys(child.pinData ?? {}).length ||
      child.nodes.some(
        (n) =>
          n.disabled ||
          compensationSpec(n) ||
          n.parameters.allowRedrive ||
          (n.settings?.onError && n.settings.onError !== 'stop'),
      )
    )
      throw new Error(
        'Compensation requires unique order and an authorized, pinned direct recorded HTTP child',
      );
    orders.add(spec.order);
  }
}
