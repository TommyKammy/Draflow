import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { receiver } from './journal-child.mjs';
import { until } from './fixture.mjs';

for (const mode of ['manual', 'keyed'])
  for (const boundary of ['before', 'sent', 'saved', 'task-complete', 'untracked']) {
    test('4.3 SIGKILL at second item: ' + mode + '/' + boundary, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'draflow-effect-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, 'host.db');
      const childModule = new URL('./journal-child.mjs', import.meta.url).href;
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const {crashJournal}=await import(process.argv[1]); await crashJournal(...process.argv.slice(2));',
          childModule,
          path,
          mode,
          boundary,
        ],
        { timeout: 10000, encoding: 'utf8' },
      );
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const host = new NodeHost(path, {
        registry: new NodeRegistry().registerAll(standardNodes),
        fetch: receiver(path),
      });
      t.after(() => host.close());
      const id = host.byEvent('send', 'start', 'send').runId;
      if (boundary === 'untracked') {
        assert.equal(host.receipt(id).state, 'interrupted');
        assert.deepEqual(
          readFileSync(path + '.attempts', 'utf8')
            .trim()
            .split('\n')
            .map(JSON.parse)
            .map((op) => op.item),
          [1, 2, 3, 4],
        );
        return;
      }
      if (mode === 'manual' && boundary === 'sent') {
        assert.equal(host.receipt(id).state, 'review');
        assert.deepEqual(
          host.effects(id).map((op) => op.state),
          ['success', 'unknown', 'unsent'],
        );
        const pending = host.effects(id).find((op) => op.state === 'unknown');
        assert.equal(pending.item, 1);
        assert.equal(host.reconcile(id, pending.key, 'retryKeyed'), false);
        assert.equal(host.reconcile(id, pending.key, 'applied', { item: 2 }), true);
        assert.equal(host.reconcile(id, pending.key, 'applied', { item: 2 }), false);
      }
      await until(() => host.receipt(id).state === 'finished');
      assert.equal(host.receipt(id).outcome, 'success');
      const rows = (suffix) =>
        readFileSync(path + suffix, 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse);
      assert.deepEqual(
        rows('.applied').map((op) => op.item),
        [1, 2, 3],
      );
      const attempts = rows('.attempts');
      assert.deepEqual(
        attempts.map((op) => op.item),
        mode === 'keyed' && boundary === 'sent' ? [1, 2, 2, 3] : [1, 2, 3],
      );
      if (attempts.length === 4) assert.equal(attempts[1].key, attempts[2].key);
      assert.deepEqual(
        host.effects(id).map((op) => op.state),
        ['success', 'success', 'success'],
      );
      const detail = await host.history.get('send', id);
      assert.deepEqual(
        detail.tasks.at(-1).task.output.main[0].map((row) => row.json.item),
        [1, 2, 3],
      );
    });
  }

test('failed review commit preserves the unknown operation for restart and reconciliation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-review-commit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'host.db');
  let fault;
  let sends = 0;
  const options = {
    registry: new NodeRegistry().registerAll(standardNodes),
    fetch: async () => {
      sends++;
      throw new Error('transport lost after dispatch');
    },
    onWorkerError: (error) => {
      fault = error;
    },
  };
  let host = new NodeHost(path, options);
  t.after(() => host.close());
  const doc = JSON.parse(readFileSync(new URL('../../../examples/approval.json', import.meta.url)));
  host.activate(doc.id, host.publish(doc));
  await host.close();
  const sql = new DatabaseSync(path);
  sql.exec(`CREATE TRIGGER fail_review BEFORE UPDATE OF state ON runs WHEN NEW.state='review'
    BEGIN SELECT RAISE(ABORT,'simulated commit failure'); END`);
  sql.close();
  host = new NodeHost(path, options);
  const id = host.accept(doc.id, 'start', {
    items: [{ json: { body: { applicationId: 'x', deadline: Date.now() + 60000 } } }],
  });
  await until(() => host.receipt(id).state === 'waiting');
  host.resolveWait(id, host.waitInfo(id).token, 'event', { decision: 'approved' });
  await until(() => fault || host.receipt(id).state === 'finished');
  assert.ok(fault);
  assert.equal(host.receipt(id).state, 'running');
  await host.close();
  const repaired = new DatabaseSync(path);
  repaired.exec('DROP TRIGGER fail_review');
  repaired.close();
  host = new NodeHost(path, options);
  assert.equal(host.receipt(id).state, 'review');
  const [pending] = host.effects(id);
  assert.equal(pending.state, 'unknown');
  assert.ok(host.reconcile(id, pending.key, 'applied', {}));
  await until(() => host.receipt(id).state === 'finished');
  assert.equal(host.receipt(id).outcome, 'success');
  assert.equal(sends, 1);
});

test('a lost live response can be retried without declaring the keyed operation unapplied', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-retry-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = [];
  const host = new NodeHost(join(dir, 'host.db'), {
    registry: new NodeRegistry().registerAll(standardNodes),
    fetch: async (_url, init) => {
      keys.push(new Headers(init.headers).get('idempotency-key'));
      if (keys.length === 1) throw new Error('response lost');
      return Response.json({ registered: true });
    },
  });
  t.after(() => host.close());
  const doc = JSON.parse(readFileSync(new URL('../../../examples/approval.json', import.meta.url)));
  doc.nodes.find((n) => n.id === 'register').parameters.delivery = 'keyed';
  host.activate(doc.id, host.publish(doc));
  const id = host.accept(doc.id, 'start', {
    items: [{ json: { body: { applicationId: 'x', deadline: Date.now() + 60000 } } }],
  });
  await until(() => host.receipt(id).state === 'waiting');
  host.resolveWait(id, host.waitInfo(id).token, 'event', { decision: 'approved' });
  await until(() => host.receipt(id).state === 'review');
  const [pending] = host.effects(id);
  assert.ok(host.reconcile(id, pending.key, 'retryKeyed'));
  assert.equal(host.reconcile(id, pending.key, 'retryKeyed'), false);
  await until(() => host.receipt(id).state === 'finished');
  assert.equal(host.receipt(id).outcome, 'success');
  assert.deepEqual(keys, [pending.key, pending.key]);
});
