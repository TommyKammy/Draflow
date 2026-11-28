import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { until } from './fixture.mjs';

const example = (name) =>
  JSON.parse(readFileSync(new URL('../../../examples/' + name + '.json', import.meta.url)));
const change = (id, version = 1, op = 'upsert') => ({ id: String(id), version, op, amount: 1 });
const initial = Array.from({ length: 100 }, (_, i) => change(i + 1));

function fixture(t, fetch, configure = () => {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => {
    const h = new NodeHost(join(dir, 'host.db'), {
      registry: new NodeRegistry().registerAll(standardNodes),
      fetch,
      ...options,
      ...(process.env.DRAFLOW_TEST_SHARED && {
        shared: { organization: dir, connectionString: process.env.DRAFLOW_TEST_SHARED, pollMs: 60 },
        ...(options.httpAuth && { httpAuth: { ...options.httpAuth, organization: dir } }),
      }),
    });
    t.after(() => h.close());
    return h;
  };
  const h = open();
  const child = example('process-order-batch');
  const parent = example('order-import');
  Object.assign(parent.nodes[1].parameters, { syncScope: 'orders', keyLifetimeMs: 86400000 });
  configure(child, parent);
  h.publish(child);
  h.activate(parent.id, h.publish(parent));
  return { h, open, child, parent, db: join(dir, 'host.db') };
}
const start = (h, key) => h.accept('order-import', 'schedule', { key, items: [{ json: {} }] });
async function outcome(h, id, timeoutMs) {
  await until(() => h.receipt(id).state === 'finished', timeoutMs);
  return h.receipt(id).outcome;
}

test('incremental tokens, overlapping runs, stale tombstones and explicit resync', async (t) => {
  const writes = [],
    rows = new Map(),
    tokens = [];
  let expired = false;
  const { h, open } = fixture(t, async (url, init) => {
    if (init.method === 'POST') {
      const row = JSON.parse(init.body);
      writes.push(row);
      if (row.op === 'delete') rows.delete(row.id);
      else rows.set(row.id, row);
      return Response.json({});
    }
    const params = new URL(url).searchParams;
    const since = params.get('since');
    tokens.push(since);
    if (expired) return new Response(null, { status: 410 });
    if (since === null) return Response.json({ items: initial, nextCursor: null, syncToken: 'one' });
    if (since === 'one' && !params.has('cursor')) {
      assert.equal(writes.length, 100);
      return Response.json({ items: [], nextCursor: 'changes' });
    }
    const updates = [
      change(101),
      change(102),
      change(1, 2),
      change(2, 2),
      change(3, 2),
      change(4, 2, 'delete'),
    ];
    return Response.json({
      items: since === 'one' ? [...updates, updates[0], updates[1], change(4)] : [],
      nextCursor: null,
      syncToken: 'two',
    });
  });
  const first = start(h, 'a');
  assert.equal(start(h, 'a'), first);
  const overlapping = start(h, 'b');
  assert.equal(await outcome(h, first), 'success');
  assert.equal(await outcome(h, overlapping), 'success');
  assert.equal(writes.length, 106);
  await h.close();
  const restored = open();
  assert.equal(await outcome(restored, start(restored, 'c')), 'success');
  const expected = new Map(initial.map((row) => [row.id, row]));
  for (const row of [change(1, 2), change(2, 2), change(3, 2), change(101), change(102)])
    expected.set(row.id, row);
  expected.delete('4');
  assert.deepEqual(rows, expected);
  assert.equal(rows.size, 101);
  assert.equal(rows.has('4'), false);
  assert.equal(writes.length, 106);
  assert.equal(await outcome(restored, start(restored, 'd')), 'success');
  assert.deepEqual(tokens, [null, 'one', 'one', 'two', 'two']);
  expired = true;
  assert.equal(await outcome(restored, start(restored, 'e')), 'error');
  expired = false;
  restored.resetSync('order-import', 'pages', 'orders');
  assert.equal(await outcome(restored, start(restored, 'f')), 'success');
  assert.equal(writes.length, 106);
});

for (const incremental of [true, false]) {
  test(
    'redrive preserves 57 confirmed rows, pinned child and duplicate request across restart, delta=' +
      incremental,
    async (t) => {
      const writes = [];
      let reject = true,
        reads = 0;
      const auth = {
        grants: [
          {
            id: 'service',
            workflowId: 'process-order-batch',
            nodeId: 'register',
            origin: 'https://sink.example.test',
            kind: 'bearer',
          },
        ],
        resolve: async () => (reject && writes.length === 57 ? undefined : 'token-1234567890'),
      };
      const { h, open, child } = fixture(
        t,
        async (url, init) => {
          if (init.method === 'POST') {
            writes.push(JSON.parse(init.body).id);
            return Response.json({});
          }
          reads++;
          return Response.json({ items: initial, nextCursor: null, syncToken: 'end' });
        },
        (c, p) => {
          c.nodes[1].credentials = { httpAuth: 'service' };
          c.nodes[1].parameters.authentication = 'credential';
          if (!incremental) {
            delete p.nodes[1].parameters.syncScope;
            p.nodes[1].parameters.allowRedrive = true;
          }
        },
        { httpAuth: auth },
      );
      const id = start(h, 'redrive');
      assert.equal(await outcome(h, id), 'error');
      assert.equal(writes.length, 57);
      const [point] = h.recoveryInfo(id);
      assert.ok(point.failure);
      assert.equal(h.progress(id)[0].items, 50);
      await h.history.delete('order-import', id);
      await h.history.delete('process-order-batch', point.child);
      h.publish(child);
      reject = false;
      const attempt = h.redrive(id, point.failure);
      assert.equal(h.redrive(id, point.failure), attempt);
      await h.close();
      const restored = open();
      assert.equal(restored.redrive(id, point.failure), attempt);
      assert.equal(await outcome(restored, id), 'success');
      assert.deepEqual(
        writes,
        initial.map((row) => row.id),
      );
      assert.equal(reads, 1);
      assert.equal(restored.progress(id)[0].items, 100);
      assert.equal(restored.relations(id).length, 4);
      assert.ok(restored.relations(id).every((r) => r.childRevision === 1));
      assert.equal(restored.recoveryInfo(id).length, 1);
      assert.equal(restored.recoveryInfo(attempt)[0].runId, id);
      assert.equal(restored.recoveryInfo(attempt)[0].outcome, 'success');
    },
  );
}

test('failed page GET redrives at its cursor without fetching the successful page', async (t) => {
  const requests = [],
    writes = [];
  let fail = true;
  const { h } = fixture(t, async (url, init) => {
    if (init.method === 'POST') {
      writes.push(JSON.parse(init.body).id);
      return Response.json({});
    }
    const cursor = new URL(url).searchParams.get('cursor');
    requests.push(cursor);
    if (cursor && fail) return new Response(null, { status: 500 });
    return Response.json({
      items: [change(cursor ? 'b' : 'a')],
      nextCursor: cursor ? null : 'second',
      syncToken: 'done',
    });
  });
  const id = start(h, 'read');
  assert.equal(await outcome(h, id), 'error');
  fail = false;
  h.redrive(id, h.recoveryInfo(id)[0].failure);
  assert.equal(await outcome(h, id), 'success');
  assert.deepEqual(requests, [null, 'second', 'second']);
  assert.deepEqual(writes, ['a', 'b']);
});

for (const decision of ['applied', 'notApplied']) {
  test('uncertain manual delivery requires reconciliation across restart: ' + decision, async (t) => {
    let calls = 0;
    const { h, open } = fixture(
      t,
      async (url, init) => {
        if (init.method === 'POST') {
          if (++calls === 1) throw Error('lost reply');
          return Response.json({});
        }
        return Response.json({ items: [change(1)], nextCursor: null, syncToken: 't' });
      },
      (c, p) => {
        delete p.nodes[1].parameters.keyLifetimeMs;
        c.nodes[1].parameters.delivery = 'manual';
      },
    );
    const id = start(h, 'lost');
    await until(() => h.relations(id)[0]?.childState === 'review');
    const queued = start(h, 'queued');
    await until(() => h.inspect(queued).waitingForSyncRun === id);
    const k = h.relations(id)[0].child,
      key = h.effects(k)[0].key;
    await h.close();
    const restored = open();
    assert.throws(() => restored.redrive(id, 'unknown'), /Reconcile uncertain/);
    assert.equal(calls, 1);
    assert.ok(restored.reconcile(k, key, decision, {}));
    assert.equal(await outcome(restored, id), 'success');
    assert.equal(await outcome(restored, queued), 'success');
    assert.equal(calls, decision === 'applied' ? 1 : 2);
  });
}

test('standalone recorded HTTP redrive reuses successful items and the pinned workflow', async (t) => {
  const writes = [];
  let fail = true;
  const auth = {
    grants: [
      {
        id: 'service',
        workflowId: 'order-import',
        nodeId: 'register',
        origin: 'https://sink.example.test',
        kind: 'bearer',
      },
    ],
    resolve: async () => (fail && writes.length === 2 ? undefined : 'test-secret-long'),
  };
  const { h, open } = fixture(
    t,
    async (url, init) => {
      writes.push(JSON.parse(init.body).id);
      return Response.json({});
    },
    (child, p) => {
      const write = structuredClone(child.nodes[1]);
      write.credentials = { httpAuth: 'service' };
      Object.assign(write.parameters, { authentication: 'credential', allowRedrive: true });
      p.nodes[1] = write;
      p.connections[0].to.node = write.id;
    },
    { httpAuth: auth },
  );
  const id = h.accept('order-import', 'schedule', { items: initial.slice(0, 5).map((json) => ({ json })) });
  assert.equal(await outcome(h, id), 'error');
  assert.deepEqual(writes, ['1', '2']);
  const [point] = h.recoveryInfo(id);
  assert.equal(point.node, 'register');
  await h.close();
  const restored = open();
  fail = false;
  restored.redrive(id, point.failure);
  assert.equal(await outcome(restored, id), 'success');
  assert.deepEqual(writes, ['1', '2', '3', '4', '5']);
});

test('expired recovery and untracked batch code cannot be redriven', async (t) => {
  const { h, child, parent } = fixture(
    t,
    async () => new Response(null, { status: 500 }),
    (_, p) => {
      p.nodes[1].parameters.redriveRetentionMs = 1;
    },
  );
  const id = start(h, 'expired');
  assert.equal(await outcome(h, id), 'error');
  const [point] = h.recoveryInfo(id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(() => h.redrive(id, point.failure), /expired/);
  child.nodes[1].parameters.delivery = 'none';
  const revision = h.publish(child);
  parent.nodes[1].parameters.revision = revision;
  assert.throws(() => h.publish(parent), /recorded HTTP child/);
});

test('expired receiver keys and canceled unknown sends require reconciliation before resetting the scope', async (t) => {
  let sends = 0;
  const { h, open } = fixture(
    t,
    async (url, init) => {
      if (init.method === 'POST') {
        sends++;
        throw Error('reply lost');
      }
      return Response.json({ items: [change(1)], nextCursor: null, syncToken: 'last' });
    },
    (_, p) => {
      p.nodes[1].parameters.keyLifetimeMs = 1;
    },
    process.env.DRAFLOW_TEST_SHARED ? {} : { organization: 'expiry-test' },
  );
  const id = start(h, 'cancel');
  await until(() => h.relations(id)[0]?.childState === 'review');
  const k = h.relations(id)[0].child,
    key = h.effects(k)[0].key;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const detail = h.operate({ actor: 'reviewer', role: 'admin', organization: h.organization }, { op: 'detail', id: k });
  assert.deepEqual(detail.guidance.actions.find((action) => action.key === key).decisions, ['applied', 'notApplied']);
  assert.equal(h.reconcile(k, key, 'retryKeyed'), false);
  assert.ok(h.cancel(id));
  assert.equal(await outcome(h, id), 'canceled');
  await h.close();
  const restored = open();
  assert.throws(() => restored.resetSync('order-import', 'pages', 'orders'), /reconciliation/);
  assert.throws(() => restored.redrive(id, 'unknown'), /Canceled run/);
  assert.ok(restored.reconcile(k, key, 'applied', {}));
  assert.equal(await outcome(restored, k), 'canceled');
  restored.resetSync('order-import', 'pages', 'orders');
  assert.equal(await outcome(restored, start(restored, 'again')), 'success');
  assert.equal(sends, 1);
});

test('upgrading a Phase 5 database retains a queued ordinary page import and delivery receipt', async (t) => {
  const writes = [];
  const { h, open, db } = fixture(
    t,
    async (url, init) => {
      if (init.method === 'POST') {
        writes.push(JSON.parse(init.body).id);
        return Response.json({});
      }
      return Response.json({ items: [{ id: 1, amount: 1 }], nextCursor: null });
    },
    (_, p) => {
      delete p.nodes[1].parameters.syncScope;
      delete p.nodes[1].parameters.keyLifetimeMs;
    },
  );
  const id = start(h, 'old');
  await h.close();
  const sql = new DatabaseSync(db);
  sql.exec(
    'DROP TRIGGER compensationApplied; DROP TABLE compensationSteps; DROP TABLE compensations; DROP TABLE compensationRetries; DROP TABLE rateLimits; DROP TABLE parallelWork; ALTER TABLE pageRuns DROP COLUMN skipped; DROP TRIGGER syncApplied; DROP TABLE syncWork; DROP TABLE syncVersions; DROP TABLE syncQueue; DROP TABLE syncScopes; DROP TABLE recoveryPoints',
  );
  sql.close();
  const restored = open();
  assert.equal(start(restored, 'old'), id);
  assert.equal(await outcome(restored, id), 'success');
  assert.deepEqual(writes, [1]);
  assert.deepEqual(restored.recoveryInfo(id), []);
});

test('a delayed credential lookup cannot send a retry beyond the receiver key lifetime', async (t) => {
  const now = Date.now.bind(Date);
  let offset = 0,
    resolutions = 0,
    sends = 0;
  t.mock.method(Date, 'now', () => now() + offset);
  const auth = {
    grants: [
      {
        id: 'sink',
        workflowId: 'process-order-batch',
        nodeId: 'register',
        origin: 'https://sink.example.test',
        kind: 'bearer',
      },
    ],
    resolve: async () => {
      if (++resolutions === 2) {
        if (process.env.DRAFLOW_TEST_SHARED) await new Promise((resolve) => setTimeout(resolve, 1100));
        else offset += 2000;
      }
      return 'credential-12345';
    },
  };
  const { h } = fixture(
    t,
    async (url, init) => {
      if (init.method !== 'POST')
        return Response.json({ items: [change(1)], nextCursor: null, syncToken: 'done' });
      if (++sends === 1) throw Error('response lost');
      return Response.json({});
    },
    (child, parent) => {
      parent.nodes[1].parameters.keyLifetimeMs = 1000;
      child.nodes[1].credentials = { httpAuth: 'sink' };
      child.nodes[1].parameters.authentication = 'credential';
    },
    { httpAuth: auth },
  );
  const id = start(h, 'expiry');
  await until(() => h.relations(id)[0]?.childState === 'review');
  const child = h.relations(id)[0].child,
    key = h.effects(child)[0].key;
  assert.ok(h.reconcile(child, key, 'retryKeyed'));
  await until(() => resolutions === 2 && ['review', 'finished'].includes(h.receipt(child).state));
  assert.equal(sends, 1);
  assert.equal(h.receipt(child).state, 'review');
  assert.ok(h.reconcile(child, key, 'applied', {}));
  assert.equal(await outcome(h, id), 'success');
});

test('incremental maxItems counts every source row across duplicate-only pages', async (t) => {
  let reads = 0,
    writes = 0;
  const { h } = fixture(
    t,
    async (url, init) => {
      if (init.method === 'POST') {
        writes++;
        return Response.json({});
      }
      reads++;
      return Response.json({
        items: [change(1)],
        nextCursor: reads < 3 ? String(reads) : null,
        syncToken: 'done',
      });
    },
    (_, p) => {
      p.nodes[1].parameters.maxItems = 2;
    },
  );
  const id = start(h, 'limit');
  assert.equal(await outcome(h, id), 'error');
  assert.match(h.progress(id)[0].error, /limit/i);
  assert.equal(writes, 1);
});

test('duplicate large amounts do not overflow the confirmed delta aggregate', async (t) => {
  const row = { ...change(1), amount: 1e308 };
  let writes = 0;
  const { h } = fixture(t, async (url, init) => {
    if (init.method === 'POST') {
      writes++;
      return Response.json({});
    }
    return Response.json({ items: [row, row], nextCursor: null, syncToken: 'done' });
  });
  const id = start(h, 'sum');
  assert.equal(await outcome(h, id), 'success');
  assert.equal(writes, 1);
  assert.equal(h.progress(id)[0].total, 1e308);
});

test('an oversized 410 error still requires explicit resync instead of retrying the expired cursor', async (t) => {
  const { h } = fixture(
    t,
    async () => new Response('expired'.repeat(50), { status: 410 }),
    () => {},
    { maxHttpResponseBytes: 100 },
  );
  const id = start(h, 'gone');
  assert.equal(await outcome(h, id), 'error');
  assert.match(h.progress(id)[0].error, /resetSync/);
  assert.deepEqual(h.recoveryInfo(id), []);
});

for (const incremental of [true, false]) {
  test('aggregation carries the previous total through a batch, delta=' + incremental, async (t) => {
    const { h } = fixture(
      t,
      async (url, init) => {
        if (init.method === 'POST') return Response.json({});
        const next = new URL(url).searchParams.has('cursor');
        const amounts = next ? [1e308, 1e308] : [-1e308];
        return Response.json({
          items: amounts.map((amount, i) => ({ ...change(next ? i + 2 : 1), amount })),
          nextCursor: next ? null : 'second',
          syncToken: 'end',
        });
      },
      (_, p) => {
        if (!incremental) delete p.nodes[1].parameters.syncScope;
      },
    );
    const id = start(h, 'aggregate');
    assert.equal(await outcome(h, id), 'success');
    assert.equal(h.progress(id)[0].total, 1e308);
  });
}

test('a late duplicate redrive for the first failure cannot start the next attempt', async (t) => {
  const writes = [];
  let limit = 2;
  const auth = {
    grants: [
      {
        id: 'sink',
        workflowId: 'process-order-batch',
        nodeId: 'register',
        origin: 'https://sink.example.test',
        kind: 'bearer',
      },
    ],
    resolve: async () => (writes.length === limit ? undefined : 'credential-12345'),
  };
  const { h, open } = fixture(
    t,
    async (url, init) => {
      if (init.method !== 'POST')
        return Response.json({ items: initial.slice(0, 6), nextCursor: null, syncToken: 'done' });
      writes.push(JSON.parse(init.body).id);
      return Response.json({});
    },
    (c) => {
      c.nodes[1].credentials = { httpAuth: 'sink' };
      c.nodes[1].parameters.authentication = 'credential';
    },
    { httpAuth: auth },
  );
  const id = start(h, 'twice');
  assert.equal(await outcome(h, id), 'error');
  const first = h.recoveryInfo(id)[0].failure;
  limit = 4;
  const attempt = h.redrive(id, first);
  assert.equal(await outcome(h, id), 'error');
  const second = h.recoveryInfo(id)[1].failure;
  await h.close();
  const restored = open();
  assert.equal(restored.redrive(id, first), attempt);
  assert.equal(restored.receipt(id).state, 'finished');
  assert.equal(restored.recoveryInfo(id)[1].attempt, null);
  limit = Infinity;
  assert.notEqual(restored.redrive(id, second), attempt);
  assert.equal(await outcome(restored, id), 'success');
  assert.deepEqual(writes, ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(
    restored.recoveryInfo(id).map((p) => p.outcome),
    ['error', 'success'],
  );
});

test('parallel pages retain completed siblings across restart and duplicate redrive', async (t) => {
  const sent = [],
    completed = [],
    rows = Array.from({ length: 1003 }, (_, i) => change(i + 1));
  let active = 0,
    peak = 0,
    calls = 0,
    fail = true,
    reads = 0;
  const auth = {
    grants: [
      {
        id: 'service',
        workflowId: 'process-order-batch',
        nodeId: 'register',
        origin: 'https://sink.example.test',
        kind: 'bearer',
      },
    ],
    resolve() {
      if (++calls === 47 && fail) return undefined;
      return 'opaque-secret';
    },
  };
  const { h, open } = fixture(
    t,
    async (url, init) => {
      if (init.method === 'POST') {
        const id = JSON.parse(init.body).id;
        peak = Math.max(peak, ++active);
        const firstInBatch = (Number(id) - 1) % 25 === 0;
        const pause = process.env.DRAFLOW_TEST_SHARED && firstInBatch ? 200 : 1;
        await new Promise((resolve) => setTimeout(resolve, Number(id) === 1 ? pause + 100 : pause));
        active--;
        sent.push(id);
        if (Number(id) % 25 === 0) completed.push(Number(id));
        return Response.json({});
      }
      const i = Number(new URL(url).searchParams.get('cursor') ?? 0);
      reads++;
      return Response.json({
        items: rows.slice(i, i + 100),
        nextCursor: i + 100 < rows.length ? String(i + 100) : null,
        syncToken: 'end',
      });
    },
    (child, parent) => {
      parent.nodes[1].parameters.concurrency = 4;
      child.nodes[1].credentials = { httpAuth: 'service' };
      child.nodes[1].parameters.authentication = 'credential';
    },
    { httpAuth: auth, maxParallelBatches: 3 },
  );
  const id = start(h, 'parallel');
  assert.equal(start(h, 'parallel'), id);
  assert.equal(await outcome(h, id), 'error');
  assert.equal(reads, 1);
  assert.equal(h.progress(id)[0].pages, 0);
  const [point] = h.recoveryInfo(id);
  await h.close();
  const restored = open();
  fail = false;
  const attempt = restored.redrive(id, point.failure);
  assert.equal(restored.redrive(id, point.failure), attempt);
  assert.equal(await outcome(restored, id, 90000), 'success');
  assert.equal(restored.relations(id).length, 41);
  assert.equal(restored.progress(id)[0].total, 1003);
  assert.equal(peak, 3);
  assert.notEqual(completed[0], 25);
  assert.deepEqual(
    sent.map(Number).sort((a, b) => a - b),
    rows.map((r) => Number(r.id)),
  );
});

test('two parallel imports share host slots and serialize versions of a business ID', async (t) => {
  const active = new Map(),
    peaks = new Map(),
    versions = new Map();
  let totalPeak = 0;
  const { h, parent } = fixture(
    t,
    async (url, init) => {
      if (init.method !== 'POST') {
        const scope = new URL(url).pathname;
        const rows = Array.from({ length: 12 }, (_, i) => ({
          ...change(scope + (i === 1 ? 0 : i), i === 1 ? 2 : 1),
          scope,
        }));
        return Response.json({ items: rows, nextCursor: null, syncToken: 'done' });
      }
      const { scope, id, version } = JSON.parse(init.body);
      active.set(scope, (active.get(scope) ?? 0) + 1);
      peaks.set(scope, Math.max(peaks.get(scope) ?? 0, active.get(scope)));
      totalPeak = Math.max(
        totalPeak,
        [...active.values()].reduce((a, b) => a + b, 0),
      );
      // Give the other workers time to claim their batches over a real DB connection.
      await new Promise((resolve) => setTimeout(resolve, process.env.DRAFLOW_TEST_SHARED ? 200 : 8));
      const sequence = versions.get(id) ?? [];
      sequence.push(version);
      versions.set(id, sequence);
      active.set(scope, active.get(scope) - 1);
      return Response.json({});
    },
    (c, p) => {
      c.nodes[0].parameters.callers.push('second');
      Object.assign(p.nodes[1].parameters, { concurrency: 2, batchSize: 1 });
    },
    { maxParallelBatches: 3 },
  );
  const second = structuredClone(parent);
  second.id = 'second';
  second.nodes[1].parameters.url = 'https://source.example.test/other';
  h.activate(second.id, h.publish(second));
  const a = start(h, 'a'),
    b = h.accept(second.id, 'schedule', { items: [{ json: {} }] });
  assert.deepEqual(await Promise.all([outcome(h, a, 30000), outcome(h, b, 30000)]), ['success', 'success']);
  assert.equal(totalPeak, 3);
  assert.deepEqual([...peaks.values()], [2, 2]);
  for (const scope of peaks.keys()) assert.deepEqual(versions.get(scope + '0'), [1, 2]);
});

test('parallel receiver cooldown persists across restart and also gates sequential imports', async (t) => {
  const sends = [];
  let since = 0;
  const { h, open, parent } = fixture(
    t,
    async (url, init) => {
      if (init.method === 'POST') {
        sends.push(Date.now());
        if (!since) {
          since = Date.now();
          return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
        }
        return Response.json({});
      }
      return Response.json({ items: [change(1)], nextCursor: null, syncToken: 'one' });
    },
    (child, parent) => {
      parent.nodes[1].parameters.concurrency = 2;
      child.nodes[0].parameters.callers.push('sequential');
    },
  );
  const id = start(h, 'hold');
  await until(
    () =>
      h.inspect(id).uncertain.length && h.relations(id).some((r) => h.receipt(r.child).state === 'review'),
  );
  await h.close();
  const restored = open(),
    seq = structuredClone(parent);
  seq.id = 'sequential';
  seq.nodes[1].parameters.concurrency = 1;
  restored.activate(seq.id, restored.publish(seq));
  const other = restored.accept(seq.id, 'schedule', { items: [{ json: {} }] });
  const [unknown] = restored.inspect(id).uncertain;
  assert.ok(restored.reconcile(unknown.runId, unknown.key, 'retryKeyed'));
  assert.deepEqual(await Promise.all([outcome(restored, id), outcome(restored, other)]), [
    'success',
    'success',
  ]);
  assert.equal(sends.length, 3);
  assert.ok(sends.slice(1).every((at) => at - since >= 1000));
});

test('parallel cancellation retains confirmed sends and every uncertain in-flight operation', async (t) => {
  const sent = [];
  const { h, open } = fixture(
    t,
    async (url, init) => {
      if (init.method !== 'POST')
        return Response.json({
          items: Array.from({ length: 20 }, (_, i) => change(i)),
          nextCursor: null,
          syncToken: 'x',
        });
      const row = JSON.parse(init.body);
      sent.push(row.id);
      if (Number(row.id) < 2) return Response.json({});
      await new Promise((resolve) => init.signal.addEventListener('abort', resolve, { once: true }));
      throw Error('lost response');
    },
    (c, p) => Object.assign(p.nodes[1].parameters, { batchSize: 2, concurrency: 4 }),
  );
  const root = start(h, 'cancel-parallel');
  await until(() => sent.length === 5 && h.progress(root)[0].items === 2);
  assert.ok(h.cancel(root));
  assert.equal(await outcome(h, root), 'canceled');
  await h.close();
  const restored = open();
  const unknown = restored.inspect(root).uncertain;
  assert.equal(unknown.length, 3);
  assert.equal(restored.progress(root)[0].items, 2);
  for (const op of unknown) assert.ok(restored.reconcile(op.runId, op.key, 'applied', { confirmed: true }));
  await until(() => restored.relations(root).every((r) => restored.receipt(r.child).state === 'finished'));
  const effects = restored.relations(root).flatMap((r) => restored.effects(r.child));
  assert.equal(effects.filter((e) => e.state === 'success').length, 5);
  assert.equal(sent.length, 5);
});

test('a sequential import respects occupied host batch slots', async (t) => {
  let active = 0,
    peak = 0;
  const { h, parent } = fixture(
    t,
    async (url, init) => {
      if (init.method !== 'POST')
        return Response.json({
          items: Array.from({ length: 12 }, (_, i) => change(i)),
          nextCursor: null,
          syncToken: 'x',
        });
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return Response.json({});
    },
    (c, p) => {
      c.nodes[0].parameters.callers.push('serial');
      Object.assign(p.nodes[1].parameters, { batchSize: 3, concurrency: 2 });
    },
    { maxParallelBatches: 2 },
  );
  const serial = structuredClone(parent);
  serial.id = 'serial';
  serial.nodes[1].parameters.concurrency = 1;
  h.activate(serial.id, h.publish(serial));
  const a = start(h, 'parallel');
  await until(() => active === 2);
  const b = h.accept(serial.id, 'schedule', { items: [{ json: {} }] });
  assert.deepEqual(await Promise.all([outcome(h, a, 30000), outcome(h, b, 30000)]), ['success', 'success']);
  assert.equal(peak, 2);
});

test('upgrading a 6.2 recovery point preserves its failed child and accepted event key', async (t) => {
  const writes = [];
  let enabled = false;
  const { h, open, db } = fixture(
    t,
    async (url, init) => {
      if (init.method !== 'POST')
        return Response.json({ items: initial.slice(0, 3), nextCursor: null, syncToken: 'done' });
      writes.push(JSON.parse(init.body).id);
      return Response.json({});
    },
    (c) => {
      c.nodes[1].credentials = { httpAuth: 'service' };
      c.nodes[1].parameters.authentication = 'credential';
    },
    {
      httpAuth: {
        grants: [
          {
            id: 'service',
            workflowId: 'process-order-batch',
            nodeId: 'register',
            kind: 'bearer',
            origin: 'https://sink.example.test',
          },
        ],
        resolve: () => (writes.length === 1 && !enabled ? undefined : 'opaque-secret'),
      },
    },
  );
  const id = start(h, 'old-redrive');
  assert.equal(await outcome(h, id), 'error');
  const [point] = h.recoveryInfo(id);
  await h.close();
  const sql = new DatabaseSync(db);
  sql.exec(`DROP TRIGGER compensationApplied; DROP TRIGGER releaseParallelSyncWork;
    DROP TABLE compensationSteps; DROP TABLE compensations; DROP TABLE compensationRetries;
    DROP TABLE rateLimits; DROP TABLE parallelWork;
    UPDATE recoveryPoints SET data=json_remove(data,'$.wave');`);
  sql.close();
  enabled = true;
  const restored = open();
  assert.equal(start(restored, 'old-redrive'), id);
  const attempt = restored.redrive(id, point.failure);
  assert.equal(restored.redrive(id, point.failure), attempt);
  assert.equal(await outcome(restored, id), 'success');
  assert.deepEqual(writes, ['1', '2', '3']);
});

test('a shared cooldown preserves the first GET attempt of a separate import', async (t) => {
  let calls = 0;
  const { h, parent } = fixture(
    t,
    async () => {
      if (++calls === 1) return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
      return Response.json({ items: [], nextCursor: null, syncToken: 'end' });
    },
    (child, parent) => {
      parent.nodes[1].parameters.concurrency = 2;
      child.nodes[0].parameters.callers.push('other-import');
    },
  );
  const other = structuredClone(parent);
  other.id = 'other-import';
  Object.assign(other.nodes[1].parameters, { concurrency: 1, maxAttempts: 1 });
  h.activate(other.id, h.publish(other));
  const first = start(h, 'first');
  await until(() => h.progress(first)[0]?.retryAt);
  const second = h.accept(other.id, 'schedule', { items: [{ json: {} }] });
  assert.equal(await outcome(h, second), 'success');
  assert.equal(await outcome(h, first), 'success');
  assert.equal(calls, 3);
});

test('cancellation during rate-limit wait leaves only the dispatched write for reconciliation', async (t) => {
  const sent = [];
  const { h, open } = fixture(
    t,
    async (url, init) => {
      if (init.method !== 'POST')
        return Response.json({ items: [change(1), change(2)], nextCursor: null, syncToken: 'end' });
      sent.push(JSON.parse(init.body).id);
      return new Response(null, { status: 429, headers: { 'retry-after': '30' } });
    },
    (child, parent) => {
      // Anonymous cooldowns outlive a run and are shared by all organizations at this origin.
      child.nodes[1].parameters.url = 'https://' + randomUUID() + '.sink.example.test/orders';
      Object.assign(parent.nodes[1].parameters, { concurrency: 2, batchSize: 1 });
    },
  );
  const root = start(h, 'cancel-before-dispatch');
  await until(
    () =>
      h.relations(root).some((r) => h.receipt(r.child).state === 'review') &&
      h
        .relations(root)
        .some((r) => h.receipt(r.child).state === 'running' && h.effects(r.child).length === 1),
  );
  assert.ok(h.cancel(root));
  assert.equal(await outcome(h, root), 'canceled');
  await h.close();
  const restored = open();
  assert.deepEqual(sent, ['1']);
  assert.equal(restored.inspect(root).uncertain.length, 1);
});
