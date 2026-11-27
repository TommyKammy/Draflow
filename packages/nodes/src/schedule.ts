import type { NodeType } from '@draflow/core';

export const scheduleNode: NodeType = {
  type: 'draflow.schedule',
  version: 1,
  meta: {
    label: 'Schedule',
    category: 'trigger',
    description: 'Starts at a fixed interval or local calendar time',
  },
  ports: { inputs: [], outputs: [{ type: 'main' }] },
  parameters: [
    {
      type: 'select',
      name: 'mode',
      label: 'Schedule',
      default: 'interval',
      noExpression: true,
      options: [
        { label: 'Interval', value: 'interval' },
        { label: 'Cron', value: 'cron' },
      ],
    },
    {
      type: 'number',
      name: 'intervalSeconds',
      label: 'Interval (seconds)',
      min: 1,
      default: 60,
      noExpression: true,
      displayOptions: { show: { mode: ['interval'] } },
    },
    {
      type: 'string',
      name: 'cron',
      label: 'Cron expression',
      placeholder: '30 9 * * 1',
      noExpression: true,
      displayOptions: { show: { mode: ['cron'] } },
    },
    {
      type: 'string',
      name: 'timezone',
      label: 'Time zone',
      placeholder: 'Asia/Tokyo',
      noExpression: true,
      displayOptions: { show: { mode: ['cron'] } },
    },
  ],
  execute: (ctx) => [...ctx.items],
};
