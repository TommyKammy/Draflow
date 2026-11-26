import type { NodeType } from '@draflow/core';

export const noOpNode: NodeType = {
  type: 'draflow.noOp',
  version: 1,
  meta: {
    label: 'No Operation',
    category: 'core',
    description: 'Passes items through unchanged',
    icon: 'minus',
  },
  ports: {
    inputs: [{ type: 'main', required: true }],
    outputs: [{ type: 'main' }],
  },
  parameters: [],
  execute(ctx) {
    return [...ctx.items];
  },
};
