import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { open, publish, accept } from './compensation-fixture.mjs';
import { until } from './fixture.mjs';
for (const auto of [false, true])
  test(
    'compensation uses original IDs, pinned order, and retries only unsent release; auto=' + auto,
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'draflow-undo-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const db = join(dir, 'host.db'),
        writes = [];
      let available = false;
      const boot = () => {
        const h = open(
          db,
          async (url, init) => {
            const name = new URL(url).pathname.slice(1);
            writes.push({
              name,
              key: new Headers(init.headers).get('Idempotency-Key'),
              body: JSON.parse(init.body),
            });
            return Response.json({ id: name + '-123' });
          },
          (grant) => (grant === 'release' && available ? 'available-secret' : undefined),
        );
        t.after(() => h.close());
        return h;
      };
      let h = boot();
      publish(h, auto);
      const root = accept(h);
      assert.equal(accept(h), root);
      await until(() => h.receipt(root).state === 'finished');
      assert.equal(h.receipt(root).outcome, 'error');
      const [point] = h.recoveryInfo(root);
      if (!auto) assert.equal(h.compensationInfo(root).state, 'idle');
      const id = h.compensate(root);
      assert.equal(h.compensate(root), id);
      assert.throws(() => h.redrive(root, point.failure), /Compensation/);
      await until(() => h.compensationInfo(root).state === 'manual');
      const failure = h.compensationInfo(root).steps[1].failure;
      await h.close();
      h = boot();
      assert.equal(h.compensate(root), id);
      available = true;
      const attempt = h.retryCompensation(root, failure);
      assert.equal(h.retryCompensation(root, failure), attempt);
      await until(() => h.compensationInfo(root).state === 'compensated');
      assert.deepEqual(
        writes.map((w) => w.name),
        ['reserve', 'charge', 'refund', 'release'],
      );
      assert.equal(writes[2].body.result.id, 'charge-123');
      assert.equal(writes[3].body.result.id, 'reserve-123');
      assert.equal(new Set(writes.map((w) => w.key)).size, 4);
      assert.equal(h.compensationInfo(root).outcome, 'error');
    },
  );

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const mode of ['keyed', 'manual'])
  test('SIGKILL after remote refund, before local confirmation: ' + mode, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'undo-crash-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const run = (phase) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./compensation-process.mjs', import.meta.url)),
          join(dir, 'host.db'),
          phase,
          mode,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
    const first = run('kill');
    assert.equal(first.signal, 'SIGKILL', first.stderr);
    const next = run('resume');
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(JSON.parse(next.stdout), ['reserve', 'charge', 'refund', 'release']);
  });

test('cancel during unconfirmed charge waits for reconciliation and never initiates refund', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'undo-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writes = [];
  const h = open(
    join(dir, 'host.db'),
    async (url) => {
      const name = new URL(url).pathname.slice(1);
      writes.push(name);
      if (name === 'charge') throw Error('response lost');
      return Response.json({ id: name + '-123' });
    },
    () => 'opaque-secret',
  );
  t.after(() => h.close());
  publish(h, true);
  const root = accept(h);
  await until(() => h.receipt(root).state === 'review');
  assert.throws(() => h.compensate(root), /settled/);
  assert.equal(h.cancel(root), true);
  const charge = h.effects(root).find((e) => e.state === 'unknown');
  assert.ok(h.reconcile(root, charge.key, 'applied', { id: 'charge-123' }));
  await until(() => h.receipt(root).state === 'finished');
  assert.equal(h.receipt(root).outcome, 'canceled');
  assert.deepEqual(writes, ['reserve', 'charge']);
  assert.equal(h.compensationInfo(root).steps.length, 2);
  h.compensate(root);
  await until(() => h.compensationInfo(root).state === 'compensated');
  assert.deepEqual(writes, ['reserve', 'charge', 'refund', 'release']);
});

test('accepted redrive excludes concurrent compensation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'undo-redrive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let enabled = false;
  const writes = [];
  const h = open(
    join(dir, 'host.db'),
    async (url) => {
      writes.push(new URL(url).pathname.slice(1));
      return Response.json({ id: 'receipt' });
    },
    () => (enabled ? 'opaque-secret' : undefined),
  );
  t.after(() => h.close());
  publish(h);
  const root = accept(h);
  await until(() => h.receipt(root).state === 'finished');
  enabled = true;
  const [point] = h.recoveryInfo(root);
  const attempt = h.redrive(root, point.failure);
  assert.throws(() => h.compensate(root), /settled/);
  assert.equal(h.redrive(root, point.failure), attempt);
  await until(() => h.receipt(root).state === 'finished');
  assert.deepEqual(writes, ['reserve', 'charge', 'ship']);
});

test('conditional reversal is scoped to the original reservation and leaves later orders intact', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'undo-conditional-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reservations = new Set(),
    writes = [];
  const h = open(
    join(dir, 'host.db'),
    async (url, init) => {
      const op = new URL(url).pathname.slice(1);
      writes.push(op);
      if (op === 'reserve') reservations.add('original');
      if (op === 'release') {
        assert.deepEqual(JSON.parse(init.body).result, { id: 'original' });
        reservations.delete('original');
      }
      return Response.json({ id: 'original' });
    },
    (grant) => (grant === 'release' ? 'opaque-secret' : undefined),
  );
  t.after(() => h.close());
  publish(h, false, false, (root) => {
    root.nodes[1].parameters.compensation.when = { field: 'order', equals: 1 };
    root.nodes[2].parameters.compensation.when = { field: 'refundable', equals: true };
  });
  const root = accept(h);
  await until(() => h.receipt(root).state === 'finished');
  reservations.add('later-order');
  h.compensate(root);
  await until(() => h.compensationInfo(root).state === 'compensated');
  assert.deepEqual([...reservations], ['later-order']);
  assert.deepEqual(writes, ['reserve', 'charge', 'release']);
});

test('publication rejects ambiguous reversal order, branches and an unavailable revision', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'undo-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = open(
    join(dir, 'host.db'),
    async () => Response.json({}),
    () => undefined,
  );
  t.after(() => h.close());
  assert.throws(
    () =>
      publish(h, false, false, (r) => {
        r.nodes[1].parameters.compensation.order = 1;
      }),
    /unique order/,
  );
  assert.throws(
    () =>
      publish(h, false, false, (r) => {
        r.connections[1].from.node = r.nodes[0].id;
      }),
    /linear/,
  );
  assert.throws(() =>
    publish(h, false, false, (r) => {
      r.nodes[1].parameters.compensation.revision = 999;
    }),
  );
});

for (const mode of ['direct', 'nested'])
  test(
    'an interrupted unrecorded shipment does not automatically reverse confirmed charges: ' + mode,
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'undo-interrupted-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const db = join(dir, 'host.db');
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./compensation-process.mjs', import.meta.url)),
          db,
          'interrupt-shipment',
          mode,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const root = readFileSync(db + '.id', 'utf8');
      const h = open(
        db,
        async () => Response.json({}),
        () => 'secret',
      );
      t.after(() => h.close());
      await until(() => ['finished', 'interrupted'].includes(h.receipt(root).state));
      assert.equal(h.receipt(root).state, 'interrupted');
      assert.equal(h.compensationInfo(root).id, null);
      assert.throws(() => h.compensate(root), /settled/);
    },
  );
