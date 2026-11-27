import type { NodeType } from '@draflow/core';
import { waitNode } from './wait.js';
import { aggregateNode } from './aggregate.js';
import { splitOutNode } from './split-out.js';
import { scheduleNode } from './schedule.js';
import { webhookNode } from './webhook.js';
import { filterNode } from './filter.js';
import { httpRequestNode, httpRequestNodeV2 } from './http.js';
import { ifNode } from './if.js';
import { manualTriggerNode } from './manual.js';
import { mergeNode } from './merge.js';
import { noOpNode } from './noop.js';
import { setNode } from './set.js';

export { aggregateNode } from './aggregate.js';
export { splitOutNode } from './split-out.js';
export { scheduleNode } from './schedule.js';
export { webhookNode } from './webhook.js';
export { filterNode } from './filter.js';
export { httpRequestNode, httpRequestNodeV2 } from './http.js';
export { ifNode } from './if.js';
export { manualTriggerNode } from './manual.js';
export { mergeNode } from './merge.js';
export { noOpNode } from './noop.js';
export { setNode } from './set.js';
export * from './helpers.js';

export { waitNode } from './wait.js';

export const standardNodes: NodeType[] = [
  waitNode,
  manualTriggerNode,
  webhookNode,
  scheduleNode,
  noOpNode,
  setNode,
  ifNode,
  filterNode,
  aggregateNode,
  splitOutNode,
  mergeNode,
  httpRequestNode,
  httpRequestNodeV2,
];
