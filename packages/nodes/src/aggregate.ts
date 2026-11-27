import type { JsonObject, NodeType } from '@draflow/core';
import { getPath, pairing } from './helpers.js';

export const aggregateNode: NodeType = {
  type: 'draflow.aggregate',
  version: 1,
  meta: {
    label: 'Aggregate',
    category: 'transform',
    description: 'Collect input rows into items with a count and optional numeric total',
  },
  ports: { inputs: [{ type: 'main', required: true }], outputs: [{ type: 'main' }] },
  parameters: [
    { name: 'sumField', label: 'Numeric field to sum (optional)', type: 'string', default: '', noExpression: true },
  ],
  async execute(ctx) {
    const inputs = ctx.input('main', 0);
    if (inputs.length === 0) return [];
    const json: JsonObject = { items: inputs.map((input) => input.json), count: inputs.length };
    const path = ctx.param<string>('sumField', 0, '');
    if (path !== '') {
      let total = 0;
      for (const input of inputs) {
        const value = getPath(input.json, path);
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error('Aggregate requires a finite number in each row for the sum field');
        }
        total += value;
      }
      if (!Number.isFinite(total)) throw new Error('Aggregate total exceeds the numeric range');
      json.total = total;
    }
    return [{ json, pairedItem: inputs.map((input, index) => pairing(input, index)) }];
  },
};
