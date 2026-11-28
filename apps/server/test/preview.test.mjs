import assert from 'node:assert/strict';
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

test('paged child effects use the pinned organization-local revision', (t) => {
  const { h } = setup(t), other = setup(t).h;
  const parent = fixture('order-import'), child = fixture('process-order-batch');
  assert.throws(() => h.previewPublication(parent), /Unknown publication/);
  h.publish(child);
  const oldUrl = child.nodes[1].parameters.url;
  child.nodes[1].parameters.url = 'https://new.example.test/changed';
  h.publish(child);
  const effects = h.previewPublication(parent).triggers[0].effects;
  assert.deepEqual(effects.map((e) => [e.workflowId, e.revision, e.destination]), [
    [parent.id, null, parent.nodes[1].parameters.url], [child.id, 1, oldUrl],
  ]);
  assert.throws(() => other.previewPublication(parent), /Unknown publication/);
});

test('possible reversals are distinct from forward writes', (t) => {
  const { h } = setup(t);
  let draft;
  publishCompensations(h, false, false, (flow) => { draft = structuredClone(flow); });
  const effects = h.previewPublication(draft).triggers[0].effects;
  assert.deepEqual(effects.filter((e) => e.phase === 'execution').map((e) => e.nodeId), ['reserve', 'charge', 'ship']);
  assert.deepEqual(effects.filter((e) => e.phase === 'compensation').map((e) => [e.workflowId, e.revision, e.kind]),
    [['release', 1, 'write'], ['refund', 1, 'write'], ['void', 1, 'write']]);
});
