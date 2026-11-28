import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { createOperatorServer } from '../dist/operator-http.js';
import { until } from './fixture.mjs';
import { publish as compensationFlow, accept } from './compensation-fixture.mjs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL('../../../examples/' + name + '.json', import.meta.url)));
const flow = fixture('order-import');
flow.nodes = [flow.nodes[0]];
flow.connections = [];
const write = fixture('process-order-batch').nodes[1];
const registry = new NodeRegistry().registerAll(standardNodes);
function setup(t, sink = async () => Response.json({}), resolveCredential) {
  const dir = mkdtempSync(join(tmpdir(), 'df-ops-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hosts = ['alpha', 'beta'].map((suffix) => {
    const organization = dir.split('/').pop() + '-' + suffix;
    const h = new NodeHost(join(dir, suffix), {
      organization,
      registry,
      fetch: sink,
      httpAuth: {
        organization,
        grants: [
          ['order-import', 'ship'],
          ['release', 'register'],
        ].map(([id, nodeId]) => ({
          id,
          nodeId,
          workflowId: id,
          origin: 'https://sink.example.test',
          kind: 'bearer',
        })),
        versions: { release: ['rotated'] },
        resolve:
          resolveCredential ??
          ((id, version) => (id === 'release' ? (version ?? 'only') + '-' + organization : undefined)),
      },
      ...(process.env.DRAFLOW_TEST_POSTGRES && {
        shared: { organization, connectionString: process.env.DRAFLOW_TEST_POSTGRES, pollMs: 50 },
      }),
    });
    t.after(() => h.close());
    return h;
  });
  return { hosts, dir };
}
const identity = (host, role = 'admin') => ({ organization: host.organization, actor: role, role });
const command = (op, target, extra = {}) => ({
  op,
  target,
  reason: 'incident-recovery',
  request: randomUUID(),
  ...extra,
});

test('event resume disappears at its deadline before the scheduler settles the wait', async (t) => {
  let now = Date.now();
  const organization = randomUUID();
  const h = new NodeHost(':memory:', {
    organization, registry, scheduleClock: { now: () => now, arm: () => () => {} },
    ...(process.env.DRAFLOW_TEST_POSTGRES && {
      shared: { organization, connectionString: process.env.DRAFLOW_TEST_POSTGRES, role: 'worker', pollMs: 50 },
    }),
  });
  t.after(() => h.close());
  const wait = structuredClone(flow);
  const dueAt = now + 60000;
  wait.nodes.push({ ...write, id: 'wait', type: 'draflow.wait', typeVersion: 1, parameters: { mode: 'event', dueAt } });
  wait.connections = [{ id: 'edge', from: { node: 'schedule', port: 'main', index: 0 }, to: { node: 'wait', port: 'main', index: 0 } }];
  h.activate(wait.id, h.publish(wait));
  const id = h.accept(wait.id, 'schedule', { items: [{ json: {} }] });
  await until(() => h.receipt(id).state === 'waiting');
  const detail = () => h.operate(identity(h), { op: 'detail', id });
  now = dueAt - 1;
  const before = detail();
  assert.ok(before.guidance.actions.some((a) => a.op === 'resume'));
  now = dueAt;
  assert.throws(() => h.operate(identity(h), command('resume', id, { version: before.version })), (e) => e.status === 409);
  assert.deepEqual(detail().guidance, { reason: 'eventExpired', actions: [{ op: 'cancel' }] });
});

test('recovery candidates require the pinned compensation child to be installed on this host', async (t) => {
  const {
    hosts: [original], dir,
  } = setup(t);
  compensationFlow(original);
  const id = accept(original);
  await until(() => original.receipt(id).outcome === 'error');
  const detail = (h) => h.operate(identity(h), { op: 'detail', id });
  const before = detail(original);
  assert.deepEqual(before.guidance.actions.map((a) => a.op), ['redrive', 'compensate']);
  original.deactivate('order-import');
  await original.close();
  const organization = original.organization;
  const h = new NodeHost(join(dir, 'alpha'), {
    organization,
    registry: new NodeRegistry().registerAll(standardNodes.filter((n) => n.type !== 'draflow.childInput')),
    ...(process.env.DRAFLOW_TEST_POSTGRES && {
      shared: { organization, connectionString: process.env.DRAFLOW_TEST_POSTGRES, role: 'intake' },
    }),
  });
  t.after(() => h.close());
  const current = detail(h);
  const stale = command('compensate', id, { version: before.version });
  assert.throws(() => h.operate(identity(h), stale), (err) => err.status === 409);
  for (const { op, failure } of before.guidance.actions)
    assert.throws(() => h.operate(identity(h), command(op, id, { version: current.version, failure })),
      /requires draflow.childInput@1/);
  assert.deepEqual(current.guidance, { reason: 'publicationUnavailable', actions: [] });
});

test('authorization on every request, across organizations and roles', async (t) => {
  const { hosts } = setup(t);
  const accounts = [],
    tokens = new Map();
  for (const h of hosts)
    for (const role of ['viewer', 'operator', 'publisher', 'admin']) {
      const token = randomUUID(),
        account = identity(h, role);
      accounts.push({ ...account, sha256: createHash('sha256').update(token).digest('hex') });
      tokens.set(h.organization + role, token);
    }
  const api = createOperatorServer(hosts, () => accounts);
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => api.close(r)));
  const call = (h, role, q, org = h.organization) =>
    fetch('http://127.0.0.1:' + api.address().port + '/operator/' + org + '/api', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + tokens.get(h.organization + role),
        'content-type': 'application/json',
      },
      body: JSON.stringify(q),
    });
  for (const h of hosts) {
    const other = hosts.find((o) => o !== h);
    h.activate(flow.id, h.publish(flow));
    const id = h.accept(flow.id, 'schedule', { items: [{ json: { hidden: 'private-payload' } }] });
    await until(() => h.receipt(id).state === 'finished');
    for (const role of ['viewer', 'operator', 'publisher', 'admin']) {
      for (const op of ['list', 'detail', 'audit', 'metrics', 'session', 'history'])
        assert.equal((await call(h, role, { op, id, workflow: flow.id })).status, 200);
      assert.equal((await call(other, role, { op: 'detail', id })).status, 404);
      assert.equal((await call(h, role, { op: 'list' }, other.organization)).status, 403);
      for (const op of [
        'publish',
        'activate',
        'start',
        'resume',
        'cancel',
        'redrive',
        'compensate',
        'retryCompensation',
        'reconcile',
        'membership',
        'credentials',
      ]) {
        const allowed =
          role === 'admin' ||
          (role === 'publisher' && ['publish', 'activate'].includes(op)) ||
          (role === 'operator' && ['start', 'resume', 'cancel', 'redrive'].includes(op));
        const response = await call(h, role, command(op, 'missing'));
        assert.equal(response.status !== 403, allowed, role + ' ' + op);
      }
    }
    const detail = await (await call(h, 'viewer', { op: 'detail', id })).text();
    assert.ok(!detail.includes('private-payload'));
    const grant = command('membership', 'operator', { policy: { role: 'operator', grants: ['reconcile'] } });
    assert.equal((await call(h, 'admin', grant)).status, 200);
    assert.equal((await call(h, 'operator', command('reconcile', 'unknown'))).status, 404);
    assert.equal(
      (await call(h, 'admin', command('membership', 'operator', { policy: { role: 'disabled' } }))).status,
      200,
    );
    assert.equal((await call(h, 'operator', { op: 'list' })).status, 403);
    assert.equal((await call(h, 'admin', command('credentials', 'release', { enabled: false }))).status, 200);
    assert.equal((await call(h, 'admin', command('credentials', 'release', { enabled: true }))).status, 200);
    await call(h, 'admin', command('membership', 'operator', { policy: { role: 'operator' } }));
  }
});
test('reconciliation and compensation requests are durable and apply once', async (t) => {
  const sends = [];
  const {
    hosts: [h],
  } = setup(t, async (url) => {
    sends.push(new URL(url).pathname);
    if (url.endsWith('/unknown')) throw Error('secret provider error');
    return Response.json({ id: 'receipt' });
  });
  const admin = identity(h);
  const invoke = (q) => h.operate(admin, q);
  const reconciliation = structuredClone(flow);
  reconciliation.id = 'unknown';
  const n = {
    ...write,
    parameters: { ...write.parameters, delivery: 'manual', url: 'https://sink.example.test/unknown' },
  };
  reconciliation.nodes.push(n);
  reconciliation.connections = [
    {
      id: 'edge',
      from: { node: 'schedule', port: 'main', index: 0 },
      to: { node: n.id, port: 'main', index: 0 },
    },
  ];
  const pub = command('publish', reconciliation.id, { workflow: reconciliation });
  assert.equal(invoke(pub), invoke(pub));
  invoke(command('activate', reconciliation.id, { revision: 1 }));
  const run = invoke(command('start', reconciliation.id, { trigger: 'schedule' }));
  await until(() => h.receipt(run).state === 'review');
  const detail = invoke({ op: 'detail', id: run });
  assert.equal(detail.guidance.reason, 'review');
  assert.deepEqual(detail.guidance.actions, [
    { op: 'reconcile', key: detail.effects[0].key, node: n.id, decisions: ['applied', 'notApplied'] },
    { op: 'cancel' },
  ]);
  assert.deepEqual(h.operate(identity(h, 'viewer'), { op: 'detail', id: run }).guidance,
    { reason: 'review', actions: [] });
  const action = command('reconcile', run, {
    version: detail.version,
    key: detail.effects[0].key,
    decision: 'applied',
    reason: 'receiver-confirmed',
  });
  const operator = identity(h, 'operator');
  invoke(command('membership', operator.actor, { policy: { role: 'operator', grants: ['reconcile'] } }));
  assert.deepEqual(h.operate(operator, { op: 'detail', id: run }).guidance, detail.guidance);
  invoke(command('membership', operator.actor, { policy: { role: 'operator' } }));
  assert.throws(() => h.operate(operator, action), (error) => error.status === 403);
  assert.deepEqual(h.operate(operator, { op: 'detail', id: run }).guidance.actions, [{ op: 'cancel' }]);
  assert.ok(invoke(action));
  assert.ok(invoke(action));
  assert.throws(
    () => invoke({ ...action, request: randomUUID(), decision: 'notApplied' }),
    (e) => e.status === 409,
  );
  await until(() => h.receipt(run).outcome === 'success');
  assert.deepEqual(invoke({ op: 'detail', id: run }).guidance, { reason: 'success', actions: [] });
  compensationFlow(h);
  const root = accept(h);
  await until(() => h.receipt(root).outcome === 'error');
  const compensate = command('compensate', root, { version: invoke({ op: 'detail', id: root }).version });
  assert.equal(invoke(compensate), invoke(compensate));
  await until(() => h.compensationInfo(root).state === 'compensated');
  assert.deepEqual(sends, ['/unknown', '/reserve', '/charge', '/refund', '/release']);
  await h.history.delete('unknown', run);
  const audit = invoke({ op: 'audit' });
  assert.equal(audit.filter((x) => x.action === 'reconcile' && JSON.parse(x.result) === true).length, 1);
  assert.equal(audit.filter((x) => x.action === 'compensate').length, 1);
  assert.equal(
    audit.find((x) => x.action === 'reconcile' && JSON.parse(x.result) === true).reason,
    'receiver-confirmed',
  );
  for (let i = 0; i < 102; i++) {
    invoke(command('membership', 'audit-user', { policy: { role: 'viewer' } }));
  }
  const first = invoke({ op: 'audit', target: 'audit-user' });
  const last = first.at(-1);
  const older = invoke({ op: 'audit', target: 'audit-user', before: last.stamp, afterRequest: last.request });
  assert.equal(first.length, 100);
  assert.equal(older.length, 2);
  assert.equal(new Set([...first, ...older].map((row) => row.request)).size, 102);
});

test(
  'worker loss alerts identify the queued run and clear after a replacement finishes',
  { skip: !process.env.DRAFLOW_TEST_POSTGRES },
  async (t) => {
    const shared = {
      organization: randomUUID(),
      connectionString: process.env.DRAFLOW_TEST_POSTGRES,
      pollMs: 60,
    };
    const open = (role) => new NodeHost('', { registry, shared: { ...shared, role } });
    const intake = open('intake');
    t.after(() => intake.close());
    const worker = open('worker');
    t.after(() => worker.close());
    intake.activate(flow.id, intake.publish(flow));
    await until(() => intake.operatorMetrics().lastHeartbeat !== null);
    await worker.close();
    const run = intake.accept(flow.id, 'schedule', { items: [{ json: {} }] });
    const events = [];
    const srv = createOperatorServer(
      [intake],
      () => [],
      1000,
      (a) => events.push(a),
    );
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => srv.close(r)));
    const last = intake.operatorMetrics().lastHeartbeat;
    await until(() => events.some((e) => e.active && e.kind === 'heartbeat' && e.run === run));
    assert.ok(Date.now() - last < 1700);
    const next = open('worker');
    t.after(() => next.close());
    await until(
      () =>
        intake.receipt(run).outcome === 'success' &&
        events.some((e) => !e.active && e.kind === 'heartbeat' && e.run === run),
    );
  },
);
test('a wait token, a webhook signature and credentials are scoped to the organization', async (t) => {
  const requests = [];
  const { hosts } = setup(t, async (url, init) => {
    requests.push(new Headers(init.headers).get('authorization'));
    return Response.json({});
  });
  const servers = [];
  for (const h of hosts) {
    const hook = structuredClone(flow);
    hook.nodes[0].type = 'draflow.webhook';
    hook.nodes[0].parameters = { path: 'orders' };
    h.activate(hook.id, h.publish(hook));
    const { createWebhookServer } = await import('../dist/webhook.js');
    const srv = createWebhookServer(h, { signingKey: 'signing-' + h.organization });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => srv.close(r)));
    servers.push('http://127.0.0.1:' + srv.address().port);
  }
  const [a, b] = hosts;
  const { createHmac } = await import('node:crypto');
  const signature = createHmac('sha256', 'signing-' + a.organization)
    .update('/webhook/orders\nkey\n{}')
    .digest('hex');
  const opts = {
    method: 'POST',
    headers: { 'x-draflow-delivery': 'key', 'x-draflow-signature': 'sha256=' + signature },
    body: '{}',
  };
  assert.equal((await fetch(servers[1] + '/webhook/orders', opts)).status, 401);
  assert.equal(b.stats().queued, 0);
  const waits = [];
  for (const h of hosts) {
    const wait = structuredClone(flow);
    wait.id = 'wait';
    const step = {
      ...write,
      id: 'wait',
      type: 'draflow.wait',
      typeVersion: 1,
      parameters: { mode: 'event', dueAt: Date.now() + 30000 },
    };
    wait.nodes.push(step);
    wait.connections = [
      {
        id: 'go',
        from: { node: 'schedule', port: 'main', index: 0 },
        to: { node: 'wait', port: 'main', index: 0 },
      },
    ];
    h.activate(wait.id, h.publish(wait));
    const run = h.accept(wait.id, 'schedule', { items: [{ json: {} }] });
    await until(() => h.receipt(run).state === 'waiting');
    waits.push({ run, token: h.waitInfo(run).token });
    const data = h.operate(identity(h), { op: 'detail', id: run });
    assert.ok(!JSON.stringify(data).includes(h.waitInfo(run).token));
    const cred = structuredClone(wait);
    cred.id = 'release';
    cred.nodes[1] = {
      ...write,
      credentials: { httpAuth: 'release' },
      parameters: { ...write.parameters, authentication: 'credential' },
    };
    cred.connections[0].to.node = write.id;
    h.activate(cred.id, h.publish(cred));
    const send = h.accept(cred.id, 'schedule', { items: [{ json: {} }] });
    await until(() => h.receipt(send).outcome === 'success');
  }
  assert.deepEqual(
    requests,
    hosts.map((h) => 'Bearer only-' + h.organization),
  );
  assert.equal(
    (
      await fetch(servers[1] + '/resume/' + waits[1].run, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + waits[0].token },
        body: '{}',
      })
    ).status,
    404,
  );
  assert.equal(b.receipt(waits[1].run).state, 'waiting');
  b.operate(identity(b), command('credentials', 'release', { enabled: false }));
  const blocked = b.accept('release', 'schedule', { items: [{ json: {} }] });
  await until(() => ['review', 'finished'].includes(b.receipt(blocked).state));
  assert.equal(requests.length, 2);
  b.operate(identity(b), command('credentials', 'release', { enabled: true, credentialVersion: 'rotated' }));
  const rotated = b.accept('release', 'schedule', { items: [{ json: {} }] });
  await until(() => b.receipt(rotated).outcome === 'success');
  assert.equal(requests.at(-1), 'Bearer rotated-' + b.organization);
  assert.ok(!JSON.stringify(b.operate(identity(b), { op: 'audit' })).includes('rotated-' + b.organization));
});

test('audit write failure rolls back publication and an accepted redrive survives restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'df-ops-atomic-')),
    organization = randomUUID(),
    path = join(dir, 'ledger.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shared = process.env.DRAFLOW_TEST_POSTGRES
    ? { organization, connectionString: process.env.DRAFLOW_TEST_POSTGRES, pollMs: 50 }
    : undefined;
  const writes = [];
  let available = false;
  const boot = () =>
    new NodeHost(path, {
      registry,
      organization,
      shared,
      httpAuth: {
        organization,
        grants: [
          ['order-import', 'ship'],
          ['release', 'register'],
        ].map(([workflowId, nodeId]) => ({
          id: workflowId,
          nodeId,
          workflowId,
          kind: 'bearer',
          origin: 'https://sink.example.test',
        })),
        resolve: () => (available ? 'private-secret' : undefined),
      },
      fetch: async (url) => {
        writes.push(new URL(url).pathname);
        return Response.json({ id: 'receipt' });
      },
    });
  let h = boot();
  t.after(() => h.close());
  await h.close();
  const { DatabaseSync } = await import('node:sqlite');
  const { PostgresDatabase } = await import('../dist/postgres.js');
  function alter(install) {
    if (shared) {
      const db = new PostgresDatabase(shared);
      try {
        db.raw(
          install
            ? "ALTER TABLE operator_audit ADD CONSTRAINT reject_audit CHECK(action NOT IN ('publish','release') OR request LIKE 'rejected:%')"
            : 'ALTER TABLE operator_audit DROP CONSTRAINT reject_audit',
        );
      } finally {
        db.close();
      }
    } else {
      const db = new DatabaseSync(path);
      try {
        db.exec(
          install
            ? "CREATE TRIGGER reject_audit BEFORE INSERT ON operator_audit WHEN NEW.request NOT LIKE 'rejected:%' BEGIN SELECT RAISE(ABORT,'audit failed'); END"
            : 'DROP TRIGGER reject_audit',
        );
      } finally {
        db.close();
      }
    }
  }
  alter(true);
  h = boot();
  const pub = command('publish', flow.id, { workflow: flow });
  assert.throws(() => h.operate(identity(h), pub));
  const orders = fixture('order-sync');
  h.activate(orders.id, h.publish(orders));
  const route = h.webhook('/webhook/orders');
  orders.nodes.find((n) => n.id === 'hook').parameters.path = 'new-orders';
  const release = command('release', orders.id, { workflow: orders, review: h.comparePublication(orders).review });
  assert.throws(() => h.operate(identity(h), release));
  assert.deepEqual(h.webhook('/webhook/orders'), route);
  assert.ok(!h.webhook('/webhook/new-orders'));
  const failures = h.operate(identity(h), { op: 'audit' }).filter((r) => r.action === 'release');
  assert.deepEqual(failures.map((r) => JSON.parse(r.result)), [{ status: 400 }]);
  await h.close();
  alter(false);
  h = boot();
  assert.equal(h.operate(identity(h), release), 2);
  await h.close();
  h = boot();
  assert.equal(h.operate(identity(h), release), 2);
  assert.equal(h.webhook('/webhook/new-orders').revision, 2);
  assert.equal(h.operate(identity(h), { op: 'audit' }).filter((r) => r.request === release.request).length, 1);
  assert.equal(h.operate(identity(h), pub), 1);
  compensationFlow(h);
  const run = accept(h);
  await until(() => h.receipt(run).outcome === 'error');
  const before = h.operate(identity(h), { op: 'detail', id: run });
  assert.equal(before.guidance.reason, 'recoverableFailure');
  assert.ok(before.guidance.actions.some((a) => a.op === 'redrive' &&
    a.failure === before.recovery[0].failure && a.node === before.recovery[0].node));
  const retry = command('redrive', run, { version: before.version, failure: before.recovery[0].failure });
  available = true;
  const attempt = h.operate(identity(h), retry);
  assert.equal(h.operate(identity(h), retry), attempt);
  await until(() => h.receipt(run).outcome === 'success');
  await h.close();
  h = boot();
  assert.equal(h.operate(identity(h), retry), attempt);
  assert.equal(h.operate(identity(h), { op: 'detail', id: attempt }).run.runId, run);
  assert.deepEqual(writes, ['/reserve', '/charge', '/ship']);
  assert.equal(h.operate(identity(h), { op: 'audit' }).filter((a) => a.action === 'redrive').length, 1);
});

test('a reused HTTP connection takes its organization and principal from each request', async (t) => {
  const {
    hosts: [a, b],
  } = setup(t);
  const keys = [randomUUID(), randomUUID()];
  const srv = createOperatorServer([a, b], () =>
    [a, b].map((h, i) => ({
      ...identity(h, 'viewer'),
      sha256: createHash('sha256').update(keys[i]).digest('hex'),
    })),
  );
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        srv.close(r);
        srv.closeAllConnections();
      }),
  );
  const { Agent, request } = await import('node:http');
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const read = (h, i) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          agent,
          hostname: '127.0.0.1',
          port: srv.address().port,
          path: '/operator/' + h.organization + '/api?op=list',
          headers: { authorization: 'Bearer ' + keys[i] },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (s) => (body += s));
          res.on('end', () =>
            resolve({ code: res.statusCode, reused: req.reusedSocket, rows: JSON.parse(body) }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  a.activate(flow.id, a.publish(flow));
  const run = a.accept(flow.id, 'schedule', { items: [{ json: {} }] });
  assert.equal((await read(a, 0)).rows[0].runId, run);
  assert.deepEqual(await read(b, 1), { code: 200, reused: true, rows: [] });
  assert.equal((await read(a, 1)).code, 403);
});
test('a publisher pins children locally and an operator resumes or cancels only their own waits', async (t) => {
  const sends = [];
  const { hosts } = setup(t, async (url, init) => {
    sends.push(JSON.parse(init.body).id);
    return Response.json({});
  });
  const runs = [];
  for (const h of hosts) {
    const publish = (w) => h.operate(identity(h, 'publisher'), command('publish', w.id, { workflow: w }));
    const child = fixture('process-order-batch');
    publish(child);
    const parent = structuredClone(flow);
    parent.nodes.push({
      ...write,
      id: 'call',
      type: 'draflow.call',
      typeVersion: 1,
      parameters: { workflowId: child.id, revision: 1 },
    });
    parent.connections = [
      {
        id: 'go',
        from: { node: 'schedule', port: 'main', index: 0 },
        to: { node: 'call', port: 'main', index: 0 },
      },
    ];
    h.operate(identity(h, 'publisher'), command('activate', parent.id, { revision: publish(parent) }));
    const root = h.operate(identity(h, 'operator'), command('start', parent.id, { trigger: 'schedule' }));
    await until(() => h.receipt(root).state === 'finished');
    assert.equal(h.receipt(root).outcome, 'success');
    const children = h.operate(identity(h, 'viewer'), { op: 'detail', id: root }).calls;
    assert.equal(children.length, 1);
    assert.ok(h.receipt(children[0].child));
    const wait = structuredClone(parent);
    wait.id = 'await';
    wait.nodes[1] = {
      ...write,
      id: 'call',
      type: 'draflow.wait',
      typeVersion: 1,
      parameters: { mode: 'event', dueAt: Date.now() + 60000 },
    };
    h.operate(identity(h, 'publisher'), command('activate', wait.id, { revision: publish(wait) }));
    const id = h.operate(identity(h, 'operator'), command('start', wait.id, { trigger: 'schedule' }));
    await until(() => h.receipt(id).state === 'waiting');
    assert.deepEqual(h.operate(identity(h, 'operator'), { op: 'detail', id }).guidance, {
      reason: 'awaitingEvent', actions: [{ op: 'resume' }, { op: 'cancel' }],
    });
    runs.push(id);
  }
  assert.equal(sends.length, 2);
  for (const [i, h] of hosts.entries()) {
    const op = i ? 'cancel' : 'resume',
      id = runs[i],
      version = h.operate(identity(h), { op: 'detail', id }).version;
    const action = command(op, id, { version });
    const foreign = hosts[1 - i];
    assert.throws(
      () => foreign.operate(identity(foreign, 'operator'), action),
      (e) => e.status === 404,
    );
    assert.ok(h.operate(identity(h, 'operator'), action));
    assert.ok(h.operate(identity(h, 'operator'), action));
    await until(() => h.receipt(id).state === 'finished');
    assert.equal(h.receipt(id).outcome, i ? 'canceled' : 'success');
  }
});

test(
  'cutover preserves operator revocation, audit and committed request identity',
  { skip: !process.env.DRAFLOW_TEST_POSTGRES },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-cutover-')),
      path = join(dir, 'ledger.db'),
      organization = randomUUID();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const shared = { organization, connectionString: process.env.DRAFLOW_TEST_POSTGRES, role: 'intake' };
    let sends = 0;
    const fetch = async () => {
      sends++;
      throw Error('unknown receiver outcome');
    };
    let h = new NodeHost(path, { organization, registry, fetch });
    t.after(() => h.close());
    const published = command('publish', flow.id, { workflow: flow });
    assert.equal(h.operate(identity(h), published), 1);
    const inactiveReview = h.comparePublication(flow).review;
    h.activate(flow.id, 1);
    h.deactivate(flow.id);
    const latestReview = h.comparePublication(flow).review;
    assert.notEqual(latestReview, inactiveReview);
    h.operate(identity(h), command('membership', 'viewer', { policy: { role: 'disabled' } }));
    const delivery = structuredClone(flow);
    delivery.id = 'cutover-delivery';
    delivery.nodes.push({ ...write, parameters: { ...write.parameters, delivery: 'manual' } });
    delivery.connections = [
      {
        id: 'next',
        from: { node: 'schedule', port: 'main', index: 0 },
        to: { node: write.id, port: 'main', index: 0 },
      },
    ];
    h.activate(delivery.id, h.publish(delivery));
    const id = h.accept(delivery.id, 'schedule', { items: [{ json: {} }] });
    await until(() => h.receipt(id).state === 'review');
    const effect = h.effects(id)[0].key;
    await h.close();
    const { migrateLedger } = await import('../dist/migrate.js');
    const first = migrateLedger(path, shared);
    assert.equal(first.counts.operator_audit, 2);
    assert.equal(first.counts.inactive_registrations, 1);
    assert.deepEqual(migrateLedger(path, shared), first);
    h = new NodeHost('', { registry, fetch, shared: { ...shared, role: 'all' } });
    assert.equal(h.comparePublication(flow).review, latestReview);
    assert.equal(h.operate(identity(h), published), 1);
    assert.throws(
      () => h.operate(identity(h, 'viewer'), { op: 'list' }),
      (e) => e.status === 403,
    );
    assert.equal(h.operate(identity(h), { op: 'audit' }).length, 2);
    const detail = h.operate(identity(h), { op: 'detail', id });
    assert.equal(detail.run.status, 'review');
    assert.equal(detail.effects[0].key, effect);
    assert.equal(h.operatorMetrics().reviewRun, id);
    const decision = command('reconcile', id, { version: detail.version, key: effect, decision: 'applied' });
    assert.equal(h.operate(identity(h), decision), true);
    assert.equal(h.operate(identity(h), decision), true);
    await until(() => h.receipt(id).outcome === 'success');
    assert.equal(sends, 1);
  },
);

test('status filters distinguish a throttled page and expose compensation failures next to the original outcome', async (t) => {
  let undoHeld, finishUndo;
  const pendingUndo = new Promise((r) => {
    finishUndo = r;
  });
  t.after(() => finishUndo());
  const {
    hosts: [h],
  } = setup(t, async (url) => {
    if (url.includes('.source.example.test'))
      return new Response(null, { status: 429, headers: { 'retry-after': '5' } });
    if (url.endsWith('/refund')) {
      undoHeld = true;
      await pendingUndo;
    }
    return Response.json({ id: 'upstream' });
  });
  const page = fixture('order-import');
  page.nodes[1].parameters.url = 'https://' + h.organization + '.source.example.test/orders';
  h.publish(fixture('process-order-batch'));
  h.activate(page.id, h.publish(page));
  const throttled = h.accept(page.id, 'schedule', { items: [{ json: {} }] });
  await until(() => h.progress(throttled)[0]?.retryAt > 0);
  const read = (q) => h.operate(identity(h, 'viewer'), q);
  assert.equal(
    read({
      op: 'list',
      status: 'throttled',
      workflow: page.id,
      revision: 1,
      from: 0,
      to: Date.now() + 1000,
    })[0].runId,
    throttled,
  );
  assert.deepEqual(read({ op: 'detail', id: throttled }).guidance, { reason: 'throttled', actions: [] });
  assert.equal(read({ op: 'list', status: 'waiting' }).length, 0);
  h.cancel(throttled);
  compensationFlow(h);
  const root = accept(h);
  await until(() => h.receipt(root).outcome === 'error');
  // The first undo is held so the root and its active child can be inspected together.
  h.operate(identity(h), command('credentials', 'release', { enabled: false }));
  h.compensate(root);
  try {
    await until(() => undoHeld);
    assert.equal(read({ op: 'list', status: 'compensating' })[0].runId, root);
  } finally {
    finishUndo();
  }
  await until(() => h.compensationInfo(root).state === 'manual');
  assert.equal(read({ op: 'list', status: 'manual' })[0].outcome, 'error');
  assert.equal(read({ op: 'metrics' }).compensationFailures, 1);
  const manual = h.operate(identity(h), { op: 'detail', id: root });
  const failure = manual.compensation.steps.find((step) => step.status === 'failed').failure;
  assert.deepEqual(manual.guidance, { reason: 'manual', actions: [{ op: 'retryCompensation', failure }] });
  const retry = command('retryCompensation', root, { failure, version: manual.version });
  assert.throws(() => h.operate(identity(h, 'viewer'), retry), (err) => err.status === 403);
  h.operate(identity(h), command('credentials', 'release', { enabled: true }));
  const attempt = h.operate(identity(h), retry);
  await until(() => h.compensationInfo(root).state === 'compensated');
  assert.equal(h.operate(identity(h), retry), attempt);
  assert.deepEqual(h.operate(identity(h), { op: 'detail', id: root }).guidance.actions, []);
});

test('operator start and trigger deliveries have separate idempotency domains', async (t) => {
  const {
    hosts: [h],
  } = setup(t);
  h.activate(flow.id, h.publish(flow));
  const start = command('start', flow.id, { trigger: 'schedule' });
  const external = h.accept(flow.id, 'schedule', { key: start.request, items: [{ json: {} }] });
  const manual = h.operate(identity(h, 'operator'), start);
  assert.notEqual(manual, external);
  assert.equal(h.operate(identity(h, 'operator'), start), manual);
  assert.equal(h.byEvent(flow.id, 'schedule', start.request, 'trigger').runId, external);
});

test('revocation during asynchronous credential resolution prevents dispatch', async (t) => {
  let unblock,
    resolving = false,
    sends = 0;
  const secret = new Promise((resolve) => {
    unblock = resolve;
  });
  const {
    hosts: [h],
  } = setup(
    t,
    async () => {
      sends++;
      return Response.json({});
    },
    async () => {
      resolving = true;
      return secret;
    },
  );
  const definition = structuredClone(flow);
  definition.id = 'release';
  definition.nodes.push({
    ...write,
    credentials: { httpAuth: 'release' },
    parameters: { ...write.parameters, authentication: 'credential' },
  });
  definition.connections = [
    {
      id: 'next',
      from: { node: 'schedule', port: 'main', index: 0 },
      to: { node: write.id, port: 'main', index: 0 },
    },
  ];
  h.activate(definition.id, h.publish(definition));
  const run = h.accept(definition.id, 'schedule', { items: [{ json: {} }] });
  try {
    await until(() => resolving);
    h.operate(identity(h), command('credentials', 'release', { enabled: false }));
  } finally {
    unblock('obsolete');
  }
  await until(() => ['review', 'finished'].includes(h.receipt(run).state));
  assert.notEqual(h.receipt(run).outcome, 'success');
  assert.equal(sends, 0);
});
