import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { SqliteLedger } from '../dist/sqlite.js';
import { NodeHost } from '../dist/host.js';
import { until } from './fixture.mjs';

const node = (id, type, parameters = {}) => ({
  id,
  name: id,
  type: 'draflow.' + type,
  typeVersion: 1,
  parameters,
  position: { x: 0, y: 0 },
});
const flow = (id, nodes) => ({
  schema: 'draflow/v1',
  id,
  name: id,
  settings: {},
  nodes,
  connections: nodes.slice(1).map((n, i) => ({
    id: 'e' + i,
    from: { node: nodes[i].id, port: 'main', index: 0 },
    to: { node: n.id, port: 'main', index: 0 },
  })),
});
const child = (extra = []) =>
  flow('child', [
    node('input', 'childInput', { callers: ['parent', 'other'] }),
    ...extra,
    node('return', 'return'),
  ]);
const parent = (id = 'parent', revision = 1) =>
  flow(id, [node('start', 'manualTrigger'), node('call', 'call', { workflowId: 'child', revision })]);
const fixture = (t, options = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-composition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'host.db');
  const open = (role = 'all') => {
    const h = new NodeHost(db, {
      registry: new NodeRegistry().registerAll(standardNodes),
      ...options,
      ...(process.env.DRAFLOW_TEST_SHARED && { shared: {
        connectionString: process.env.DRAFLOW_TEST_SHARED, organization: db, role, pollMs: 75,
      } }),
    });
    t.after(() => h.close());
    return h;
  };
  return { open, db };
};
const start = (host, id = 'parent', items = [{ json: { n: 1 } }, { json: { n: 2 } }]) =>
  host.accept(id, 'start', { items });
const done = (h, id) => until(() => h.receipt(id).state === 'finished');

test('published child waits without occupying the worker and returns to two pinned parents across restart', async (t) => {
  const { open } = fixture(t);
  let h = open();
  h.publish(child([node('wait', 'wait', { mode: 'event', dueAt: Date.now() + 60000 })]));
  for (const id of ['parent', 'other']) h.activate(id, h.publish(parent(id)));
  const ids = ['parent', 'other'].map((id) => start(h, id));
  await until(() => ids.every((id) => h.relations(id).some((c) => c.childState === 'waiting')));
  const short = flow('short', [node('start', 'manualTrigger')]);
  h.activate(short.id, h.publish(short));
  await done(h, start(h, 'short'));
  h.publish(child());
  h.activate('parent', h.publish(parent('parent', 2)));
  const children = ids.map((id) => h.relations(id)[0].child);
  for (const c of children) await h.history.delete('child', c);
  await h.close();
  h = open();
  for (const c of children) assert.ok(h.resolveWait(c, h.waitInfo(c).token, 'event', { ok: true }));
  for (const id of ids) {
    await done(h, id);
    const [link] = h.relations(id);
    assert.equal(link.childRevision, 1);
    assert.equal(h.relations(link.child)[0].parent, id);
    const detail = await h.history.get(h.receipt(id).workflowId, id);
    const rows = detail.tasks.at(-1).task.output.main[0];
    assert.deepEqual(
      rows.map((r) => r.json.n),
      [1, 2],
    );
    assert.deepEqual(
      rows.map((r) => r.pairedItem.item),
      [0, 1],
    );
    assert.ok(rows[0].json.wait.data.ok);
  }
  const latest = start(h);
  await done(h, latest);
  assert.equal(h.relations(latest)[0].childRevision, 2);
});

test('rejects unauthorized, missing, recursive and too deep child targets at publication', async (t) => {
  const { open } = fixture(t, { maxCallDepth: 1 });
  const h = open();
  assert.throws(() => h.publish(parent()), /Unknown publication/);
  h.publish(child());
  assert.throws(() => h.publish(parent('forbidden')), /permission/);
  h.publish(parent());
  assert.throws(
    () => h.publish(child([node('nested', 'call', { workflowId: 'child', revision: 1 })])),
    /Recursive/,
  );
  const middle = flow('middle', [
    node('input', 'childInput', { callers: ['parent'] }),
    node('nested', 'call', { workflowId: 'child', revision: 2 }),
    node('out', 'return'),
  ]);
  const c = child();
  c.nodes[0].parameters.callers.push('middle');
  h.publish(c);
  h.publish(middle);
  const root = parent();
  root.nodes[1].parameters.workflowId = 'middle';
  assert.throws(() => h.publish(root), /deep/);
});

test('rejects indirect recursion through older revisions and a disconnected return', (t) => {
  const h = fixture(t).open();
  const first = child();
  first.nodes[0].parameters.callers.push('middle');
  h.publish(first);
  const middle = flow('middle', [
    node('input', 'childInput', { callers: ['child'] }),
    node('call', 'call', { workflowId: 'child', revision: 1 }),
    node('return', 'return'),
  ]);
  h.publish(middle);
  assert.throws(() => h.publish(child([node('call', 'call', { workflowId: 'middle', revision: 1 })])), /Recursive/);
  const disconnected = child();
  disconnected.connections = [];
  h.publish(disconnected);
  assert.throws(() => h.publish(parent('parent', 2)), /reachable/);
});

function pages(parameters = {}) {
  return flow('parent', [
    node('start', 'manualTrigger'),
    node('pages', 'pages', {
      workflowId: 'child',
      revision: 1,
      url: 'https://source.test/records',
      sumField: 'id',
      ...parameters,
    }),
  ]);
}
function pageResponse(url, size = 1003, padding = 0) {
  const query = new URL(url).searchParams;
  const offset = Number(query.get('cursor') ?? 0),
    count = Number(query.get('limit'));
  return Response.json({
    items: Array.from({ length: Math.min(count, size - offset) }, (_, i) => ({
      id: offset + i + 1,
      pad: 'x'.repeat(padding),
    })),
    nextCursor: offset + count < size ? String(offset + count) : null,
  });
}
test('1003 records resume in source order across restart with bounded pages and durable batch counts', async (t) => {
  const reads = [],
    writes = [];
  const { open } = fixture(t, {
    fetch: async (url, init) => {
      if (new URL(url).hostname === 'source.test') {
        reads.push(url);
        return pageResponse(url);
      }
      writes.push(JSON.parse(init.body).id);
      return Response.json({});
    },
  });
  let h = open();
  const post = node('post', 'httpRequest', {
    method: 'POST',
    url: 'https://sink.test/',
    delivery: 'keyed',
    body: '={{ $json }}',
  });
  post.typeVersion = 2;
  h.publish(child([post]));
  h.activate('parent', h.publish(pages()));
  const id = start(h);
  await until(() => Number(h.progress(id)[0]?.pages) >= 6);
  await h.close();
  h = open();
  await untilLong(() => h.receipt(id).state === 'finished');
  const p = h.progress(id)[0];
  assert.equal(h.receipt(id).outcome, 'success', p.error);
  assert.deepEqual([p.pages, p.batches, p.items, p.total], [11, 41, 1003, 503506]);
  assert.deepEqual(
    writes,
    Array.from({ length: 1003 }, (_, i) => i + 1),
  );
  assert.equal(new Set(reads).size, 11);
  assert.equal(reads.length, 11);
  assert.equal(h.relations(id).length, 41);
  const detail = await h.history.get('parent', id);
  assert.deepEqual(detail.tasks.at(-1).task.output.main[0][0].json, {
    pages: 11,
    batches: 41,
    items: 1003,
    total: 503506,
  });
});
async function untilLong(check) {
  const end = Date.now() + 120000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Sync timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
for (const [name, params, reply, expected] of [
  ['empty', {}, (i) => ({ items: [], nextCursor: i === 1 ? 'more' : null }), 'success'],
  ['repeat', {}, () => ({ items: [], nextCursor: 'secret-cursor' }), 'Repeated'],
  [
    'expired',
    {},
    (i) => (i === 1 ? { items: [], nextCursor: 'secret-cursor' } : new Response(null, { status: 410 })),
    '410',
  ],
  ['pages', { maxPages: 1 }, () => ({ items: [], nextCursor: 'next' }), 'count limit'],
  ['items', { maxItems: 1 }, () => ({ items: [{ id: 1 }, { id: 2 }], nextCursor: null }), 'item or byte'],
  ['bytes', { maxBytes: 1 }, () => ({ items: [], nextCursor: null }), 'byte limit'],
])
  test('paging boundary: ' + name, async (t) => {
    let n = 0;
    const h = fixture(t, {
      fetch: async () => {
        const r = reply(++n);
        return r instanceof Response ? r : Response.json(r);
      },
    }).open();
    h.publish(child());
    h.activate('parent', h.publish(pages(params)));
    const id = start(h);
    await done(h, id);
    const p = h.progress(id)[0];
    if (expected === 'success') {
      assert.equal(p.pages, 2);
      assert.equal(p.items, 0);
    } else {
      assert.match(p.error, new RegExp(expected));
      assert.equal(h.receipt(id).outcome, 'error');
    }
    assert.ok(!JSON.stringify(await h.history.get('parent', id)).includes('secret-cursor'));
  });

function fakeClock() {
  let now = Date.parse('2026-01-01T00:00:00Z');
  let timers = new Map();
  return {
    now: () => now,
    arm(fn, delay) {
      const key = Symbol();
      timers.set(key, { fn, at: now + Math.max(0, delay) });
      return () => timers.delete(key);
    },
    advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) if (timer.at <= now && timers.delete(key)) timer.fn();
    },
  };
}
for (const cancel of [false, true])
  test('seventh-page 429 survives restart, cancel=' + cancel, async (t) => {
    const clock = fakeClock(),
      reads = [];
    let once = true;
    const { open } = fixture(t, {
      scheduleClock: clock,
      fetch: async (url) => {
        const cursor = new URL(url).searchParams.get('cursor');
        reads.push(cursor);
        if (cursor === '600' && once) {
          once = false;
          return new Response(null, { status: 429, headers: { 'Retry-After': '30' } });
        }
        return pageResponse(url);
      },
    });
    let h = open();
    h.publish(child());
    h.activate('parent', h.publish(pages()));
    const id = start(h);
    await until(() => h.progress(id)[0]?.retryAt > 0);
    assert.equal(h.progress(id)[0].retryAt, clock.now() + 30000);
    const before = reads.length;
    h.activate('short', h.publish(flow('short', [node('start', 'manualTrigger')])));
    await done(h, start(h, 'short'));
    const info = (await h.history.get('parent', id)).orchestration;
    assert.equal(info.pages[0].items, 600);
    assert.equal(info.uncertain.length, 0);
    if (cancel) {
      assert.ok(h.cancel(id));
      assert.equal(h.cancel(id), false);
    }
    await h.close();
    h = open();
    clock.advance(29999);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(reads.length, before);
    clock.advance(1);
    await done(h, id);
    assert.equal(h.receipt(id).outcome, cancel ? 'canceled' : 'success');
    assert.equal(reads.filter((v) => v === '600').length, cancel ? 1 : 2);
    assert.equal(h.progress(id)[0].items, cancel ? 600 : 1003);
  });
for (const [status, header, delay] of [
  [503, 'Thu, 01 Jan 2026 00:00:42 GMT', 42000],
  [429, 'bad', 1000],
  [401, null, 0],
  [403, null, 0],
]) {
  test('page read policy ' + status + ' ' + header, async (t) => {
    const clock = fakeClock();
    let calls = 0;
    const h = fixture(t, {
      scheduleClock: clock,
      fetch: async () => {
        calls++;
        return new Response(null, { status, headers: header ? { 'Retry-After': header } : {} });
      },
    }).open();
    h.publish(child());
    h.activate('parent', h.publish(pages({ maxAttempts: 2 })));
    const id = start(h);
    if (delay) {
      await until(() => h.progress(id)[0]?.retryAt > 0);
      assert.equal(h.progress(id)[0].retryAt, clock.now() + delay);
      clock.advance(delay);
    }
    await done(h, id);
    assert.equal(calls, delay ? 2 : 1);
    assert.match(h.progress(id)[0].error, new RegExp(status));
  });
}
test('retry beyond the total deadline ends the import without a second GET', async (t) => {
  let reads = 0;
  const clock = fakeClock();
  const h = fixture(t, { scheduleClock: clock, fetch: async () => {
    reads++;
    return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  } }).open();
  h.publish(child());
  h.activate('parent', h.publish(pages({ deadlineMs: 1000 })));
  const id = start(h);
  await done(h, id);
  assert.match(h.progress(id)[0].error, /budget exhausted/);
  assert.equal(h.progress(id)[0].retryAt, null);
  assert.equal(reads, 1);
});

for (const order of ['before', 'after']) {
  test('parent cancellation immediately ' + order + ' child completion has one terminal outcome', async (t) => {
    let sends = 0;
    const fx = fixture(t, { fetch: async () => { sends++; return Response.json({}); } });
    let h = fx.open();
    h.publish(child());
    const doc = parent();
    const post = node('post', 'httpRequest', { url: 'https://sink.test', method: 'POST', delivery: 'keyed' });
    post.typeVersion = 2;
    doc.nodes.push(post);
    doc.connections.push({ id: 'next', from: { node: 'call', port: 'main', index: 0 }, to: { node: 'post', port: 'main', index: 0 } });
    h.activate('parent', h.publish(doc));
    const original = SqliteLedger.prototype.finish;
    const operator = process.env.DRAFLOW_TEST_SHARED ? fx.open('intake') : h;
    const id = start(h);
    t.mock.method(SqliteLedger.prototype, 'finish', function (receipt, ...args) {
      const child = receipt.mode === 'subworkflow';
      if (child && order === 'before') assert.ok(operator.cancel(id));
      original.call(this, receipt, ...args);
      if (child && order === 'after') assert.ok(operator.cancel(id));
    });
    await done(h, id);
    await h.close();
    h = fx.open();
    assert.equal(h.receipt(id).outcome, 'canceled');
    assert.equal(h.relations(id).length, 1);
    assert.equal(h.relations(id)[0].childState, 'finished');
    assert.equal(h.transitions(id).filter(t => t.reason === 'cancelRequested').length, 1);
    assert.equal(h.cancel(id), false);
    assert.equal(sends, 0);
  });
}

test('short job submitted during a batch finishes before the import', async (t) => {
  let h,
    short,
    readCount = 0,
    shortAt;
  const fx = fixture(t, {
    fetch: async (url) => {
      if (new URL(url).hostname === 'source.test') {
        readCount++;
        return pageResponse(url);
      }
      if (!short) short = start(h, 'short');
      if (h.receipt(short).state === 'finished' && shortAt === undefined) shortAt = readCount;
      return Response.json({});
    },
  });
  h = fx.open();
  h.activate('short', h.publish(flow('short', [node('start', 'manualTrigger')])));
  h.publish(child([node('send', 'httpRequest', { url: 'https://sink.test' })]));
  h.activate('parent', h.publish(pages()));
  const id = start(h);
  await done(h, id);
  assert.ok(shortAt < 11);
});
test('child failure follows the parent node error policies', async (t) => {
  const h = fixture(t).open();
  h.publish(child([node('bad', 'wait', { mode: 'event', dueAt: 'invalid' })]));
  for (const policy of ['stop', 'continue', 'errorOutput']) {
    const doc = parent();
    doc.nodes[1].settings = { onError: policy };
    doc.nodes.push(node('handler', 'noOp'));
    doc.connections.push({
      id: 'handler',
      from: { node: 'call', port: policy === 'errorOutput' ? 'error' : 'main', index: 0 },
      to: { node: 'handler', port: 'main', index: 0 },
    });
    h.activate('parent', h.publish(doc));
    const id = start(h);
    await done(h, id);
    assert.equal(h.receipt(id).outcome, policy === 'stop' ? 'error' : 'success');
    const history = await h.history.get('parent', id);
    assert.equal(history.tasks.at(-1).nodeId, policy === 'stop' ? 'call' : 'handler');
  }
});
test('canceling a parent in review preserves child reconciliation without later sends', async (t) => {
  let sends = 0;
  const fx = fixture(t, {
    fetch: async () => {
      sends++;
      throw Error('lost');
    },
  });
  let h = fx.open();
  const write = node('post', 'httpRequest', { method: 'POST', delivery: 'manual', url: 'https://sink.test' });
  write.typeVersion = 2;
  h.publish(child([write]));
  h.activate('parent', h.publish(parent()));
  const id = start(h);
  await until(() => h.relations(id)[0]?.childState === 'review');
  const { child: k } = h.relations(id)[0];
  const key = h.effects(k)[0].key;
  assert.ok(h.cancel(id));
  await done(h, id);
  assert.equal(h.inspect(id).uncertain[0].key, key);
  await h.close();
  h = fx.open();
  assert.ok(h.reconcile(k, key, 'applied', {}));
  await done(h, k);
  assert.equal(h.receipt(k).outcome, 'canceled');
  assert.equal(sends, 1);
  assert.equal(h.inspect(id).uncertain.length, 0);
});

test('child output preserves filtered origins and aggregate many-to-one links', async (t) => {
  const h = fixture(t).open();
  const keep = node('keep', 'filter', {
    conditions: { combinator: 'and', conditions: [{ left: '={{ $json.n }}', operator: 'gt', right: 1 }] },
  });
  h.publish(child([keep, node('all', 'aggregate')]));
  h.activate('parent', h.publish(parent()));
  const id = start(
    h,
    'parent',
    [1, 2, 3].map((n) => ({ json: { n } })),
  );
  await done(h, id);
  const item = (await h.history.get('parent', id)).tasks.at(-1).task.output.main[0][0];
  assert.deepEqual(
    item.pairedItem.map((p) => p.item),
    [1, 2],
  );
  const empty = start(h, 'parent', [{ json: { n: 0 } }]);
  await done(h, empty);
  assert.deepEqual((await h.history.get('parent', empty)).tasks.at(-1).task.output.main[0], []);
  const doc = parent();
  doc.nodes[0] = node('start', 'webhook', { path: 'empty-input' });
  h.activate('parent', h.publish(doc));
  const noInput = start(h, 'parent', []);
  await done(h, noInput);
  assert.equal(h.receipt(noInput).outcome, 'success');
  assert.deepEqual(h.relations(noInput), []);
});

test('child uses its own grant and a draft test URL cannot acquire its parent identity', async (t) => {
  let reads = 0;
  const grants = [
    { id: 'service', kind: 'bearer', workflowId: 'parent', nodeId: 'read', origin: 'https://api.test' },
  ];
  const h = fixture(t, {
    httpAuth: { grants, resolve: () => 'test-secret' },
    fetch: async (_url, init) => {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-secret');
      reads++;
      return Response.json({});
    },
  }).open();
  const read = node('read', 'httpRequest', { url: 'https://api.test/data', authentication: 'credential' });
  read.typeVersion = 2;
  read.credentials = { httpAuth: 'service' };
  h.publish(child([read]));
  const doc = parent();
  h.activate('parent', h.publish(doc));
  const first = start(h);
  await done(h, first);
  assert.equal(h.receipt(first).outcome, 'error');
  assert.equal(reads, 0);
  grants.push({ ...grants[0], workflowId: 'child' });
  const second = start(h);
  await done(h, second);
  assert.equal(h.receipt(second).outcome, 'success');
  assert.equal(reads, 2);
  doc.nodes[0] = node('start', 'webhook', { path: 'test-call' });
  assert.throws(() => h.listenTest(doc, 'start'), /permission/);
});

test('pre-Phase-5 queued, waiting, interrupted and review receipts survive schema upgrade', async (t) => {
  let sends = 0;
  const fx = fixture(t, {
    fetch: async () => {
      sends++;
      throw Error('lost');
    },
  });
  let h = fx.open();
  const w = flow('waiter', [
    node('start', 'manualTrigger'),
    node('wait', 'wait', { dueAt: Date.now() + 60000 }),
  ]);
  const post = node('post', 'httpRequest', { delivery: 'manual', url: 'https://sink.test' });
  post.typeVersion = 2;
  for (const d of [
    w,
    flow('sender', [node('start', 'manualTrigger'), post]),
    flow('short', [node('start', 'manualTrigger')]),
  ])
    h.activate(d.id, h.publish(d));
  const wait = start(h, 'waiter'),
    review = start(h, 'sender', [{ json: {} }]);
  await until(() => h.receipt(review).state === 'review');
  const queued = start(h, 'short'),
    interrupted = start(h, 'short');
  await h.close();
  const sql = new DatabaseSync(fx.db);
  sql.exec(
    'DROP TABLE calls; DROP TABLE pageRuns; DROP TABLE seenCursors; DROP TABLE canceledRuns; DROP TABLE readyAfter',
  );
  sql.prepare("UPDATE runs SET state='interrupted' WHERE runId=?").run(interrupted);
  sql.close();
  h = fx.open();
  assert.equal(h.receipt(interrupted).state, 'interrupted');
  assert.equal(h.receipt(review).state, 'review');
  assert.equal(h.receipt(wait).state, 'waiting');
  await done(h, queued);
  assert.ok(h.resolveWait(wait, h.waitInfo(wait).token, 'event'));
  await done(h, wait);
  assert.ok(h.reconcile(review, h.effects(review)[0].key, 'applied', {}));
  await done(h, review);
  assert.equal(sends, 1);
});

test('cancel after a keyed retry is queued preserves review and worker availability', async (t) => {
  let sends = 0;
  let fault;
  const fx = fixture(t, {
    fetch: async () => { sends++; throw Error('reply lost'); },
    onWorkerError: (error) => { fault = error; },
  });
  let h = fx.open();
  const write = node('post', 'httpRequest', { method: 'POST', delivery: 'keyed', url: 'https://sink.test' });
  write.typeVersion = 2;
  h.publish(child([write]));
  h.activate('parent', h.publish(parent()));
  const id = start(h, 'parent', [{ json: {} }]);
  await until(() => h.relations(id)[0]?.childState === 'review');
  const k = h.relations(id)[0].child;
  const key = h.effects(k)[0].key;
  assert.ok(h.reconcile(k, key, 'retryKeyed'));
  assert.ok(h.cancel(id));
  await until(() => fault || (h.receipt(k).state === 'review' && h.receipt(id).state === 'finished'));
  assert.ifError(fault);
  await h.close();
  h = fx.open();
  assert.equal(h.inspect(id).uncertain[0].key, key);
  assert.ok(h.reconcile(k, key, 'applied'));
  await done(h, k);
  assert.equal(sends, 1);
  h.activate('short', h.publish(flow('short', [node('start', 'manualTrigger')])));
  await done(h, start(h, 'short'));
});

test('cancel at a successful batch commit counts it without dispatching another page', async (t) => {
  let reads = 0;
  const fx = fixture(t, { fetch: async (url) => { reads++; return pageResponse(url, 2); } });
  let h = fx.open();
  h.publish(child());
  h.activate('parent', h.publish(pages({ batchSize: 1, pageSize: 1 })));
  const id = start(h);
  const finish = SqliteLedger.prototype.finish;
  t.mock.method(SqliteLedger.prototype, 'finish', function (receipt, ...args) {
    if (receipt.mode === 'subworkflow') assert.ok(h.cancel(id));
    return finish.call(this, receipt, ...args);
  });
  await done(h, id);
  await h.close();
  h = fx.open();
  const { pages: complete, batches, items, total } = h.progress(id)[0];
  assert.deepEqual([complete, batches, items, total], [1, 1, 1, 1]);
  assert.equal(h.receipt(id).outcome, 'canceled');
  assert.equal(h.relations(id).length, 1);
  assert.equal(reads, 1);
});

test('throttled page uses Retry-After even when its error body exceeds the data limit', async (t) => {
  const clock = fakeClock();
  let reads = 0;
  const h = fixture(t, { scheduleClock: clock, maxHttpResponseBytes: 100, fetch: async () => {
    if (++reads === 1) return new Response('x'.repeat(101), { status: 429, headers: { 'Retry-After': '5' } });
    return Response.json({ items: [], nextCursor: null });
  } }).open();
  h.publish(child());
  h.activate('parent', h.publish(pages()));
  const id = start(h);
  await until(() => h.progress(id)[0]?.retryAt || h.receipt(id).state === 'finished');
  assert.equal(h.progress(id)[0].retryAt, clock.now() + 5000);
  clock.advance(5000);
  await done(h, id);
  assert.equal(h.receipt(id).outcome, 'success');
  assert.equal(reads, 2);
});

test('reopening validates node versions in pinned children before accepting work', async (t) => {
  const { open, db } = fixture(t);
  const h = open();
  h.publish(child([node('child-only', 'noOp')]));
  h.activate('parent', h.publish(parent()));
  await h.close();
  const registry = new NodeRegistry().registerAll(standardNodes.filter(n => n.type !== 'draflow.noOp'));
  let incompatible;
  try {
    assert.throws(() => { incompatible = new NodeHost(db, { registry }); }, /child-only.*draflow.noOp/);
  } finally {
    await incompatible?.close();
  }
  const restored = open();
  const id = start(restored);
  await done(restored, id);
  assert.equal(restored.receipt(id).outcome, 'success');
});

test('shared merge ancestry returns both original rows within the worker time budget', async (t) => {
  const h = fixture(t).open();
  const merges = Array.from({ length: 25 }, (_, i) =>
    node('merge' + i, 'merge', { mode: 'mergeByKey', key: 'n' }));
  const doc = child(merges);
  for (const edge of [...doc.connections]) {
    if (edge.to.node === 'return') continue;
    doc.connections.push({ ...edge, id: edge.id + '-right', to: { ...edge.to, index: 1 } });
  }
  h.publish(doc);
  h.activate('parent', h.publish(parent()));
  const id = start(h);
  await done(h, id);
  assert.equal(h.receipt(id).outcome, 'success');
  const rows = (await h.history.get('parent', id)).tasks.at(-1).task.output.main[0];
  assert.deepEqual(rows.map(row => [row.json.n, row.pairedItem.item]), [[1, 0], [2, 1]]);
});
