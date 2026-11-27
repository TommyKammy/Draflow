import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost, WebhookGone } from '../dist/host.js';
import { migrateLedger } from '../dist/migrate.js';
import { until } from './fixture.mjs';
const url = process.env.DRAFLOW_TEST_POSTGRES;
const registry = new NodeRegistry().registerAll(standardNodes);
const script = fileURLToPath(new URL('./compensation-process.mjs', import.meta.url));
const example = JSON.parse(readFileSync(new URL('../../../examples/order-import.json', import.meta.url)));
function dir(t) {
  const p = mkdtempSync(join(tmpdir(), 'shared-ledger-'));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
test('logical organization owns its SQLite file', async (t) => {
  const path = join(dir(t), 'org.db');
  await new NodeHost(path, { registry, organization: 'a' }).close();
  assert.throws(() => new NodeHost(path, { registry, organization: 'b' }), /organization/);
  assert.throws(() => new NodeHost(path, { registry }), /organization/);
});
test('shared ledger separates identical workflow, event and credential names', { skip: !url }, async (t) => {
  const base = dir(t);
  const hosts = [];
  for (const org of ['a', 'b']) {
    const shared = { organization: base + org, connectionString: url };
    assert.throws(
      () =>
        new NodeHost('', {
          registry,
          shared,
          httpAuth: { organization: 'wrong', grants: [], resolve: () => '' },
        }),
      /organization/,
    );
    const h = new NodeHost('', { registry, shared });
    hosts.push(h);
    t.after(() => h.close());
    const w = { ...example, nodes: [example.nodes[0]], connections: [] };
    h.activate(w.id, h.publish(w));
  }
  const accept = (h) => h.accept(example.id, 'schedule', { key: 'same', items: [{ json: {} }] });
  const [a, b] = hosts.map(accept);
  assert.notEqual(a, b);
  assert.equal(accept(hosts[0]), a);
  assert.equal(hosts[1].receipt(a), undefined);
  assert.throws(() => hosts[1].compensate(a));
  const other = new PostgresDatabase({ organization: base + 'b', connectionString: url });
  try {
    assert.throws(
      () =>
        other.atomic(() =>
          other.raw("INSERT INTO compensations(root,id,state) VALUES($1,'foreign','pending')", [a]),
        ),
      /foreign key/i,
    );
  } finally {
    other.close();
  }
  await until(() => hosts[0].receipt(a).state === 'finished' && hosts[1].receipt(b).state === 'finished');
});
test('migrate interrupted compensation and replay duplicate request on PostgreSQL', { skip: !url }, (t) => {
  const db = join(dir(t), 'source.db');
  const run = (phase, env) =>
    spawnSync(process.execPath, [script, db, phase, 'keyed'], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ...env },
    });
  assert.equal(run('kill', { DRAFLOW_TEST_SHARED: '' }).signal, 'SIGKILL');
  const shared = { connectionString: url, organization: db };
  const first = migrateLedger(db, shared);
  assert.ok(first.counts.compensationSteps > 0);
  assert.deepEqual(migrateLedger(db, shared), first);
  const next = run('resume', { DRAFLOW_TEST_SHARED: url });
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(JSON.parse(next.stdout), ['reserve', 'charge', 'refund', 'release']);
});

import { SqliteLedger } from '../dist/sqlite.js';
import { OwnershipLost, PostgresDatabase } from '../dist/postgres.js';
import { setTimeout as delay } from 'node:timers/promises';

test(
  'expired generation cannot save a page, admit a child, send or finish after takeover',
  { skip: !url },
  async (t) => {
    const opts = { organization: dir(t), connectionString: url, leaseMs: 500 };
    const open = () => {
      const l = new SqliteLedger('', 4000000, 8, opts);
      t.after(() => l.close());
      return l;
    };
    const first = open(),
      replacement = open();
    const workflow = { ...example, nodes: [example.nodes[0]], connections: [] };
    first.publish(workflow);
    const id = first.accept(
      workflow.id,
      'schedule',
      { key: 'one', items: [{ json: {} }] },
      10,
      10000,
      () => {},
      1,
    );
    const job = first.claim();
    const token = { id, generation: job.generation };
    first.shared.lease.run(token, () =>
      first.beginJournal(
        { runId: id, stack: [{ nodeId: 'write', runIndex: 0, input: { main: [[]] } }] },
        'manual',
      ),
    );
    await delay(550);
    replacement.recover();
    const resumed = replacement.claim();
    assert.equal(resumed.receipt.runId, id);
    assert.ok(resumed.generation > job.generation);
    const node = example.nodes[1];
    first.shared.lease.run(token, () => {
      assert.throws(() => first.shared.checkDispatch(), OwnershipLost);
      assert.throws(() => first.dispatchChild(job.receipt, node), OwnershipLost);
      assert.throws(
        () => first.savePage(job.receipt, node, 0, { rows: [], next: null, token: null, bytes: 0 }),
        OwnershipLost,
      );
      assert.throws(
        () => first.finish(job.receipt, { status: 'success' }, { workflow, tasks: [] }),
        OwnershipLost,
      );
    });
    assert.equal(replacement.get(id).state, 'running');
    assert.equal(replacement.relations(id).length, 0);
  },
);

test(
  'migration rolls back partial import and preserves pending wait, manual review and failed redrive',
  { skip: !url },
  async (t) => {
    const base = dir(t),
      db = join(base, 'old.db'),
      shared = { organization: base, connectionString: url, role: 'all' };
    let allowed = false;
    const sent = [];
    const opts = {
      registry,
      httpAuth: {
        organization: base,
        grants: [
          {
            workflowId: 'failed',
            nodeId: 'write',
            id: 'service',
            origin: 'https://sink.test',
            kind: 'bearer',
          },
        ],
        resolve: () => (allowed ? 'long-local-secret' : undefined),
      },
      fetch: async (url) => {
        sent.push(url);
        if (url.endsWith('/unknown')) throw Error('response lost');
        return Response.json({ ok: true });
      },
    };
    const old = new NodeHost(db, { ...opts, organization: base });
    const begin = (h, id) => h.accept(id, 'schedule', { key: 'same', items: [{ json: {} }] });
    const wait = {
      ...example.nodes[1],
      type: 'draflow.wait',
      id: 'step',
      name: 'step',
      parameters: { mode: 'event', dueAt: Date.now() + 3600000 },
    };
    for (const [id, node] of [
      ['waiting', wait],
      ...['unknown', 'failed'].map((id) => [
        id,
        {
          ...example.nodes[1],
          id: 'write',
          name: 'write',
          type: 'draflow.httpRequest',
          typeVersion: 2,
          parameters: {
            url: 'https://sink.test/' + id,
            method: 'POST',
            delivery: 'manual',
            allowRedrive: true,
            ...(id === 'failed' && { authentication: 'credential' }),
          },
          ...(id === 'failed' && { credentials: { httpAuth: 'service' } }),
        },
      ]),
    ]) {
      const w = {
        ...example,
        id,
        nodes: [example.nodes[0], node],
        connections: [{ ...example.connections[0], to: { ...example.connections[0].to, node: node.id } }],
      };
      old.activate(id, old.publish(w));
    }
    const ids = ['waiting', 'unknown', 'failed'].map((i) => begin(old, i));
    await until(
      () =>
        old.receipt(ids[0]).state === 'waiting' &&
        old.receipt(ids[1]).state === 'review' &&
        old.receipt(ids[2]).state === 'finished',
    );
    const waitToken = old.waitInfo(ids[0]).token,
      key = old.effects(ids[1])[0].key,
      point = old.recoveryInfo(ids[2])[0];
    await old.close();
    const admin = new PostgresDatabase(shared);
    admin.raw("ALTER TABLE runs ADD CHECK (state <> 'review')");
    assert.throws(() => migrateLedger(db, shared), /check constraint/i);
    assert.equal(admin.raw('SELECT count(*) AS n FROM publications').rows[0].n, 0);
    admin.raw('ALTER TABLE runs DROP CONSTRAINT runs_state_check');
    admin.close();
    const rollback = new NodeHost(db, { ...opts, organization: base });
    assert.equal(rollback.waitInfo(ids[0]).token, waitToken);
    await rollback.close();
    assert.throws(
      () => migrateLedger(db, { ...shared, organization: base + '-other' }),
      /organization mismatch/,
    );
    migrateLedger(db, shared);
    const changed = new NodeHost(db, { ...opts, organization: base });
    changed.publish({ ...example, id: 'added-after-cutover', nodes: [example.nodes[0]], connections: [] });
    await changed.close();
    assert.throws(() => migrateLedger(db, shared), /Different source snapshot/);
    const h = new NodeHost('', { ...opts, shared });
    t.after(() => h.close());
    assert.deepEqual(
      ['waiting', 'unknown', 'failed'].map((i) => begin(h, i)),
      ids,
    );
    assert.ok(h.resolveWait(ids[0], waitToken, 'event', {}));
    assert.equal(h.resolveWait(ids[0], waitToken, 'event', {}), false);
    assert.ok(h.reconcile(ids[1], key, 'applied', { ok: true }));
    allowed = true;
    const attempt = h.redrive(ids[2], point.failure);
    assert.equal(h.redrive(ids[2], point.failure), attempt);
    await until(() => ids.every((id) => h.receipt(id).outcome === 'success'));
    assert.deepEqual(sent, ['https://sink.test/unknown', 'https://sink.test/failed']);
  },
);

test(
  'organization admission limits and a shared receiver account coordinate independent hosts',
  { skip: !url },
  async (t) => {
    const base = dir(t),
      origin = 'https://sink.test',
      times = [];
    let active = 0,
      peak = 0,
      limitedAt = 0;
    const open = (suffix) => {
      const org = base + suffix,
        id = 'order-service';
      const shared = {
        organization: org,
        connectionString: url,
        maxTargetRequests: 1,
        maxActiveRuns: 1,
        pollMs: 40,
        rateAccounts: { [id]: base },
      };
      const h = new NodeHost('', {
        registry,
        shared,
        httpAuth: {
          organization: org,
          grants: [{ workflowId: 'flow', nodeId: 'write', id, origin, kind: 'bearer' }],
          resolve: () => 'org-secret-' + suffix,
        },
        fetch: async (_url, init) => {
          assert.equal(new Headers(init.headers).get('authorization'), 'Bearer org-secret-' + suffix);
          times.push(Date.now());
          peak = Math.max(peak, ++active);
          await delay(25);
          active--;
          if (!limitedAt) {
            limitedAt = Date.now();
            return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
          }
          return Response.json({});
        },
      });
      t.after(() => h.close());
      const write = {
        ...example.nodes[1],
        id: 'write',
        name: 'write',
        type: 'draflow.httpRequest',
        typeVersion: 2,
        credentials: { httpAuth: id },
        parameters: {
          url: origin + '/shared',
          method: 'POST',
          delivery: 'keyed',
          authentication: 'credential',
        },
      };
      const w = {
        ...example,
        id: 'flow',
        nodes: [example.nodes[0], write],
        connections: [{ ...example.connections[0], to: { ...example.connections[0].to, node: 'write' } }],
      };
      h.activate(w.id, h.publish(w));
      return h;
    };
    const a = open('a'),
      b = open('b');
    const start = (h) => h.accept('flow', 'schedule', { items: [{ json: {} }] });
    const one = start(a);
    await until(() => a.receipt(one).state === 'review');
    const batch = Array.from({ length: 10 }, () => start(a));
    const short = { ...example, id: 'short', nodes: [example.nodes[0]], connections: [] };
    b.activate(short.id, b.publish(short));
    const quick = b.accept('short', 'schedule', { items: [{ json: {} }] });
    const other = start(b);
    await until(() => b.receipt(quick).state === 'finished');
    assert.ok(batch.some((id) => a.receipt(id).state !== 'finished'));
    await until(
      () => b.receipt(other).state === 'finished' && batch.every((id) => a.receipt(id).state === 'finished'),
    );
    assert.equal(peak, 1);
    assert.equal(times.length, 12);
    assert.ok(times.slice(1).every((ts) => ts >= limitedAt + 1000));
  },
);

test(
  'scheduler cursor and wait decisions reject stale observations from another session',
  { skip: !url },
  async (t) => {
    const opts = { organization: dir(t), connectionString: url };
    const a = new SqliteLedger('', 4000000, 8, opts),
      b = new SqliteLedger('', 4000000, 8, opts);
    t.after(() => {
      a.close();
      b.close();
    });
    const flow = { ...example, nodes: [example.nodes[0]], connections: [] };
    const rev = a.publish(flow);
    const at = a.shared.now() - 1000;
    a.activate(
      flow.id,
      rev,
      [],
      [{ triggerNodeId: 'schedule', spec: { mode: 'interval', intervalSeconds: 3600 }, nextAt: at }],
      () => {},
    );
    const dueA = a.dueSchedules(at)[0],
      dueB = b.dueSchedules(at)[0];
    assert.equal(dueA.nextAt, dueB.nextAt);
    const replacement = { mode: 'interval', intervalSeconds: 60 };
    const revised = structuredClone(flow);
    revised.nodes[0].parameters = replacement;
    b.activate(
      flow.id,
      b.publish(revised),
      [],
      [{ triggerNodeId: 'schedule', spec: replacement, nextAt: at }],
      () => {},
    );
    assert.equal(a.acceptSchedule(flow.id, 'schedule', at, at + 3600000, 10, dueA), undefined);
    assert.equal(a.stats().queued, 0);
    const current = a.dueSchedules(at)[0];
    const first = a.acceptSchedule(flow.id, 'schedule', at, at + 60000, 10, current);
    assert.ok(first);
    assert.equal(b.acceptSchedule(flow.id, 'schedule', at, at + 3600000, 10, dueB), undefined);
    assert.equal(a.stats().queued, 1);
    const job = a.claim();
    const deadline = at + 60000;
    a.shared.lease.run({ id: first, generation: job.generation }, () =>
      a.suspend(
        { runId: first, stack: [{ nodeId: 'wait', runIndex: 0 }], runData: {}, startedAt: at },
        { mode: 'event', dueAt: deadline },
        at,
      ),
    );
    const token = a.waitInfo(first).token;
    assert.equal(b.resolveWait(first, token, 'timer', {}, deadline), true);
    assert.equal(a.resolveWait(first, token, 'event', {}, deadline - 1), false);
    assert.equal(a.stats().queued, 1);
  },
);

test(
  'identical business IDs and versions advance independent organization cursors',
  { skip: !url },
  async (t) => {
    const base = dir(t);
    const keys = [];
    for (const organization of [base + 'a', base + 'b']) {
      const seen = [],
        writes = [];
      const h = new NodeHost('', {
        registry,
        shared: { organization, connectionString: url },
        fetch: async (url, init) => {
          if (init.method === 'POST') {
            writes.push(JSON.parse(init.body));
            keys.push(new Headers(init.headers).get('idempotency-key'));
            return Response.json({});
          }
          seen.push(new URL(url).searchParams.get('since'));
          return Response.json({
            items: [{ id: 'same', op: 'upsert', version: 1, amount: 1 }],
            nextCursor: null,
            syncToken: organization,
          });
        },
      });
      t.after(() => h.close());
      const child = JSON.parse(
        readFileSync(new URL('../../../examples/process-order-batch.json', import.meta.url)),
      );
      h.publish(child);
      const parent = structuredClone(example);
      Object.assign(parent.nodes[1].parameters, { syncScope: 'orders', keyLifetimeMs: 86400000 });
      h.activate(parent.id, h.publish(parent));
      for (const key of ['first', 'next']) {
        const id = h.accept(parent.id, 'schedule', { key, items: [{ json: {} }] });
        await until(() => h.receipt(id).state === 'finished');
        assert.equal(h.receipt(id).outcome, 'success');
      }
      assert.deepEqual(seen, [null, organization]);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].id, 'same');
    }
    assert.ok(keys.every(Boolean));
    assert.equal(new Set(keys).size, 2);
  },
);

test('organization IDs round-trip through storage before a host is opened', async (t) => {
  const path = join(dir(t), 'org.db');
  for (const organization of ['\ud800', '\ud801', 'a\0b', '']) {
    const open = (options) => {
      const h = new NodeHost(path, { registry, ...options });
      t.after(() => h.close());
    };
    assert.throws(() => open({ organization }), /organization/);
    if (url) assert.throws(() => open({ shared: { organization, connectionString: url } }), /organization/);
  }
});

test(
  'renewing an expired trigger receipt keeps byEvent ordered across sources',
  { skip: !url },
  async (t) => {
    const h = new NodeHost('', {
      registry,
      shared: { connectionString: url, organization: dir(t) },
      dedupMs: 0,
    });
    t.after(() => h.close());
    const flow = { ...example, nodes: [example.nodes[0]], connections: [] };
    h.activate(flow.id, h.publish(flow));
    const ids = [];
    for (const mode of ['trigger', 'webhook', 'trigger']) {
      const id = h.accept(flow.id, 'schedule', { mode, key: 'same', items: [{ json: {} }] });
      await until(() => h.receipt(id).state === 'finished');
      ids.push(id);
    }
    assert.equal(new Set(ids).size, 3);
    assert.equal(h.byEvent(flow.id, 'schedule', 'same').runId, ids[2]);
    assert.equal(h.byEvent(flow.id, 'schedule', 'same', 'webhook').runId, ids[1]);
  },
);

test(
  'a shared intake rejects an upload crossing same-revision reactivation on another intake',
  { skip: !url },
  (t) => {
    const shared = { organization: dir(t), connectionString: url, role: 'intake' };
    const a = new NodeHost('', { registry, shared });
    const b = new NodeHost('', { registry, shared });
    t.after(() => a.close());
    t.after(() => b.close());
    const flow = {
      ...example,
      nodes: [{ ...example.nodes[0], type: 'draflow.webhook', parameters: { path: 'orders' } }],
      connections: [],
    };
    const rev = a.publish(flow);
    a.activate(flow.id, rev);
    const path = '/webhook/orders';
    const uploading = a.webhook(path);
    b.activate(flow.id, rev);
    assert.equal(a.webhook(path).registration, uploading.registration);
    b.deactivate(flow.id);
    b.activate(flow.id, rev);
    const event = { key: 'delivery', items: [{ json: {} }] };
    assert.throws(() => a.acceptWebhook(path, uploading, event), WebhookGone);
    assert.equal(a.byEvent(flow.id, uploading.triggerNodeId, event.key), undefined);
    assert.equal(a.stats().queued, 0);
    const current = b.webhook(path);
    assert.equal(current.registration, a.webhook(path).registration);
    assert.ok(a.acceptWebhook(path, current, event));
  },
);
