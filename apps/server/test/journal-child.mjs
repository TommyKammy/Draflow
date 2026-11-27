import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { SqliteLedger } from '../dist/sqlite.js';
import { until } from './fixture.mjs';

export function receiver(path, afterSend = () => {}) {
  return async (_url, init) => {
    const key = new Headers(init.headers).get('idempotency-key');
    const item = JSON.parse(init.body).item;
    appendFileSync(path + '.attempts', JSON.stringify({ item, key }) + '\n');
    const applied = existsSync(path + '.applied')
      ? readFileSync(path + '.applied', 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse)
      : [];
    if (!key || !applied.some((op) => op.key === key))
      appendFileSync(path + '.applied', JSON.stringify({ item, key }) + '\n');
    afterSend(item);
    return Response.json({ item });
  };
}

export async function crashJournal(path, mode, boundary) {
  const kill = () => process.kill(process.pid, 'SIGKILL');
  if (boundary === 'task-complete') {
    const end = SqliteLedger.prototype.endJournal;
    SqliteLedger.prototype.endJournal = function (...args) {
      end.apply(this, args);
      kill();
    };
  }
  const begin = SqliteLedger.prototype.beginJournal;
  SqliteLedger.prototype.beginJournal = function (...args) {
    const record = begin.apply(this, args);
    return async (index, request, send) => {
      if (index === 1 && boundary === 'before') kill();
      const result = await record(index, request, send);
      if (index === 1 && boundary === 'saved') kill();
      return result;
    };
  };
  const host = new NodeHost(path, {
    registry: new NodeRegistry().registerAll(standardNodes),
    fetch: receiver(path, (item) => {
      if (item === 2 && boundary === 'sent') kill();
      if (item === 4 && boundary === 'untracked') kill();
    }),
  });
  const doc = {
    schema: 'draflow/v1',
    id: 'send',
    name: 'Send',
    settings: {},
    nodes: [
      {
        id: 'start',
        name: 'Start',
        type: 'draflow.manualTrigger',
        typeVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      },
      {
        id: 'post',
        name: 'Post',
        type: 'draflow.httpRequest',
        typeVersion: 2,
        position: { x: 100, y: 0 },
        parameters: { delivery: mode, method: 'POST', url: 'https://example.test', body: '={{ $json }}' },
      },
    ],
    connections: [
      {
        id: 'edge',
        from: { node: 'start', port: 'main', index: 0 },
        to: { node: 'post', port: 'main', index: 0 },
      },
    ],
  };
  if (boundary === 'untracked') {
    const tail = structuredClone(doc.nodes[1]);
    tail.id = tail.name = 'untracked';
    delete tail.parameters.delivery;
    tail.parameters.body = { item: 4 };
    doc.nodes.push(tail);
    doc.connections.push({
      id: 'tail',
      from: { node: 'post', port: 'main', index: 0 },
      to: { node: 'untracked', port: 'main', index: 0 },
    });
  }
  host.activate('send', host.publish(doc));
  const id = host.accept('send', 'start', {
    key: 'send',
    items: [1, 2, 3].map((item) => ({ json: { item } })),
  });
  await until(() => host.receipt(id).state === 'finished');
}
