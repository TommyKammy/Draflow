import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./composition-process.mjs', import.meta.url));
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-child-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'ledger.db');
}
function run(db, ...args) {
  return spawnSync(process.execPath, [script, db, ...args], { encoding: 'utf8', timeout: 130000 });
}
for (const phase of [
  'before-admit',
  'after-admit',
  'before-return',
  'after-return',
  'page-seven',
  'last-batch',
  'lost-response',
]) {
  test('durable composition SIGKILL ' + phase, (t) => {
    const db = setup(t),
      pages = ['page-seven', 'last-batch', 'lost-response'].includes(phase),
      shape = pages ? 'pages' : 'call';
    const first = run(db, phase, shape);
    assert.equal(first.signal, 'SIGKILL', first.stderr);
    const second = run(db, 'resume', shape);
    assert.equal(second.status, 0, second.stderr);
    const result = JSON.parse(second.stdout);
    assert.equal(result.outcome, 'success');
    assert.equal(result.children, pages ? 41 : 1);
    const writes = readFileSync(db + '.writes', 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      writes.map((w) => w.id),
      Array.from({ length: pages ? 1003 : 1 }, (_, i) => i + 1),
    );
    assert.equal(new Set(writes.map((w) => w.key)).size, writes.length);
    const attempts = readFileSync(db + '.attempts', 'utf8').trim().split('\n').map(JSON.parse);
    const expected = [...writes];
    if (phase === 'lost-response') expected.splice(626, 0, writes[625]);
    assert.deepEqual(attempts, expected);
    if (pages)
      assert.deepEqual(
        readFileSync(db + '.reads', 'utf8')
          .trim()
          .split('\n')
          .map(Number),
        Array.from({ length: 11 }, (_, i) => 100 * i),
      );
  });
}
test('10x pages retain one page and bounded per-run checkpoints', (t) => {
  const samples = [1003, 10030].map((count) => {
    const r = run(setup(t), 'measure', 'pages', String(count));
    assert.equal(r.status, 0, r.stderr);
    const sample = JSON.parse(r.stdout);
    assert.equal(sample.progress[0].items, count);
    assert.ok(sample.progress[0].bytes > 8 * 1024 * 1024);
    assert.ok(sample.sizes.point < 8 * 1024 * 1024);
    assert.ok(sample.sizes.page < 1024 * 1024);
    return sample;
  });
  assert.ok(samples[1].sizes.point < samples[0].sizes.point * 1.05);
  assert.ok(samples[1].sizes.page < samples[0].sizes.page * 1.05);
  console.log('Page working set', JSON.stringify(samples));
});
