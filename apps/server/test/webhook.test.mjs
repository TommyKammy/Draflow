import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { webhookNode } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { createWebhookServer } from '../dist/webhook.js';
import { registry, until, workflow } from './fixture.mjs';

const signingKey = 'dummy-webhook-signing-key';
const raw = Buffer.from('{"order": "日本語"}');
const path = '/webhook/orders';

function document(label = 'published', route = 'orders') {
  const doc = workflow(label);
  Object.assign(doc.nodes[0], { type: 'draflow.webhook', parameters: { path: route } });
  return doc;
}

function headers(path, body, id) {
  const digest = createHmac('sha256', signingKey)
    .update(path + '\n' + (id ?? '') + '\n')
    .update(body)
    .digest('hex');
  return { 'x-draflow-signature': 'sha256=' + digest, ...(id !== undefined && { 'x-draflow-delivery': id }) };
}

async function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-hook-'));
  const db = join(dir, 'ledger.db');
  const calls = [];
  let host, server, origin;
  async function start() {
    host = new NodeHost(db, {
      registry: registry(async (id, label) => {
        calls.push({ id, label });
        await options.effect?.();
      }).register(webhookNode),
      capacity: options.capacity ?? 100,
    });
    server = createWebhookServer(host, {
      signingKey: options.signingKey ?? signingKey,
      maxBodyBytes: options.maxBodyBytes ?? 1024,
    });
    if (options.onRequest) server.on('request', options.onRequest);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  async function stop() {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    await host.close();
  }
  await start();
  t.after(async () => {
    try {
      await stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return {
    get host() {
      return host;
    },
    get origin() {
      return origin;
    },
    start,
    stop,
    db,
    calls,
    post(p = path, body = raw, id = 'event-1', extra = {}) {
      return fetch(origin + p, { method: 'POST', body, headers: { ...headers(p, body, id), ...extra } });
    },
  };
}

test('returns 202 and the committed run ID before completion; concurrent redeliveries survive restart', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await setup(t, { effect: () => gate });
  f.host.activate('flow', f.host.publish(document()));
  try {
    const responses = await Promise.all(Array.from({ length: 10 }, () => f.post()));
    assert.ok(responses.every((r) => r.status === 202));
    const ids = await Promise.all(responses.map(async (r) => (await r.json()).runId));
    assert.equal(new Set(ids).size, 1);
    const id = ids[0];
    assert.equal(f.host.receipt(id).mode, 'webhook');
    assert.notEqual(f.host.receipt(id).state, 'finished');
    release();
    await until(() => f.host.receipt(id).state === 'finished');
    assert.deepEqual(f.calls, [{ id, label: 'published' }]);
    const detail = await f.host.history.get('flow', id);
    assert.deepEqual(
      detail.tasks.map((t) => t.nodeId),
      ['a', 'sink'],
    );
    assert.deepEqual(detail.tasks[0].task.output.main[0][0].json, { body: JSON.parse(raw) });
    await f.stop();
    await f.start();
    assert.deepEqual(await (await f.post()).json(), { runId: id });
    assert.equal(f.calls.length, 1);
  } finally {
    release();
  }
});

test('rejects bad signatures, oversized byte streams and malformed JSON without any durable runs', async (t) => {
  const f = await setup(t, { maxBodyBytes: raw.length });
  f.host.activate('flow', f.host.publish(document()));
  assert.equal(
    (await f.post(path, raw, 'event-1', { ...headers(path, raw, 'other'), 'x-draflow-delivery': 'event-1' }))
      .status,
    401,
  );
  assert.equal((await f.post(path, raw, 'event-1', headers('/webhook/other', raw, 'event-1'))).status, 401);
  assert.equal((await f.post(path, raw, 'event-1', headers(path, Buffer.from('{}'), 'event-1'))).status, 401);
  assert.equal((await f.post(path, Buffer.concat([raw, Buffer.from(' ')]))).status, 413);
  const oversized = Buffer.concat([raw, Buffer.from(' ')]);
  const req = request(f.origin + path, { method: 'POST', headers: headers(path, oversized, 'id') });
  const response = once(req, 'response');
  req.write(raw);
  req.end(' ');
  const [res] = await response;
  assert.equal(res.statusCode, 413);
  res.resume();
  assert.equal((await f.post(path, Buffer.from('{'))).status, 400);
  assert.equal(f.calls.length, 0);
  await f.stop();
  const db = new DatabaseSync(f.db);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  } finally {
    db.close();
  }
});

test('activation rejects conflicting routes atomically and unpublished or deactivated routes never admit', async (t) => {
  const f = await setup(t);
  const first = f.host.publish(document());
  assert.equal((await f.post()).status, 404);
  const duplicate = document('invalid', 'new');
  Object.assign(duplicate.nodes[1], { type: 'draflow.webhook', parameters: { path: 'new' } });
  assert.throws(() => f.host.activate('flow', f.host.publish(duplicate)), /already registered/);
  assert.equal((await f.post('/webhook/new')).status, 404);
  f.host.activate('flow', first);
  const other = document('other', 'private');
  other.id = 'other';
  Object.assign(other.nodes[1], { type: 'draflow.webhook', parameters: { path: 'orders' } });
  assert.throws(() => f.host.activate('other', f.host.publish(other)), /already registered/);
  assert.equal((await f.post('/webhook/private')).status, 404);
  assert.equal(f.calls.length, 0);
  assert.equal(f.host.webhook(path).workflowId, 'flow');
  f.host.deactivate('flow');
  assert.equal((await f.post()).status, 404);
  assert.equal(f.host.stats().queued, 0);
  assert.equal(f.calls.length, 0);
});

test('test URL runs its draft with independent deduplication; expiry and restart do not fall through', async (t) => {
  const f = await setup(t);
  f.host.activate('flow', f.host.publish(document()));
  const temp = f.host.listenTest(document('draft'), 'a', 60_000);
  const testId = (await (await f.post(temp.path)).json()).runId;
  assert.throws(() => f.host.activate(temp.workflowId, 1), /test snapshot/);
  const prodId = (await (await f.post()).json()).runId;
  assert.notEqual(testId, prodId);
  assert.deepEqual(await (await f.post(temp.path)).json(), { runId: testId });
  await until(() => f.host.receipt(prodId).state === 'finished');
  assert.deepEqual(f.calls, [
    { id: testId, label: 'draft' },
    { id: prodId, label: 'published' },
  ]);
  const expired = f.host.listenTest(document('expired'), 'a', 1);
  await until(() => Date.now() >= expired.expiresAt);
  assert.equal((await f.post(expired.path)).status, 404);
  await f.stop();
  await f.start();
  assert.equal((await f.post(temp.path)).status, 404);
  assert.deepEqual(await (await f.post()).json(), { runId: prodId });
  assert.equal(f.calls.length, 2);
});

for (const kind of ['replacement', 'reactivation', 'rollback', 'expiry']) {
  test('rejects ' + kind + ' during a slow upload before recording the delivery', async (t) => {
    let entered;
    const reading = new Promise((resolve) => {
      entered = resolve;
    });
    const f = await setup(t, {
      onRequest: entered,
    });
    f.host.activate('flow', f.host.publish(document()));
    const temp = kind === 'expiry' ? f.host.listenTest(document('draft'), 'a', 500) : undefined;
    const endpoint = temp?.path ?? path;
    const req = request(f.origin + endpoint, { method: 'POST', headers: headers(endpoint, raw, 'raced') });
    const response = once(req, 'response');
    req.write(raw.subarray(0, 1));
    await Promise.race([
      reading,
      response.then(() => {
        throw new Error('Upload ended before route lookup');
      }),
    ]);
    if (temp) await until(() => Date.now() >= temp.expiresAt);
    else if (kind === 'reactivation') {
      f.host.deactivate('flow');
      f.host.activate('flow', 1);
    } else {
      f.host.activate('flow', f.host.publish(document('replacement')));
      if (kind === 'rollback') f.host.activate('flow', 1);
    }
    req.end(raw.subarray(1));
    const [res] = await response;
    assert.equal(res.statusCode, 404);
    res.resume();
    assert.equal(f.host.byEvent(temp?.workflowId ?? 'flow', 'a', 'raced'), undefined);
    assert.equal(f.calls.length, 0);
  });
}

test('queue full and SQLite commit failure never return an acceptance', async (t) => {
  const full = await setup(t, { capacity: 0 });
  full.host.activate('flow', full.host.publish(document()));
  assert.equal((await full.post()).status, 503);
  const f = await setup(t);
  f.host.activate('flow', f.host.publish(document()));
  await f.stop();
  const db = new DatabaseSync(f.db);
  db.exec(`CREATE TABLE fault(runId TEXT REFERENCES runs(runId) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_webhook AFTER INSERT ON deliveries BEGIN INSERT INTO fault VALUES('absent'); END;`);
  db.close();
  await f.start();
  assert.equal((await f.post()).status, 503);
  assert.equal(f.host.stats().queued, 0);
  assert.equal(f.host.byEvent('flow', 'a', 'event-1'), undefined);
  assert.equal(f.calls.length, 0);
});

test('accepted test work survives restart while the old test URL is gone', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await setup(t, { effect: () => gate });
  f.host.activate('flow', f.host.publish(document()));
  let testId, session;
  try {
    const running = (await (await f.post()).json()).runId;
    await until(() => f.host.receipt(running).state === 'running');
    session = f.host.listenTest(document('queued draft'), 'a');
    const response = await f.post(session.path);
    assert.equal(response.status, 202);
    testId = (await response.json()).runId;
    assert.equal(f.host.receipt(testId).state, 'queued');
    const stopping = f.host.close();
    release();
    await stopping;
  } finally {
    release();
  }
  await f.stop();
  await f.start();
  assert.equal((await f.post(session.path)).status, 404);
  await until(() => f.host.receipt(testId).state === 'finished');
  assert.deepEqual(
    f.calls.filter((c) => c.id === testId),
    [{ id: testId, label: 'queued draft' }],
  );
});

test('separate deliveries without IDs can carry identical signed JSON', async (t) => {
  const f = await setup(t);
  f.host.activate('flow', f.host.publish(document()));
  const send = () => fetch(f.origin + path, { method: 'POST', headers: headers(path, raw), body: raw });
  const one = await send(),
    two = await send();
  assert.equal(one.status, 202);
  assert.equal(two.status, 202);
  const first = await one.json(),
    second = await two.json();
  assert.notEqual(first.runId, second.runId);
  await until(() => f.calls.length === 2);
});

test('verifies a complete delivery with the current signing key after rotation', async (t) => {
  let key = 'previous-test-key';
  let entered;
  const reading = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await setup(t, { signingKey: () => key, onRequest: entered });
  f.host.activate('flow', f.host.publish(document()));
  const req = request(f.origin + path, { method: 'POST', headers: headers(path, raw, 'rotated') });
  const response = once(req, 'response');
  req.write(raw.subarray(0, 1));
  await reading;
  key = signingKey;
  // An idempotent activate leaves the live registration serving the upload.
  f.host.activate('flow', 1);
  req.end(raw.subarray(1));
  const [res] = await response;
  res.resume();
  assert.equal(res.statusCode, 202);
  await until(() => f.calls.length === 1);
  assert.equal(f.host.byEvent('flow', 'a', 'rotated').runId, f.calls[0].id);
});
