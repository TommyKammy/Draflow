import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeRegistry, serializeWorkflow } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { loadHttpAuth } from '../dist/http-config.js';
import { until } from './fixture.mjs';

const dummy = 'test-only-r3-S4mple';
async function mockApi(t) {
  const seen = [];
  const api = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/unexpected' }).end();
      return;
    }
    if (req.url === '/deny') {
      res.writeHead(401, dummy).end(dummy);
      return;
    }
    if (req.url === '/echo') {
      res.end(dummy);
      return;
    }
    if (req.url === '/escaped') {
      res.end('{"value":"\\u0074' + dummy.slice(1) + '"}');
      return;
    }
    if (req.url === '/large') {
      res.write('a'.repeat(16));
      res.end('é');
      return;
    }
    if (req.headers['x-service-key'] !== dummy && req.headers.authorization !== 'Bearer ' + dummy) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-ignored': dummy }).end('{"orders":3}');
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        api.close(resolve);
        api.closeAllConnections();
      }),
  );
  return { origin: 'http://127.0.0.1:' + api.address().port, seen };
}

function document(url, id = 'service') {
  const node = (id, type) => ({
    id,
    name: id,
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
  });
  return {
    schema: 'draflow/v1',
    id: 'orders',
    name: 'Orders',
    settings: {},
    nodes: [
      node('start', 'draflow.manualTrigger'),
      {
        ...node('api', 'draflow.httpRequest'),
        typeVersion: 2,
        credentials: { httpAuth: id },
        parameters: { url, authentication: 'credential' },
      },
    ],
    connections: [
      {
        id: 'edge',
        from: { node: 'start', port: 'main', index: 0 },
        to: { node: 'api', port: 'main', index: 0 },
      },
    ],
  };
}

function hostFixture(t, origin, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-auth-'));
  const db = join(dir, 'host.db');
  const log = [];
  const capture = (...args) => log.push(args);
  const grant = { id: 'service', workflowId: 'orders', nodeId: 'api', origin, kind: 'bearer' };
  const options = {
    registry: new NodeRegistry().registerAll(standardNodes),
    logger: { debug: capture, info: capture, warn: capture, error: capture },
    httpAuth: { grants: [grant], resolve: () => dummy },
    ...overrides,
  };
  const host = new NodeHost(db, options);
  t.after(async () => {
    try {
      await host.close();
      assert.equal(readFileSync(db).includes(Buffer.from(dummy)), false, 'credential in SQLite file');
      assert.equal(JSON.stringify(log).includes(dummy), false, 'credential in logs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return async (workflow) => {
    host.activate(workflow.id, host.publish(workflow));
    const id = host.accept(workflow.id, 'start', { items: [{ json: {} }] });
    await until(() => host.receipt(id).state === 'finished');
    const detail = await host.history.get(workflow.id, id);
    const summary = (await host.history.list(workflow.id)).find((row) => row.id === id);
    for (const record of [serializeWorkflow(workflow), detail, summary, host.receipt(id)]) {
      assert.equal(JSON.stringify(record).includes(dummy), false);
    }
    return { detail, summary };
  };
}

for (const kind of ['apiKey', 'bearer']) {
  test(kind + ' authenticates against the mock API without exposing the secret', async (t) => {
    const { origin, seen } = await mockApi(t);
    const grant = {
      id: 'service',
      workflowId: 'orders',
      nodeId: 'api',
      origin,
      kind,
      header: 'X-Service-Key',
    };
    const run = hostFixture(t, origin, {
      httpAuth: { grants: [grant], resolve: (id) => (id === 'service' ? dummy : undefined) },
    });
    const { detail, summary } = await run(document(origin + '/orders'));
    assert.equal(summary.status, 'success');
    assert.equal(seen.length, 1);
    assert.equal(
      kind === 'bearer' ? seen[0].headers.authorization : seen[0].headers['x-service-key'],
      kind === 'bearer' ? 'Bearer ' + dummy : dummy,
    );
    assert.deepEqual(detail.tasks.at(-1).task.output.main[0][0].json, { orders: 3 });
  });
}

test('status, reflection, redirects and transport failures cannot expose credentials', async (t) => {
  const { origin, seen } = await mockApi(t);
  const run = hostFixture(t, origin);
  for (const [path, message] of [
    ['deny', 'HTTP 401'],
    ['echo', 'credential material'],
    ['escaped', 'credential material'],
    ['redirect', 'HTTP request failed'],
  ]) {
    const { detail, summary } = await run(document(origin + '/' + path));
    assert.equal(summary.status, 'error');
    assert.ok(detail.error.message.includes(message), detail.error.message);
  }
  assert.equal(seen.length, 4);
  const failed = hostFixture(t, origin, {
    fetch: async () => {
      throw Error(dummy);
    },
  });
  assert.equal((await failed(document(origin))).summary.status, 'error');
});

test('unauthorized scope, missing binding, stale reference and provider failure are refused before sending', async (t) => {
  const { origin, seen } = await mockApi(t);
  const grant = { id: 'service', workflowId: 'orders', nodeId: 'api', origin, kind: 'bearer' };
  let resolves = 0;
  for (const change of [
    { id: 'other' },
    { workflowId: 'other' },
    { nodeId: 'other' },
    { origin: 'https://elsewhere.test' },
  ]) {
    const run = hostFixture(t, origin, {
      httpAuth: {
        grants: [{ ...grant, ...change }],
        resolve: () => {
          resolves++;
          return dummy;
        },
      },
    });
    assert.equal((await run(document(origin))).summary.status, 'error');
  }
  assert.equal(resolves, 0);
  const missing = document(origin);
  delete missing.nodes[1].credentials;
  assert.equal((await hostFixture(t, origin)(missing)).summary.status, 'error');
  for (const resolve of [
    () => undefined,
    () => {
      throw Error(dummy);
    },
  ]) {
    const run = hostFixture(t, origin, { httpAuth: { grants: [grant], resolve } });
    assert.equal((await run(document(origin))).summary.status, 'error');
  }
  assert.equal(seen.length, 0);
});

test('host byte budget counts chunks and decoded bytes and cancels oversized streams', async (t) => {
  const { origin } = await mockApi(t);
  const run = hostFixture(t, origin, { maxHttpResponseBytes: 17 });
  assert.match((await run(document(origin + '/large'))).detail.error.message, /byte limit/);
  for (const status of [200, 503]) {
    let cancelled = false;
    const run = hostFixture(t, origin, {
      maxHttpResponseBytes: 4,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(3));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status },
        ),
    });
    const publicDoc = document(origin);
    publicDoc.nodes[1].typeVersion = 1;
    delete publicDoc.nodes[1].credentials;
    delete publicDoc.nodes[1].parameters.authentication;
    assert.match((await run(publicDoc)).detail.error.message, /byte limit/);
    assert.equal(cancelled, true);
  }
});

test('accepts exactly the byte budget and refuses credential use on a pinned v1 node', async (t) => {
  const { origin, seen } = await mockApi(t);
  const run = hostFixture(t, origin, { maxHttpResponseBytes: Buffer.byteLength('{"orders":3}') });
  assert.equal((await run(document(origin))).summary.status, 'success');
  const legacy = document(origin);
  legacy.nodes[1].typeVersion = 1;
  assert.equal((await run(legacy)).summary.status, 'error');
  assert.equal(seen.length, 1);
});

test('local configuration resolves only explicitly mapped environment variables', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-auth-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'grants.json');
  writeFileSync(path, JSON.stringify({ grants: [], environment: { service: 'DRAFLOW_TEST_R3_KEY' } }));
  const original = process.env.DRAFLOW_TEST_R3_KEY;
  try {
    process.env.DRAFLOW_TEST_R3_KEY = dummy;
    const auth = loadHttpAuth(path);
    assert.equal(auth.resolve('service'), dummy);
    assert.equal(auth.resolve('DRAFLOW_TEST_R3_KEY'), undefined);
  } finally {
    if (original === undefined) delete process.env.DRAFLOW_TEST_R3_KEY;
    else process.env.DRAFLOW_TEST_R3_KEY = original;
  }
});
