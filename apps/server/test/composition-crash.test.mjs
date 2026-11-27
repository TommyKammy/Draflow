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
    const attempts = readFileSync(db + '.attempts', 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
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
for (const phase of ['lost-response', 'last-batch', 'after-token']) {
  test('incremental sync survives SIGKILL ' + phase, (t) => {
    const db = setup(t);
    assert.equal(run(db, phase, 'sync').signal, 'SIGKILL');
    const recovered = run(db, 'resume', 'sync');
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).outcome, 'success');
    const records = (suffix) =>
      readFileSync(db + suffix, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
    const writes = records('.writes');
    assert.deepEqual(
      writes.map((w) => Number(w.id)),
      Array.from({ length: 1003 }, (_, i) => i + 1),
    );
    const expected = [...writes];
    if (phase === 'lost-response') expected.splice(626, 0, writes[625]);
    assert.deepEqual(records('.attempts'), expected);
    assert.equal(readFileSync(db + '.next-run', 'utf8'), 'watermark');
  });
}
test('SIGKILL immediately after redrive acceptance preserves one attempt and its successful rows', (t) => {
  const db = setup(t);
  const first = run(db, 'redrive-commit', 'redrive', '100');
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  const second = run(db, 'resume', 'redrive', '100');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).outcome, 'success');
  for (const suffix of ['.attempts', '.writes']) {
    const rows = readFileSync(db + suffix, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      rows.map((r) => r.id),
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
  }
});
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

test('parallel SIGKILL after acceptance reuses the original key', (t) => {
  const db = setup(t);
  const first = run(db, 'lost-response', 'parallel');
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  const second = run(db, 'resume', 'parallel');
  assert.equal(second.status, 0, second.stderr);
  const result = JSON.parse(second.stdout);
  assert.equal(result.outcome, 'success');
  const records = (suffix) =>
    readFileSync(db + suffix, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
  const writes = records('.writes');
  assert.deepEqual(
    writes.map((w) => Number(w.id)).sort((a, b) => a - b),
    Array.from({ length: 1003 }, (_, i) => i + 1),
  );
  assert.equal(readFileSync(db + '.next-run', 'utf8'), 'watermark');
  const keys = new Map(writes.map((w) => [w.id, w.key]));
  for (const a of records('.attempts')) assert.equal(a.key, keys.get(a.id));
});

test('parallel recovery working set stays within the current page at tenfold volume', (t) => {
  const samples = [1003, 10030].map((count) => {
    const r = run(setup(t), 'measure', 'parallel', String(count));
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.progress[0].items, count);
    assert.equal(s.active, 100);
    return s;
  });
  assert.ok(samples[1].sizes.point < samples[0].sizes.point * 1.05);
  assert.ok(samples[1].sizes.page < samples[0].sizes.page * 1.05);
  console.log('Parallel working set', JSON.stringify(samples));
});
