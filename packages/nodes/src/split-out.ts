import { isUnsafeObjectKey, type Item, type NodeType } from '@draflow/core';
import { pairing } from './helpers.js';

export const splitOutNode: NodeType = {
  type: 'draflow.splitOut',
  version: 1,
  meta: {
    label: 'Split Out',
    category: 'transform',
    description: 'Emit an item per array element, retaining the surrounding fields',
  },
  ports: { inputs: [{ type: 'main', required: true }], outputs: [{ type: 'main' }] },
  parameters: [
    { name: 'field', label: 'Top-level array field', type: 'string', default: 'data', required: true },
  ],
  async execute(ctx) {
    const output: Item[] = [];
    await ctx.each((input, itemCtx, index) => {
      const field = itemCtx.param<string>('field', 'data');
      const values = input.json[field];
      if (isUnsafeObjectKey(field) || !Object.hasOwn(input.json, field) || !Array.isArray(values)) {
        throw new Error('Split Out requires a top-level array field');
      }
      for (const value of values) {
        output.push({ ...input, json: { ...input.json, [field]: value }, pairedItem: pairing(input, index) });
      }
    });
    return output;
  },
};
