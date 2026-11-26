import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { NodeRegistry } from '@draflow/core';
import { NodeHost } from '../dist/host.js';
import { event, registry, until, workflow } from './fixture.mjs';

function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-r2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'host.db');
}
function open(t, path, options = {}) {
  const host = new NodeHost(path, { registry: registry(), ...options });
  t.after(() => host.close());
  return host;
}
function setup(host) {
  host.activate('flow', host.publish(workflow()));
}

for (const phase of ['before', 'queued', 'running', 'finished']) {
  test('recovers after process kill at ' + phase, async (t) => {
    const path = database(t);
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./crash-child.mjs', import.meta.url)), path, phase],
      { timeout: 10000, encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const db = new DatabaseSync(path);
    const before = db.prepare('SELECT runId,state FROM runs').all();
    // Model downtime longer than the delivery window after an external effect.
    if (phase === 'running') db.prepare('UPDATE deliveries SET expiresAt=0').run();
    db.close();
    assert.deepEqual(
      before.map((r) => r.state),
      phase === 'before' ? [] : [phase],
    );
    let repeats = 0;
    const host = open(t, path, {
      registry: registry(() => {
        repeats++;
      }),
    });
    assert.deepEqual(host.stats().queued, phase === 'queued' ? 1 : 0);
    const id = host.accept('flow', 'a', event);
    assert.equal(host.byEvent('flow', 'a', event.key).runId, id);
    if (before.length) assert.equal(id, before[0].runId);
    await until(() => ['finished', 'interrupted'].includes(host.receipt(id).state));
    const interrupted = phase === 'running';
    assert.equal(host.stats().interrupted, Number(interrupted));
    assert.equal(repeats, Number(phase === 'before' || phase === 'queued'));
    const effects = existsSync(path + '.effects')
      ? readFileSync(path + '.effects', 'utf8')
          .trim()
          .split('\n')
      : [];
    assert.equal(effects.length + repeats, 1);
    if (effects.length) assert.equal(JSON.parse(effects[0]).id, id);
    const [summary] = await host.history.list('flow');
    assert.equal(summary.id, id);
    assert.equal(summary.status, interrupted ? 'error' : 'success');
    assert.equal(summary.hasDetail, true);
    const detail = await host.history.get('flow', id);
    assert.equal(detail.workflow.id, 'flow');
    if (interrupted) assert.equal(detail.error.name, 'InterruptedExecution');
    else {
      assert.deepEqual(
        detail.tasks.map((task) => task.nodeId),
        ['a', 'sink'],
      );
      assert.deepEqual(detail.tasks[1].task.output.main[0][0].json, { value: 'first', input: { order: 42 } });
    }
    await host.history.delete('flow', id);
    assert.equal(host.accept('flow', 'a', event), id);
  });
}

test('serializes competing accepts, checks duplicates before capacity, and pins queued revisions', async (t) => {
  const path = database(t);
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const host = open(t, path, {
    capacity: 1,
    registry: registry(async (id, value) => {
      calls.push(value);
      await gate;
    }),
  });
  setup(host);
  const ids = await Promise.all(Array.from({ length: 32 }, async () => host.accept('flow', 'a', event)));
  assert.equal(new Set(ids).size, 1);
  assert.throws(() => host.accept('flow', 'b', event), /Queue full/);
  assert.throws(() => new NodeHost(path, { registry: registry() }), /locked/);
  await until(() => calls.length === 1);
  const second = host.accept('flow', 'b', event);
  host.activate('flow', host.publish(workflow('second')));
  host.deactivate('flow');
  assert.equal(host.receipt(second).state, 'queued');
  assert.throws(() => host.accept('flow', 'a', event), /Inactive/);
  release();
  await until(() => host.receipt(second).state === 'finished');
  assert.deepEqual(calls, ['first', 'first']);
  host.activate('flow', 2);
  const third = host.accept('flow', 'a', { items: event.items });
  await until(() => host.receipt(third).state === 'finished');
  assert.equal(host.receipt(third).revision, 2);
  assert.deepEqual(calls, ['first', 'first', 'second']);
});

test('rolls back both queue row and delivery on a SQLite write failure and accepts a retry', async (t) => {
  const path = database(t);
  const initial = open(t, path);
  setup(initial);
  await initial.close();
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER fail BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'write failure'); END");
  db.close();
  const failed = open(t, path);
  assert.throws(() => failed.accept('flow', 'a', event), /write failure/);
  assert.equal(failed.stats().queued, 0);
  await failed.close();
  const repair = new DatabaseSync(path);
  assert.equal(repair.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
  repair.exec('DROP TRIGGER fail');
  repair.close();
  const host = open(t, path);
  const id = host.accept('flow', 'a', event);
  await until(() => host.receipt(id).state === 'finished');
});

test('dedup expiry, independent keyless deliveries and bounded history detail', async (t) => {
  const host = open(t, database(t), { dedupMs: 0, maxDetailBytes: 0 });
  setup(host);
  const first = host.accept('flow', 'a', event);
  assert.equal(host.accept('flow', 'a', event), first);
  await until(() => host.receipt(first).state === 'finished');
  assert.notEqual(host.accept('flow', 'a', event), first);
  assert.notEqual(host.accept('flow', 'a', { items: [] }), host.accept('flow', 'a', { items: [] }));
  assert.equal((await host.history.list('flow'))[0].hasDetail, false);
  assert.equal(await host.history.get('flow', first), null);
});

test('closes intake before waiting and leaves a queued run for restart after the deadline', async (t) => {
  const path = database(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const host = open(t, path, { registry: registry(() => gate) });
  setup(host);
  const first = host.accept('flow', 'a', event);
  const second = host.accept('flow', 'b', event);
  await until(() => host.receipt(first).state === 'running');
  const stop = host.close(5);
  assert.throws(() => host.accept('flow', 'a', event), /stopping/);
  await assert.rejects(stop, /deadline/);
  assert.throws(() => new NodeHost(path, { registry: registry() }), /locked/);
  release();
  await host.close();
  const restarted = open(t, path);
  assert.equal(restarted.receipt(first).state, 'finished');
  assert.equal(restarted.receipt(second).state, 'queued');
  await until(() => restarted.receipt(second).state === 'finished');
});

test('completion commit failure leaves the claim recoverable without repeating external effects', async (t) => {
  const path = database(t);
  const first = open(t, path);
  setup(first);
  await first.close();
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER fail_finish BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT,'history unavailable'); END",
  );
  db.close();
  let fault;
  let calls = 0;
  const failed = open(t, path, {
    registry: registry(() => {
      calls++;
    }),
    onWorkerError: (err) => {
      fault = err;
    },
  });
  const id = failed.accept('flow', 'a', event);
  await until(() => fault);
  assert.equal(failed.receipt(id).state, 'running');
  assert.throws(() => failed.accept('flow', 'b', event), /Worker stopped/);
  await failed.close();
  const repair = new DatabaseSync(path);
  repair.exec('DROP TRIGGER fail_finish');
  repair.close();
  const restarted = open(t, path, {
    registry: registry(() => {
      calls++;
    }),
  });
  assert.equal(restarted.receipt(id).state, 'interrupted');
  assert.equal(calls, 1);
  assert.equal((await restarted.history.list('flow', 'error'))[0].interrupted, true);
});

test('a deferred SQLite constraint failing at admission COMMIT does not acknowledge a run', async (t) => {
  const path = database(t);
  const first = open(t, path);
  setup(first);
  await first.close();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE fault(runId TEXT REFERENCES runs(runId) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_commit AFTER INSERT ON deliveries BEGIN INSERT INTO fault VALUES('missing'); END;`);
  db.close();
  const host = open(t, path);
  assert.throws(() => host.accept('flow', 'a', event), /FOREIGN KEY/);
  assert.equal(host.stats().queued, 0);
  await host.close();
  const check = new DatabaseSync(path);
  for (const table of ['runs', 'deliveries', 'fault']) {
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n, 0);
  }
  check.close();
});

test('restart checks a queued inactive publication before allowing new intake', async (t) => {
  const path = database(t);
  const first = open(t, path);
  setup(first);
  const id = first.accept('flow', 'b', event);
  first.deactivate('flow');
  await first.close();
  assert.throws(() => new NodeHost(path, { registry: new NodeRegistry() }), /requires event@1/);
  const restored = open(t, path);
  await until(() => restored.receipt(id).state === 'finished');
});

test('engine failure is recorded once and the worker continues with the next job', async (t) => {
  let attempts = 0;
  const host = open(t, database(t), {
    registry: registry(() => {
      if (++attempts === 1) throw new Error('rejected by destination');
    }),
  });
  setup(host);
  const failed = host.accept('flow', 'a', event);
  const succeeded = host.accept('flow', 'b', event);
  await until(() => host.receipt(succeeded).state === 'finished');
  assert.equal(host.stats().failed, 1);
  assert.equal(host.receipt(failed).outcome, 'error');
  const detail = await host.history.get('flow', failed);
  assert.match(detail.error.message, /rejected by destination/);
  assert.equal(host.accept('flow', 'a', event), failed);
  assert.equal(attempts, 2);
});

test('rejects invalid event keys, modes and item envelopes before durable admission', async (t) => {
  const host = open(t, database(t));
  setup(host);
  for (const invalid of [
    { ...event, key: 42 },
    { ...event, key: null },
    { ...event, mode: 'manual' },
    { ...event, items: [null] },
    { ...event, items: [{ json: [] }] },
  ]) {
    assert.throws(() => host.accept('flow', 'a', invalid));
  }
  assert.equal(host.stats().queued, 0);
  const id = host.accept('flow', 'a', { ...event, key: '42' });
  await until(() => host.receipt(id).state === 'finished');
});

test('uses the host clock for receipt transitions and the injected engine clock for execution history', async (t) => {
  const host = open(t, database(t), { clock: { now: () => 100, sleep: async () => {} } });
  setup(host);
  const id = host.accept('flow', 'a', event);
  await until(() => host.receipt(id).state === 'finished');
  const receipt = host.receipt(id);
  assert.ok(receipt.stoppedAt >= receipt.startedAt);
  assert.equal((await host.history.list('flow'))[0].stoppedAt, 100);
});
