import type { FilterValue, Item, NodeType } from '@draflow/core';
import { evaluateFilter, pairing } from './helpers.js';

export const filterNode: NodeType = {
  type: 'draflow.filter',
  version: 1,
  meta: {
    label: 'Filter',
    category: 'transform',
    description: 'Keep only items that match the conditions',
    icon: 'filter',
  },
  ports: {
    inputs: [{ type: 'main', required: true }],
    outputs: [{ type: 'main' }],
  },
  parameters: [
    {
      name: 'conditions',
      label: 'Conditions',
      type: 'filter',
      default: { combinator: 'and', conditions: [] },
      maxConditions: 20,
      allowedCombinators: ['and', 'or'],
    },
    {
      name: 'looseTypeValidation',
      label: 'Loose Type Validation',
      type: 'boolean',
      default: false,
    },
  ],
  async execute(ctx) {
    const output: Item[] = [];

    await ctx.each((input, itemCtx, index) => {
      const filter = itemCtx.param<FilterValue>('conditions', {
        combinator: 'and',
        conditions: [],
      });
      const loose = itemCtx.param<boolean>('looseTypeValidation', false);
      if (evaluateFilter(filter, loose)) {
        output.push({ ...input, pairedItem: pairing(input, index) });
      }
    });

    return output;
  },
};
