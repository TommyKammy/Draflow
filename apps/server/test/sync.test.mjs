import assert from 'node:assert/strict';
import { test } from 'node:test';
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
async function outcome(h, id) {
  await until(() => h.receipt(id).state === 'finished');
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
  );
  const id = start(h, 'cancel');
  await until(() => h.relations(id)[0]?.childState === 'review');
  const k = h.relations(id)[0].child,
    key = h.effects(k)[0].key;
  await new Promise((resolve) => setTimeout(resolve, 5));
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
    'ALTER TABLE pageRuns DROP COLUMN skipped; DROP TRIGGER syncApplied; DROP TABLE syncWork; DROP TABLE syncVersions; DROP TABLE syncQueue; DROP TABLE syncScopes; DROP TABLE recoveryPoints',
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
      if (++resolutions === 2) offset += 2000;
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
