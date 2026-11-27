import type { NodeType, NodeContext, ParamSchema } from '@draflow/core';
import { noOpNode } from './noop.js';

export const targetParameters: ParamSchema[] = [
  { name: 'workflowId', label: 'Child workflow ID', type: 'string', required: true, noExpression: true },
  {
    name: 'revision',
    label: 'Published revision',
    type: 'number',
    min: 1,
    required: true,
    noExpression: true,
  },
];

export function resultItems(ctx: NodeContext) {
  if (ctx.resume?.reason !== 'result') throw new Error('Missing host result');
  if (ctx.resume.failure) throw new Error(ctx.resume.failure);
  return ctx.resume.items ?? [];
}

export const childInputNode: NodeType = {
  ...noOpNode,
  type: 'draflow.childInput',
  meta: { label: 'Subworkflow input', category: 'trigger' },
  ports: { inputs: [], outputs: [{ type: 'main' }] },
  parameters: [
    { name: 'callers', label: 'Allowed parent workflow IDs', type: 'json', default: [], noExpression: true },
  ],
};

export const callNode: NodeType = {
  ...noOpNode,
  type: 'draflow.call',
  meta: { label: 'Call published workflow', category: 'flow' },
  parameters: targetParameters,
  wait: () => ({ mode: 'child' }),
  execute: resultItems,
};

export const returnNode: NodeType = {
  ...noOpNode,
  type: 'draflow.return',
  meta: { label: 'Return items', category: 'flow' },
  ports: { inputs: [{ type: 'main', required: true }], outputs: [{ type: 'main' }] },
  wait: (ctx) => ({ mode: 'return', pairing: ctx.items.map((_, i) => ctx.callablePairing?.(i) ?? []) }),
};

export const pagesNode: NodeType = {
  ...callNode,
  type: 'draflow.pages',
  meta: { label: 'Page through API in batches', category: 'flow' },
  credentials: [{ name: 'httpAuth', label: 'Read credential' }],
  parameters: [
    ...targetParameters,
    { name: 'url', label: 'GET endpoint', type: 'string', required: true, noExpression: true },
    {
      name: 'allowRedrive',
      label: 'Retain failed page for redrive',
      type: 'boolean',
      default: false,
      noExpression: true,
    },
    {
      name: 'redriveRetentionMs',
      label: 'Redrive retention (ms)',
      type: 'number',
      min: 1,
      noExpression: true,
    },
    { name: 'syncScope', label: 'Incremental sync scope', type: 'string', default: '', noExpression: true },
    {
      name: 'keyLifetimeMs',
      label: 'Receiver key lifetime (ms)',
      type: 'number',
      min: 1,
      noExpression: true,
    },
    { name: 'concurrency', label: 'Concurrent batches', type: 'number', min: 1, max: 32, default: 1, noExpression: true },
    { name: 'orderKey', label: 'Ordered entity field', type: 'string', default: 'id', noExpression: true },
    { name: 'pageSize', label: 'Page size', type: 'number', default: 100, min: 1, noExpression: true },
    { name: 'batchSize', label: 'Batch size', type: 'number', default: 25, min: 1, noExpression: true },
    { name: 'sumField', label: 'Numeric field to total', type: 'string', default: '', noExpression: true },
    ...[
      ['maxPages', 10000],
      ['maxItems', 1000000],
      ['maxBytes', 268435456],
      ['maxAttempts', 5],
      ['deadlineMs', 86400000],
    ].map(([name, value]) => ({
      name: String(name),
      label: String(name),
      type: 'number' as const,
      default: Number(value),
      min: 1,
      noExpression: true,
    })),
  ],
  wait: () => ({ mode: 'pages' }),
};
