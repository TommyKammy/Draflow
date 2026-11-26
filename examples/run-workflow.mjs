/**
 * Runs a small workflow with the built packages.
 *
 *   pnpm build
 *   node examples/run-workflow.mjs
 */
import {
  ExecutionEngine,
  NodeRegistry,
  createConnection,
  createNode,
  createWorkflow,
} from '../packages/core/dist/index.js';
import { standardNodes } from '../packages/nodes/dist/index.js';

const registry = new NodeRegistry().registerAll(standardNodes);
const engine = new ExecutionEngine({ registry });

const manual = createNode({
  id: 'manual',
  type: 'draflow.manualTrigger',
  name: 'Manual',
  position: { x: 0, y: 0 },
});

const set = createNode({
  id: 'set',
  type: 'draflow.set',
  name: 'Set',
  position: { x: 220, y: 0 },
  parameters: {
    mode: 'manual',
    includeOtherFields: false,
    assignments: [
      { name: 'greeting', value: '=Hello {{ $json.name }}' },
      { name: 'length', value: '={{ $json.name.length }}' },
    ],
  },
});

const branch = createNode({
  id: 'branch',
  type: 'draflow.if',
  name: 'If',
  position: { x: 440, y: 0 },
  parameters: {
    conditions: {
      combinator: 'and',
      conditions: [{ left: '={{ $json.length }}', operator: 'gte', right: '3' }],
    },
  },
});

const yes = createNode({
  id: 'yes',
  type: 'draflow.set',
  name: 'Long',
  position: { x: 660, y: -80 },
  parameters: {
    mode: 'manual',
    includeOtherFields: true,
    assignments: [{ name: 'result', value: 'long enough' }],
  },
});

const workflow = createWorkflow({
  name: 'Example',
  nodes: [manual, set, branch, yes],
  connections: [
    createConnection(
      { node: 'manual', port: 'main', index: 0 },
      { node: 'set', port: 'main', index: 0 },
    ),
    createConnection(
      { node: 'set', port: 'main', index: 0 },
      { node: 'branch', port: 'main', index: 0 },
    ),
    createConnection(
      { node: 'branch', port: 'main', index: 0 },
      { node: 'yes', port: 'main', index: 0 },
    ),
  ],
});

const result = await engine
  .run(workflow, {
    triggerData: { main: [[{ json: { name: 'Draflow' } }]] },
  })
  .done;

console.log(`status: ${result.status}`);
console.log(`duration: ${result.stoppedAt - result.startedAt}ms`);
for (const [nodeId, tasks] of Object.entries(result.runData)) {
  const task = tasks[0];
  if (task === undefined) continue;
  const items = task.output?.main?.[0] ?? [];
  console.log(`${nodeId}: ${task.status} (${task.executionTime}ms, ${items.length} items)`);
}
console.log('output:', JSON.stringify(result.runData.yes?.[0]?.output?.main?.[0] ?? [], null, 2));

if (result.status === 'error') {
  console.error(result.error);
  process.exitCode = 1;
}
