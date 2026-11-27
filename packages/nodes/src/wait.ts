import type { NodeType } from '@draflow/core';
import { pairing } from './helpers.js';

export const waitNode: NodeType = {
  type: 'draflow.wait',
  version: 1,
  meta: { label: 'Wait', category: 'flow', description: 'Resume at a time or on an authorized host event' },
  ports: { inputs: [{ type: 'main', required: true }], outputs: [{ type: 'main' }] },
  parameters: [
    {
      name: 'mode',
      label: 'Resume on',
      type: 'select',
      default: 'event',
      options: [
        { label: 'External event', value: 'event' },
        { label: 'Time', value: 'time' },
      ],
    },
    {
      name: 'dueAt',
      label: 'Wake-up or event deadline (ISO with timezone or epoch milliseconds)',
      type: 'string',
      required: true,
    },
  ],
  wait(ctx) {
    const mode = ctx.param('mode');
    const date = ctx.param('dueAt');
    let dueAt = NaN;
    if (typeof date === 'number') dueAt = date;
    else if (typeof date === 'string') {
      if (/^-?\d+$/.test(date)) dueAt = Number(date);
      else if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(date)) dueAt = Date.parse(date);
    }
    if ((mode !== 'event' && mode !== 'time') || !Number.isSafeInteger(dueAt))
      throw new Error('Expected a wait mode and an absolute deadline');
    return { mode, dueAt };
  },
  execute(ctx) {
    const response = ctx.resume;
    if (!response) throw new Error('Missing wait response');
    return ctx.items.map((item, index) => ({
      ...item,
      json: { ...item.json, wait: { reason: response.reason, data: response.data } },
      pairedItem: pairing(item, index),
    }));
  },
};
