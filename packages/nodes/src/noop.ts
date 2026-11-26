import type { NodeType } from '@draflow/core';
import { pairing } from './helpers.js';

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
    return ctx.items.map((item, index) => ({ ...item, pairedItem: pairing(item, index) }));
  },
};
