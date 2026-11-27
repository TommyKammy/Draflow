import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scheduleNode } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { registry, until, workflow } from './fixture.mjs';

function document(parameters, label = 'v1') {
  const doc = workflow(label);
  Object.assign(doc.nodes[0], { type: scheduleNode.type, parameters });
  return doc;
}

function setup(t, start, options = {}) {
  let now = Date.parse(start);
  let timer;
  const dir = mkdtempSync(join(tmpdir(), 'draflow-schedule-'));
  const db = join(dir, 'ledger.db');
  const calls = [];
  const faults = [];
  const scheduleClock = {
    now: () => now,
    arm(callback, delay) {
      const registration = { callback, at: now + delay };
      timer = registration;
      return () => {
        if (registration === timer) timer = undefined;
      };
    },
  };
  function open() {
    return new NodeHost(db, {
      registry: registry((runId, label) => {
        calls.push({ runId, label });
      }).register(scheduleNode),
      onWorkerError: (err) => faults.push(err),
      scheduleClock,
      ...options,
    });
  }
  let host = open();
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function tick() {
    if (timer && timer.at <= now) {
      const { callback } = timer;
      timer = undefined;
      callback();
    }
  }
  return {
    get host() {
      return host;
    },
    db,
    calls,
    faults,
    advance(time) {
      now = Date.parse(time);
      tick();
    },
    reopen() {
      host = open();
      tick();
    },
    install(params) {
      const revision = host.publish(document(params));
      host.activate('flow', revision);
      return revision;
    },
    receipt(time) {
      return host.byEvent('flow', 'a', new Date(time).toISOString());
    },
  };
}

test('interval starts at the activation boundary and preserves phase across repeated activation, close and restart', async (t) => {
  const f = setup(t, '2024-01-01T00:00:00.250Z', { dedupMs: 0 });
  const rev = f.install({ mode: 'interval', intervalSeconds: 10 });
  f.advance('2024-01-01T00:00:10.249Z');
  f.host.activate('flow', rev);
  assert.equal(f.host.stats().queued, 0);
  f.advance('2024-01-01T00:00:10.250Z');
  const first = f.receipt('2024-01-01T00:00:10.250Z');
  await until(() => f.host.receipt(first.runId).state === 'finished');
  assert.equal(first.revision, rev);
  const detail = await f.host.history.get('flow', first.runId);
  assert.deepEqual(
    detail.tasks.map((entry) => entry.nodeId),
    ['a', 'sink'],
  );
  assert.deepEqual(detail.tasks[0].task.output.main[0][0].json, { scheduledAt: first.eventKey });
  await f.host.close();
  f.advance('2024-01-01T00:00:57.000Z');
  f.reopen();
  const latest = f.receipt('2024-01-01T00:00:50.250Z');
  await until(() => f.host.receipt(latest.runId).state === 'finished');
  assert.equal(f.receipt('2024-01-01T00:00:40.250Z'), undefined);
  await f.host.close();
  f.reopen();
  f.advance('2024-01-01T00:01:00.249Z');
  assert.equal(f.calls.length, 2);
  f.advance('2024-01-01T00:01:00.250Z');
  await until(() => f.calls.length === 3);
  f.host.deactivate('flow');
  await f.host.close();
  f.reopen();
  f.advance('2024-01-02T00:00:00Z');
  assert.equal(f.host.stats().queued, 0);
  assert.equal(f.calls.length, 3);
});

test('calendar time skips nonexistent spring minutes, including after downtime', async (t) => {
  const f = setup(t, '2024-03-09T06:00:00Z');
  f.install({ mode: 'cron', cron: '30 2 * * *', timezone: 'America/New_York' });
  f.advance('2024-03-09T07:30:00Z');
  await until(() => f.calls.length === 1);
  await f.host.close();
  f.advance('2024-03-10T08:30:00Z');
  f.reopen();
  assert.equal(f.host.stats().queued, 0);
  f.advance('2024-03-11T06:29:59Z');
  assert.equal(f.host.stats().queued, 0);
  f.advance('2024-03-11T06:30:00Z');
  assert.ok(f.receipt('2024-03-11T06:30:00Z'));
  await until(() => f.calls.length === 2);
});

test('repeated fall minute has one scheduled instant even after restart and dedup expiry', async (t) => {
  const f = setup(t, '2024-11-01T00:00:00Z', { dedupMs: 0 });
  f.install({ mode: 'cron', cron: '30 1 * * *', timezone: 'America/New_York' });
  await f.host.close();
  // The current local clock reads 01:10 again, but the first 01:30 has already passed.
  f.advance('2024-11-03T06:10:00Z');
  f.reopen();
  const first = f.receipt('2024-11-03T05:30:00Z');
  await until(() => f.host.receipt(first.runId).state === 'finished');
  await f.host.close();
  f.advance('2024-11-03T06:30:00Z');
  f.reopen();
  assert.equal(f.host.stats().queued, 0);
  assert.equal(f.receipt('2024-11-03T06:30:00Z'), undefined);
  f.advance('2024-11-04T06:30:00Z');
  await until(() => f.calls.length === 2);
});

test('invalid schedules cannot replace the active revision and disabled triggers create no timers', async (t) => {
  const f = setup(t, '2024-01-01T00:00:00Z');
  const rev = f.install({ intervalSeconds: 5 });
  for (const params of [
    { intervalSeconds: 0 },
    { mode: 'cron', cron: '0 0 * * *' },
    { mode: 'cron', cron: '0 0 * * *', timezone: 'Missing/Zone' },
    { mode: 'cron', cron: '0 0 31 2 *', timezone: 'UTC' },
    { mode: 'cron', cron: 'bad', timezone: 'UTC' },
  ]) {
    assert.throws(() => f.install(params));
  }
  f.advance('2024-01-01T00:00:05Z');
  assert.equal(f.receipt('2024-01-01T00:00:05Z').revision, rev);
  const doc = document({ intervalSeconds: 1 }, 'v2');
  doc.nodes[0].disabled = true;
  f.host.activate('flow', f.host.publish(doc));
  f.advance('2024-01-01T00:00:30Z');
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].label, 'v1');
  assert.equal(f.host.stats().queued, 0);
});

test('queue pressure retries only the latest due time; failed commit rolls back both cursor and run', async (t) => {
  const f = setup(t, '2024-01-01T00:00:00Z', { capacity: 1 });
  f.install({ intervalSeconds: 1 });
  const blocker = f.host.accept('flow', 'b', { items: [{ json: {} }] });
  f.advance('2024-01-01T00:00:01Z');
  assert.equal(f.receipt('2024-01-01T00:00:01Z'), undefined);
  assert.deepEqual(f.faults, []);
  await until(() => f.host.receipt(blocker).state === 'finished');
  f.advance('2024-01-01T00:00:04Z');
  const id = f.receipt('2024-01-01T00:00:04Z').runId;
  await until(() => f.host.receipt(id).state === 'finished');
  await f.host.close();
  const db = new DatabaseSync(f.db);
  db.exec(`CREATE TABLE fault(runId TEXT REFERENCES runs(runId) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_schedule AFTER INSERT ON deliveries BEGIN INSERT INTO fault VALUES('missing'); END;`);
  db.close();
  f.reopen();
  f.advance('2024-01-01T00:00:05Z');
  assert.equal(f.faults.length, 1);
  assert.equal(f.receipt('2024-01-01T00:00:05Z'), undefined);
  await f.host.close();
  const repair = new DatabaseSync(f.db);
  assert.equal(
    repair.prepare('SELECT nextAt FROM schedules').get().nextAt,
    Date.parse('2024-01-01T00:00:05Z'),
  );
  repair.exec('DROP TRIGGER fail_schedule');
  repair.close();
  f.reopen();
  assert.ok(f.receipt('2024-01-01T00:00:05Z'));
  await until(() => f.calls.length === 3);
});

test('cron applies local weekdays and month/day filters, including leap day', async (t) => {
  const f = setup(t, '2024-02-27T00:00:00Z');
  f.install({ mode: 'cron', cron: '15 * * * 3', timezone: 'Asia/Tokyo' });
  f.advance('2024-02-27T15:14:59Z');
  assert.equal(f.host.stats().queued, 0);
  f.advance('2024-02-27T15:15:00Z');
  assert.ok(f.receipt('2024-02-27T15:15:00Z'));
  await until(() => f.calls.length === 1);
  f.install({ mode: 'cron', cron: '45 8 29 2 *', timezone: 'Asia/Kathmandu' });
  f.advance('2024-02-29T03:00:00Z');
  assert.ok(f.receipt('2024-02-29T03:00:00Z'));
  await until(() => f.calls.length === 2);
  await f.host.close();
  f.advance('2032-03-01T00:00:00Z');
  f.reopen();
  assert.ok(f.receipt('2032-02-29T03:00:00Z'));
  assert.equal(f.receipt('2028-02-29T03:00:00Z'), undefined);
  await until(() => f.calls.length === 3);
});

test('normal Node host timer automatically admits a published schedule', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-real-schedule-'));
  const host = new NodeHost(join(dir, 'ledger.db'), { registry: registry().register(scheduleNode) });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const revision = host.publish(document({ intervalSeconds: 1 }));
  host.activate('flow', revision);
  let row;
  const deadline = Date.now() + 10_000;
  while (!row && Date.now() < deadline) {
    [row] = await host.history.list('flow');
    if (!row) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(row?.status, 'success');
  assert.equal(host.receipt(row.id).triggerNodeId, 'a');
  host.deactivate('flow');
});
