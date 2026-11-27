import type { NodeType } from '@draflow/core';

export const webhookNode: NodeType = {
  type: 'draflow.webhook',
  version: 1,
  meta: { label: 'Webhook', category: 'trigger', description: 'Starts on a verified JSON delivery' },
  ports: { inputs: [], outputs: [{ type: 'main' }] },
  parameters: [{ type: 'string', name: 'path', label: 'Webhook path', required: true, noExpression: true }],
  execute: (ctx) => [...ctx.items],
};
