import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { NodeRegistry } from '@draflow/core';
import { standardNodes, noOpNode } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { publish as publishCompensations } from './compensation-fixture.mjs';
import { until } from './fixture.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL('../../../examples/' + name + '.json', import.meta.url)));
function setup(t, options = {}) {
  const organization = randomUUID();
  const h = new NodeHost(':memory:', {
    organization, registry: new NodeRegistry().registerAll(standardNodes),
    ...(process.env.DRAFLOW_TEST_POSTGRES && {
      shared: { organization, connectionString: process.env.DRAFLOW_TEST_POSTGRES, pollMs: 50 },
    }),
    ...options,
    ...(options.httpAuth && { httpAuth: { ...options.httpAuth, organization } }),
  });
  t.after(() => h.close());
  return { h, operate: (role, query) => h.operate({ organization, actor: role, role }, query) };
}

test('order sync preview predicts both entry points and the actual credential-scoped requests without dispatch', async (t) => {
  const flow = fixture('order-sync');
  const origin = 'https://orders.example.test';
  const resolutions = [], requests = [], bodies = [];
  const { h, operate } = setup(t, {
    httpAuth: {
      grants: ['read', 'send'].map((id) => ({ workflowId: flow.id, nodeId: id, origin, kind: 'bearer', id: 'orders-' + id })),
      resolve(id) { resolutions.push(id); return 'token-for-' + id; },
    },
    fetch: async (url, init) => {
      requests.push([init.method, url, new Headers(init.headers).get('authorization')]);
      if (init.method === 'POST') bodies.push(JSON.parse(init.body));
      return Response.json([{ amount: 7, approved: true }, { amount: 80, approved: false }]);
    },
  });
  const query = { op: 'preview', workflow: flow };
  const stats = h.stats();
  for (const role of ['operator', 'viewer'])
    assert.throws(() => operate(role, query), (e) => e.status === 403);
  const preview = operate('publisher', query);
  assert.deepEqual(operate('admin', query), preview);
  assert.deepEqual(preview.triggers.map(({ nodeId, path, schedule }) => [nodeId, path, schedule]),
    [['hook', '/webhook/orders', undefined], ['timer', undefined, { intervalMs: 60000 }]]);
  for (const trigger of preview.triggers) {
    assert.deepEqual(trigger.effects.map((e) => [e.nodeId, e.kind, e.method, e.destination, e.credentialRefs]), [
      ['read', 'read', 'GET', origin + '/orders', ['orders-read']],
      ['send', 'write', 'POST', origin + '/totals', ['orders-send']],
    ]);
  }
  assert.deepEqual([resolutions, requests], [[], []]);
  assert.deepEqual(h.stats(), stats);
  assert.deepEqual(await h.history.list(flow.id), []);
  assert.deepEqual(operate('publisher', { op: 'audit' }), []);
  assert.ok(!h.webhook('/webhook/orders'));
  assert.equal(h.publish(flow), 1);
  h.activate(flow.id, 1);
  const edited = structuredClone(flow);
  edited.connections.find((edge) => edge.id === 'hook-read').to.node = 'send';
  const changed = operate('publisher', { op: 'preview', workflow: edited });
  assert.deepEqual(changed.triggers.map((trigger) => trigger.effects.map((effect) => effect.nodeId)),
    [['send'], ['read', 'send']]);
  for (const trigger of preview.triggers) {
    const id = h.accept(flow.id, trigger.nodeId, { items: [{ json: {} }] });
    await until(() => h.receipt(id).state === 'finished');
    assert.equal(h.receipt(id).outcome, 'success');
    assert.deepEqual(requests.splice(0), trigger.effects.map((e) => [e.method, e.destination, 'Bearer token-for-' + e.credentialRefs[0]]));
  }
  assert.deepEqual(bodies.map(({ count, total }) => [count, total]), [[1, 7], [1, 7]]);
});

test('preview retains dynamic and undeclared effects, omits secrets and follows disabled pass-through', (t) => {
  const custom = { ...noOpNode, type: 'host.custom', execute: () => assert.fail('preview executed a node') };
  const declared = { ...custom, type: 'host.notify', meta: { ...custom.meta, externalEffect: 'write' } };
  const { h } = setup(t, { registry: new NodeRegistry().registerAll([...standardNodes, custom, declared]) });
  const flow = fixture('order-sync');
  const read = flow.nodes.find((n) => n.id === 'read'), send = flow.nodes.find((n) => n.id === 'send');
  delete read.credentials;
  read.parameters.authentication = 'none';
  read.parameters.url = 'https://user:SECRET@example.test/path?token=SECRET#SECRET';
  send.parameters.url = '={{ $json.SECRET }}';
  send.parameters.method = '={{ $json.method }}';
  send.parameters.headers = { Authorization: 'SECRET' };
  flow.nodes.find((n) => n.id === 'timer').disabled = true;
  flow.nodes.find((n) => n.id === 'keep').disabled = true;
  flow.nodes.find((n) => n.id === 'split').type = custom.type;
  flow.nodes.find((n) => n.id === 'aggregate').type = declared.type;
  flow.nodes.push({ ...send, id: 'orphan', name: 'Unreachable' });
  const preview = h.previewPublication(flow);
  assert.equal(preview.triggers.length, 1);
  assert.deepEqual(preview.triggers[0].effects.map((e) => [e.nodeId, e.kind, e.destination]), [
    ['read', 'read', 'https://example.test/path'], ['split', 'undeclared', null],
    ['aggregate', 'write', null], ['send', 'unknown', null],
  ]);
  assert.ok(!JSON.stringify(preview).includes('SECRET'));
});

// Record the request after the host has applied its destination grant and credentials.
function receiver(grants, response) {
  const requests = [];
  const options = {
    httpAuth: { grants, resolve: (id) => 'token-' + id },
    fetch: async (url, init) => {
      const target = new URL(url);
      requests.push([init.method, target.origin + target.pathname, new Headers(init.headers).get('authorization')]);
      return Response.json(response(init.method));
    },
  };
  return { requests, options };
}
const expectedRequest = (e) => [e.method, e.destination, e.credentialRefs.length ? 'Bearer token-' + e.credentialRefs[0] : null];

test('paged reads and nested calls dispatch to the previewed pinned revisions and credential scopes', async (t) => {
  const parent = fixture('order-import'), leaf = fixture('process-order-batch');
  const wrapper = structuredClone(leaf);
  wrapper.id = 'batch-wrapper';
  parent.nodes[1].parameters.workflowId = wrapper.id;
  parent.nodes[1].credentials = { httpAuth: 'source' };
  Object.assign(wrapper.nodes[1], { type: 'draflow.call', typeVersion: 1, parameters: { workflowId: leaf.id, revision: 1 } });
  leaf.nodes[0].parameters.callers = [wrapper.id];
  leaf.nodes[1].parameters.authentication = 'credential';
  leaf.nodes[1].credentials = { httpAuth: 'sink' };
  const { requests, options } = receiver([
    { id: 'source', workflowId: parent.id, nodeId: 'pages', origin: 'https://source.example.test', kind: 'bearer' },
    { id: 'sink', workflowId: leaf.id, nodeId: 'register', origin: 'https://sink.example.test', kind: 'bearer' },
  ], (method) => method === 'GET' ? { items: [{ id: 'one', amount: 5 }], nextCursor: null } : { id: 'receipt' });
  // A host may customize the label without changing the built-in page reader.
  options.registry = new NodeRegistry().registerAll(standardNodes.map((n) => n.type === 'draflow.pages'
    ? { ...n, meta: { ...n.meta, label: 'Order pages', externalEffect: 'none' } } : n));
  const { h } = setup(t, options), other = setup(t).h;
  assert.throws(() => h.previewPublication(parent), /Unknown publication/);
  h.publish(leaf);
  h.publish(wrapper);
  const oldUrl = leaf.nodes[1].parameters.url;
  leaf.nodes[1].parameters.url = 'https://new.example.test/changed';
  leaf.nodes[1].credentials.httpAuth = 'new-key';
  h.publish(leaf);
  const effects = h.previewPublication(parent).triggers[0].effects;
  assert.deepEqual(effects.map((e) => [e.workflowId, e.revision, e.destination]), [
    [parent.id, null, parent.nodes[1].parameters.url], [leaf.id, 1, oldUrl],
  ]);
  assert.throws(() => other.previewPublication(parent), /Unknown publication/);
  assert.deepEqual(requests, []);
  h.activate(parent.id, h.publish(parent));
  const run = h.accept(parent.id, 'schedule', { items: [{ json: {} }] });
  await until(() => h.receipt(run).state === 'finished');
  assert.equal(h.receipt(run).outcome, 'success');
  assert.deepEqual(requests, effects.map(expectedRequest));
});

test('forward writes and the pinned compensations match their actual requests', async (t) => {
  const { requests, options } = receiver([['order-import', 'ship'], ['release', 'register']].map(([workflowId, nodeId]) =>
    ({ id: workflowId, workflowId, nodeId, origin: 'https://sink.example.test', kind: 'bearer' })), () => ({ id: 'receipt' }));
  const { h } = setup(t, options);
  let draft;
  publishCompensations(h, false, false, (flow) => { draft = structuredClone(flow); });
  const replacement = fixture('process-order-batch');
  replacement.id = 'release';
  replacement.nodes[1].parameters.url = 'https://sink.example.test/new-release';
  h.publish(replacement);
  const effects = h.previewPublication(draft).triggers[0].effects;
  const forward = effects.filter((e) => e.phase === 'execution');
  const undo = effects.filter((e) => e.phase === 'compensation');
  assert.deepEqual(forward.map((e) => e.nodeId), ['reserve', 'charge', 'ship']);
  assert.deepEqual(undo.map((e) => [e.workflowId, e.revision]), [['release', 1], ['refund', 1], ['void', 1]]);
  const run = h.accept(draft.id, 'schedule', { items: [{ json: { order: 1 } }] });
  await until(() => h.receipt(run).state === 'finished');
  assert.equal(h.receipt(run).outcome, 'success');
  assert.deepEqual(requests.splice(0), forward.map(expectedRequest));
  h.compensate(run);
  await until(() => h.compensationInfo(run).state === 'compensated');
  assert.deepEqual(requests, undo.reverse().map(expectedRequest));
});

function singleRequest() {
  const flow = fixture('order-sync');
  flow.nodes = flow.nodes.filter((n) => ['hook', 'read'].includes(n.id));
  flow.connections = flow.connections.filter((c) => c.id === 'hook-read');
  return flow;
}

test('conflicting or missing credential references block dispatch', async (t) => {
  const { requests, options } = receiver([], () => ({}));
  const { h } = setup(t, options);
  for (const [auth, grant, url] of [
    ['none', 'orders-read'], ['credential', undefined], ['credential', 'orders-read', 'http://example.test/orders'],
  ]) {
    const flow = singleRequest(), read = flow.nodes[1];
    read.parameters.authentication = auth;
    if (!grant) delete read.credentials;
    if (url) read.parameters.url = url;
    const after = structuredClone(read);
    Object.assign(after, { id: 'after', name: 'After blocked request', credentials: {}, parameters: { url: 'https://sink.example.test/after' } });
    flow.nodes.push(after);
    const edge = structuredClone(flow.connections[0]);
    edge.id = 'after-blocked';
    edge.from.node = read.id;
    edge.to.node = after.id;
    flow.connections.push(edge);
    const { effects } = h.previewPublication(flow).triggers[0];
    assert.deepEqual(effects.map((e) => e.nodeId), [read.id]);
    const [entry] = effects;
    assert.equal(entry.kind, 'blocked');
    assert.deepEqual(entry.credentialRefs, []);
    h.activate(flow.id, h.publish(flow));
    const run = h.accept(flow.id, 'hook', { items: [{ json: {} }] });
    await until(() => h.receipt(run).state === 'finished');
    assert.equal(h.receipt(run).outcome, 'error');
  }
  assert.deepEqual(requests, []);
});

test('literal templates report the initial destination and anonymous redirects', async (t) => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push([req.method, req.url]);
    if (req.url === '/initial') res.writeHead(307, { location: '/receiver' });
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const flow = singleRequest(), read = flow.nodes[1];
  delete read.credentials;
  Object.assign(read.parameters, { method: '=POST', url: '=' + origin + '/initial', authentication: '=none' });
  const { h } = setup(t);
  const [effect] = h.previewPublication(flow).triggers[0].effects;
  assert.deepEqual([effect.kind, effect.method, effect.destination, effect.mayRedirect], ['write', 'POST', origin + '/initial', true]);
  h.activate(flow.id, h.publish(flow));
  const run = h.accept(flow.id, 'hook', { items: [{ json: {} }] });
  await until(() => h.receipt(run).state === 'finished');
  assert.equal(h.receipt(run).outcome, 'success');
  assert.deepEqual(hits, [['POST', '/initial'], ['POST', '/receiver']]);
});

test('replaced nodes without wait or journal hooks do not dispatch children or register reversals', async (t) => {
  const registry = new NodeRegistry().registerAll(standardNodes.map((n) =>
    n.type === 'draflow.pages' || (n.type === 'draflow.httpRequest' && n.version === 2)
      ? { ...n, execute: noOpNode.execute, wait: undefined, journalMode: undefined, meta: { ...n.meta, externalEffect: 'none' } }
      : n));
  const { requests, options } = receiver([], () => ({}));
  const { h } = setup(t, { ...options, registry });
  const root = fixture('order-import');
  h.publish(fixture('process-order-batch'));
  assert.deepEqual(h.previewPublication(root).triggers[0].effects, []);
  h.activate(root.id, h.publish(root));
  const paged = h.accept(root.id, 'schedule', { items: [{ json: {} }] });
  await until(() => h.receipt(paged).outcome === 'success');
  publishCompensations(h, false, false, (draft) => {
    assert.deepEqual(h.previewPublication(draft).triggers[0].effects, []);
  });
  const run = h.accept(root.id, 'schedule', { items: [{ json: {} }] });
  await until(() => h.receipt(run).outcome === 'success');
  assert.deepEqual(h.compensationInfo(run).steps, []);
  assert.deepEqual(requests, []);
});

test('order comparison uses the active tenant revision, predicts the switch, and has no dispatch side effects', async (t) => {
  const flow = fixture('order-sync'), draft = structuredClone(flow);
  const send = draft.nodes.find((n) => n.id === 'send');
  send.parameters.url = 'https://shipping.example.test/totals?token=PRIVATE';
  send.credentials.httpAuth = 'shipping';
  draft.nodes.find((n) => n.id === 'timer').disabled = true;
  const grants = [
    ['orders-read', 'read', 'https://orders.example.test'],
    ['orders-send', 'send', 'https://orders.example.test'],
    ['shipping', 'send', 'https://shipping.example.test'],
  ].map(([id, nodeId, origin]) => ({ id, nodeId, origin, workflowId: flow.id, kind: 'bearer' }));
  const { requests, options } = receiver(grants, () => [{ approved: true, amount: 7 }]);
  const { h, operate } = setup(t, options);
  const query = { op: 'preview', compareActive: true, workflow: draft };
  for (const role of ['operator', 'viewer']) assert.throws(() => operate(role, query), (e) => e.status === 403);
  h.activate(flow.id, h.publish(flow));
  assert.equal(h.publish(draft), 2); // Published, still inactive.
  const before = h.stats();
  const diff = operate('publisher', query);
  assert.deepEqual(diff, operate('admin', query));
  assert.equal(diff.activeRevision, 1);
  assert.ok(!JSON.stringify(diff).includes('PRIVATE'));
  const [hook, timer] = diff.changes;
  assert.equal(hook.after.nodeId, 'hook');
  assert.equal(hook.conditionChanged, false);
  assert.deepEqual(hook.removed.map(expectedRequest), [['POST', 'https://orders.example.test/totals', 'Bearer token-orders-send']]);
  assert.deepEqual(hook.added.map(expectedRequest), [['POST', 'https://shipping.example.test/totals', 'Bearer token-shipping']]);
  assert.equal(timer.before.nodeId, 'timer');
  assert.equal(timer.after, null);
  assert.deepEqual(timer.removed.map((e) => e.nodeId), ['read', 'send']);
  assert.deepEqual(h.stats(), before);
  assert.deepEqual(requests, []);
  assert.deepEqual(operate('publisher', { op: 'audit' }), []);
  assert.deepEqual(await h.history.list(flow.id), []);
  const fresh = setup(t).h.comparePublication(draft);
  assert.equal(fresh.activeRevision, null);
  assert.equal(fresh.changes[0].before, null);
  const dispatch = async () => {
    const id = h.accept(flow.id, 'hook', { items: [{ json: {} }] });
    await until(() => h.receipt(id).outcome === 'success');
    return requests.splice(0).filter(([method]) => method === 'POST');
  };
  assert.deepEqual(await dispatch(), hook.removed.map(expectedRequest));
  h.activate(flow.id, 2);
  assert.deepEqual(await dispatch(), hook.added.map(expectedRequest));
  const renamed = structuredClone(draft);
  renamed.nodes.find((n) => n.id === 'send').name = 'Other label';
  assert.deepEqual(h.comparePublication(renamed).changes, []);
  const moved = structuredClone(draft);
  moved.nodes.find((n) => n.id === 'hook').parameters.path = 'new-orders';
  const [changed] = h.comparePublication(moved).changes;
  assert.deepEqual([changed.before.path, changed.after.path, changed.added, changed.removed],
    ['/webhook/orders', '/webhook/new-orders', [], []]);
  h.deactivate(flow.id);
  assert.equal(h.comparePublication(draft).activeRevision, null);
});

test('comparison distinguishes pinned child and compensation revisions', (t) => {
  const { h } = setup(t);
  const child = fixture('process-order-batch'), parent = fixture('order-import');
  h.publish(child);
  h.activate(parent.id, h.publish(parent));
  child.nodes[1].parameters.url = 'https://sink.example.test/changed';
  parent.nodes[1].parameters.revision = h.publish(child);
  const [page] = h.comparePublication(parent).changes;
  assert.deepEqual(page.removed.map((e) => [e.phase, e.workflowId, e.revision]), [['execution', child.id, 1]]);
  assert.deepEqual(page.added.map((e) => [e.phase, e.workflowId, e.revision]), [['execution', child.id, 2]]);
  let draft;
  publishCompensations(h, false, false, (flow) => { draft = structuredClone(flow); });
  child.id = 'refund';
  draft.nodes.find((n) => n.id === 'charge').parameters.compensation.revision = h.publish(child);
  const [undo] = h.comparePublication(draft).changes;
  assert.deepEqual(undo.removed.map((e) => [e.phase, e.workflowId, e.revision]), [['compensation', 'refund', 1]]);
  assert.deepEqual(undo.added.map((e) => [e.phase, e.workflowId, e.revision]), [['compensation', 'refund', 2]]);
});
