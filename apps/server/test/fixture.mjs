import { appendFileSync } from 'node:fs';
import { NodeRegistry } from '@draflow/core';
import { NodeHost } from '../dist/host.js';

export function registry(effect = () => {}) {
  const trigger = {
    type: 'event',
    version: 1,
    meta: { category: 'trigger', label: 'Event' },
    ports: { inputs: [], outputs: [{ type: 'main' }] },
    parameters: [],
  };
  return new NodeRegistry().registerAll([
    trigger,
    {
      ...trigger,
      type: 'write',
      meta: { category: 'core', label: 'Write' },
      ports: { inputs: [{ type: 'main' }], outputs: [{ type: 'main' }] },
      async execute(ctx) {
        const value = ctx.param('label');
        await effect(ctx.execution.id, value);
        return [{ json: { value, input: ctx.items[0].json } }];
      },
    },
  ]);
}

export function workflow(label = 'first') {
  const node = (id, type) => ({
    id,
    name: id,
    type,
    typeVersion: 1,
    parameters: { label },
    position: { x: 0, y: 0 },
  });
  return {
    schema: 'draflow/v1',
    id: 'flow',
    name: 'Flow',
    settings: {},
    nodes: [node('a', 'event'), node('b', 'event'), node('sink', 'write')],
    connections: ['a', 'b'].map((id) => ({
      id,
      from: { node: id, port: 'main', index: 0 },
      to: { node: 'sink', port: 'main', index: 0 },
    })),
  };
}

export const event = { items: [{ json: { order: 42 } }], key: 'delivery' };
export async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('Worker did not reach expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function crash(path, phase) {
  function kill() {
    process.kill(process.pid, 'SIGKILL');
  }
  const host = new NodeHost(path, {
    registry: registry((id, value) => {
      appendFileSync(path + '.effects', JSON.stringify({ id, value }) + '\n');
      if (phase === 'running') kill();
    }),
  });
  host.activate('flow', host.publish(workflow()));
  if (phase === 'before') kill();
  const id = host.accept('flow', 'a', event);
  if (phase === 'queued') kill();
  await until(() => host.receipt(id).state === 'finished');
  kill();
}
