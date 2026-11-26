import type { NodeType } from '@draflow/core';

export const manualTriggerNode: NodeType = {
  type: 'draflow.manualTrigger',
  version: 1,
  meta: {
    label: 'Manual Trigger',
    category: 'trigger',
    description: 'Runs the workflow when you click Execute',
    icon: 'play',
  },
  ports: {
    inputs: [],
    outputs: [{ type: 'main' }],
  },
  parameters: [],
  execute(ctx) {
    return ctx.items.length > 0 ? [...ctx.items] : [{ json: {} }];
  },
};
