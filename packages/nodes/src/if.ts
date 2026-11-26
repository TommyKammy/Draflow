import type { FilterValue, Item, NodeType } from '@draflow/core';
import { evaluateFilter, pairing } from './helpers.js';

export const ifNode: NodeType = {
  type: 'draflow.if',
  version: 1,
  meta: {
    label: 'If',
    category: 'flow',
    description: 'Route items into a true branch or a false branch',
    icon: 'git-branch',
  },
  ports: {
    inputs: [{ type: 'main', required: true }],
    outputs: [
      { type: 'main', label: 'True' },
      { type: 'main', label: 'False' },
    ],
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
      description: 'Convert values where required before comparing',
    },
  ],
  async execute(ctx) {
    const passed: Item[] = [];
    const failed: Item[] = [];

    await ctx.each((input, itemCtx, index) => {
      const filter = itemCtx.param<FilterValue>('conditions', {
        combinator: 'and',
        conditions: [],
      });
      const loose = itemCtx.param<boolean>('looseTypeValidation', false);
      const match = evaluateFilter(filter, loose);
      const target = match ? passed : failed;
      target.push({ ...input, pairedItem: pairing(input, index) });
    });

    return { main: [passed, failed] };
  },
};
