import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createWebhookServer } from '../dist/webhook.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionEngine } from '@draflow/core';
import { waitNode, standardNodes } from '@draflow/nodes';
import { SqliteLedger } from '../dist/sqlite.js';
import { NodeHost } from '../dist/host.js';
import { event, registry, until, workflow } from './fixture.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-wait-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'host.db');
  let now = Date.now();
  const open = (options = {}) => {
    const host = new NodeHost(path, {
      registry: registry().registerAll(standardNodes),
      ...options,
      clock: { now: () => now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
      scheduleClock: {
        now: () => now,
        arm: (fn, delay) => {
          const timer = setTimeout(fn, delay);
          return () => clearTimeout(timer);
        },
      },
    });
    t.after(() => host.close());
    return host;
  };
  return {
    open,
    path,
    now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function node(id, type, parameters = {}) {
  return { id, type, name: id, typeVersion: 1, position: { x: 0, y: 0 }, parameters };
}
function edge(from, to, slot = 0) {
  return {
    id: from + '-' + to,
    from: { node: from, port: 'main', index: 0 },
    to: { node: to, port: 'main', index: slot },
  };
}
function branch(dueAt, mode = 'event') {
  const flow = workflow();
  flow.nodes.push(node('join', 'draflow.merge'), node('wait', 'draflow.wait', { dueAt, mode }));
  flow.nodes.find((n) => n.id === 'sink').parameters.label = '={{ $("a").item.json.order }}';
  flow.connections = [edge('a', 'join'), edge('a', 'wait'), edge('wait', 'join', 1), edge('join', 'sink')];
  return flow;
}
const state = (host, id, wanted) => until(() => host.receipt(id).state === wanted);
function submit(host, doc, key) {
  host.activate(doc.id, host.publish(doc));
  return host.accept(doc.id, 'a', { ...event, key });
}

test('4.1 retains a pending join, expressions and item sources across replacement, restart and history deletion', async (t) => {
  const db = setup(t);
  let host = db.open();
  const doc = branch(db.now + 86400000);
  const id = submit(host, doc, 'old');
  await state(host, id, 'waiting');
  const { wait, ...immediate } = waitNode;
  const controlRegistry = registry()
    .registerAll(standardNodes.filter((n) => n !== waitNode))
    .register({
      ...immediate,
      execute: (ctx) => waitNode.execute({ ...ctx, resume: { reason: 'event', data: { value: 1 } } }),
    });
  const control = await new ExecutionEngine({ registry: controlRegistry }).run(doc, {
    startNodeId: 'a',
    triggerData: { main: [event.items] },
  }).done;
  assert.equal(control.status, 'success');
  const expected = Object.values(control.runData)
    .flat()
    .sort((a, b) => a.executionIndex - b.executionIndex);
  const updated = workflow('new');
  const other = submit(host, updated, 'new');
  await state(host, other, 'finished');
  await host.history.delete('flow', id);
  await host.close();
  host = db.open();
  assert.equal(host.receipt(id).revision, 1);
  host.resolveWait(id, host.waitInfo(id).token, 'event', { value: 1 });
  await state(host, id, 'finished');
  const actual = await host.history.get('flow', id);
  const project = (tasks) =>
    tasks.map((task) => [task.nodeId, task.runIndex, task.executionIndex, task.source, task.output]);
  assert.deepEqual(project(actual.tasks.map((row) => row.task)), project(expected));
  assert.equal(actual.tasks.at(-1).task.output.main[0][0].json.value, 42);
  assert.equal(actual.tasks.find((t) => t.nodeId === 'join').task.output.main[0].length, 2);
});

test('4.1 opens the pre-checkpoint schema with queued and interrupted receipts', async (t) => {
  const db = setup(t);
  let host = db.open();
  const id = submit(host, workflow(), 'queued');
  const past = host.accept('flow', 'a', { ...event, key: 'interrupted' });
  await host.close();
  const sql = new DatabaseSync(db.path);
  sql.exec('DROP TABLE continuations; DROP TABLE transitions; DROP TABLE effects');
  sql.prepare("UPDATE runs SET state='interrupted' WHERE runId=?").run(past);
  sql.close();
  host = db.open();
  await state(host, id, 'finished');
  assert.equal(host.receipt(past).state, 'interrupted');
});

test('4.2 binds each event to a single wait, serializes cancellation and enforces offline deadlines', async (t) => {
  const db = setup(t);
  let host = db.open();
  const doc = branch(db.now + 60000);
  const id = submit(host, doc, 'event');
  const other = host.accept('flow', 'a', { ...event, key: 'cancel' });
  const timed = submit(host, branch(String(db.now + 60000), 'time'), 'timer');
  await state(host, timed, 'waiting');
  const token = host.waitInfo(id).token;
  const otherToken = host.waitInfo(other).token;
  assert.equal(host.resolveWait(other, token, 'event'), false);
  assert.equal(host.resolveWait(other, otherToken, 'canceled'), true);
  assert.equal(host.resolveWait(other, otherToken, 'event'), false);
  await state(host, other, 'finished');
  assert.equal(host.receipt(other).outcome, 'canceled');
  await host.close();
  db.advance(86400000);
  host = db.open();
  assert.equal(host.resolveWait(id, token, 'event'), false);
  await state(host, timed, 'finished');
  await state(host, id, 'finished');
  assert.equal(host.receipt(timed).outcome, 'success');
  assert.equal(host.receipt(id).outcome, 'success');
  assert.deepEqual(
    host.transitions(id).map((x) => x.reason),
    ['waiting:event', 'expired'],
  );
  assert.deepEqual(
    host.transitions(timed).map((x) => x.reason),
    ['waiting:time', 'time'],
  );
});

test('4.4 old approval registers once, new rejection, expiry and cancellation remain inspectable', async (t) => {
  const db = setup(t);
  const posts = [];
  const options = {
    fetch: async (url, init) => {
      posts.push([url, JSON.parse(init.body)]);
      return Response.json({ ok: true });
    },
  };
  let host = db.open(options);
  const doc = JSON.parse(readFileSync(new URL('../../../examples/approval.json', import.meta.url)));
  async function listen() {
    const server = createWebhookServer(host, { signingKey: 'test' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    return 'http://127.0.0.1:' + server.address().port;
  }
  let origin = await listen();
  const submitApplication = async (key) => {
    const body = JSON.stringify({ applicationId: key, deadline: db.now + 60000 });
    const signature = createHmac('sha256', 'test')
      .update('/webhook/application\n' + key + '\n' + body)
      .digest('hex');
    const response = await fetch(origin + '/webhook/application', {
      method: 'POST',
      body,
      headers: { 'x-draflow-delivery': key, 'x-draflow-signature': 'sha256=' + signature },
    });
    assert.equal(response.status, 202);
    return (await response.json()).runId;
  };
  host.activate(doc.id, host.publish(doc));
  const old = await submitApplication('old');
  await state(host, old, 'waiting');
  const token = host.waitInfo(old).token;
  const [pending] = await host.history.list(doc.id);
  assert.equal(pending.waitingFor, 'event');
  assert.equal(pending.dueAt, db.now + 60000);
  await host.close();
  host = db.open(options);
  origin = await listen();
  const originalUrl = doc.nodes.find((n) => n.id === 'register').parameters.url;
  doc.nodes.find((n) => n.id === 'register').parameters.url += '/v2';
  host.activate(doc.id, host.publish(doc));
  const newer = await submitApplication('new');
  const expired = await submitApplication('expired');
  const canceled = await submitApplication('canceled');
  await state(host, canceled, 'waiting');
  const callback = (id, bearer) =>
    fetch(origin + '/resume/' + id, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bearer },
      body: JSON.stringify({ decision: 'approved' }),
    });
  assert.equal((await callback(newer, token)).status, 404);
  const statuses = (await Promise.all([callback(old, token), callback(old, token)]))
    .map((r) => r.status)
    .sort();
  assert.equal(statuses[0], 202);
  assert.ok([404, 409].includes(statuses[1]));
  host.resolveWait(newer, host.waitInfo(newer).token, 'event', { decision: 'rejected' });
  host.resolveWait(canceled, host.waitInfo(canceled).token, 'canceled');
  db.advance(60001);
  assert.equal(
    host.resolveWait(expired, host.waitInfo(expired).token, 'event', { decision: 'approved' }),
    false,
  );
  for (const id of [old, newer, expired, canceled]) await state(host, id, 'finished');
  assert.deepEqual(posts, [[originalUrl, { applicationId: 'old' }]]);
  const detail = (id) => host.history.get(doc.id, id);
  assert.equal((await detail(newer)).tasks.at(-1).nodeId, 'reject');
  assert.equal((await detail(expired)).tasks.at(-1).nodeId, 'timeout');
  assert.equal((await detail(expired)).transitions.at(-1).reason, 'expired');
  assert.equal((await detail(canceled)).transitions.at(-1).reason, 'canceled');
  assert.equal(host.receipt(newer).revision, 2);
});

test('a committed decision survives a restart between claiming the run and dispatch', async (t) => {
  const db = setup(t);
  let host = db.open();
  const id = submit(host, branch(db.now + 60000), 'claim');
  await state(host, id, 'waiting');
  const token = host.waitInfo(id).token;
  assert.ok(host.resolveWait(id, token, 'event', { decision: 'approved' }));
  await host.close();
  const ledger = new SqliteLedger(db.path, 1024 * 1024);
  assert.equal(ledger.claim().receipt.runId, id);
  ledger.close(); // Process exits with exactly the on-disk state following claim.
  host = db.open();
  await until(() => ['finished', 'interrupted'].includes(host.receipt(id).state));
  assert.equal(host.receipt(id).outcome, 'success');
  assert.equal(host.resolveWait(id, token, 'event'), false);
  assert.deepEqual(
    host.transitions(id).map((row) => row.reason),
    ['waiting:event', 'event'],
  );
});

test('a waiting history record contains the tasks it counts', async (t) => {
  const db = setup(t);
  const host = db.open();
  const id = submit(host, branch(db.now + 60000), 'inspect');
  await state(host, id, 'waiting');
  const [summary] = await host.history.list('flow');
  const detail = await host.history.get('flow', id);
  assert.ok(summary.executed > 0);
  assert.equal(detail.tasks.length, summary.executed);
  assert.deepEqual(detail.tasks[0].task.output.main[0][0].json, event.items[0].json);
});

test('a token consumed at the first wait cannot resolve the next wait in the same run', async (t) => {
  const db = setup(t);
  const host = db.open();
  const doc = branch(db.now + 60000);
  doc.nodes.push(node('again', 'draflow.wait', { mode: 'event', dueAt: db.now + 60000 }));
  doc.connections.push(edge('sink', 'again'));
  const id = submit(host, doc, 'twice');
  await state(host, id, 'waiting');
  const first = host.waitInfo(id).token;
  assert.ok(host.resolveWait(id, first, 'event'));
  await state(host, id, 'waiting');
  const second = host.waitInfo(id).token;
  assert.notEqual(first, second);
  assert.equal(host.resolveWait(id, first, 'canceled'), false);
  assert.ok(host.resolveWait(id, second, 'canceled'));
  await state(host, id, 'finished');
  assert.equal(host.receipt(id).outcome, 'canceled');
});
