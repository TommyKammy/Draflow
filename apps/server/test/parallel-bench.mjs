// Run once per process to measure peak RSS independently for each sample.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
if (!process.argv[2]) {
  const samples = [];
  for (let trial = 0; trial < 5; trial++) {
    for (const concurrency of [1, 4]) {
      const result = JSON.parse(
        execFileSync(process.execPath, [process.argv[1], String(concurrency)], {
          encoding: 'utf8',
          timeout: 30000,
        }),
      );
      samples.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const median = (c) =>
    samples
      .filter((s) => s.concurrency === c)
      .map((s) => s.ms)
      .sort((a, b) => a - b)[2];
  const ratio = median(4) / median(1);
  console.log('Parallel / sequential median', ratio);
  assert.ok(ratio <= 0.6);
  process.exit(0);
}
const example = (id) =>
  JSON.parse(readFileSync(new URL('../../../examples/' + id + '.json', import.meta.url)));
const c = Number(process.argv[2] ?? 1),
  dir = mkdtempSync(join(tmpdir(), 'parallel-bench-')),
  db = join(dir, 'bench.db');
const rows = new Map();
const h = new NodeHost(db, {
  registry: new NodeRegistry().registerAll(standardNodes),
  fetch: async (url, init) => {
    if (init.method === 'POST') {
      await delay(2);
      const row = JSON.parse(init.body);
      assert.ok(!rows.has(row.id));
      rows.set(row.id, row.version);
      return Response.json({});
    }
    const at = Number(new URL(url).searchParams.get('cursor') ?? 0);
    return Response.json({
      items: Array.from({ length: Math.min(100, 1003 - at) }, (_, i) => ({
        id: String(at + i),
        version: 1,
        amount: 1,
        op: 'upsert',
      })),
      nextCursor: at + 100 < 1003 ? String(at + 100) : null,
      syncToken: 'done',
    });
  },
});
try {
  const p = example('order-import'),
    child = example('process-order-batch');
  const short = { ...structuredClone(p), id: 'short', nodes: [p.nodes[0]], connections: [] };
  h.activate(short.id, h.publish(short));
  Object.assign(p.nodes[1].parameters, { concurrency: c, syncScope: 'bench', keyLifetimeMs: 86400000 });
  h.publish(child);
  h.activate(p.id, h.publish(p));
  const event = { items: [{ json: {} }] };
  const start = performance.now(),
    root = h.accept(p.id, 'schedule', event),
    admission = [],
    queue = [];
  for (let i = 0; i < 25; i++) {
    await delay(5);
    const t = performance.now(),
      id = h.accept(short.id, 'schedule', event);
    admission.push(performance.now() - t);
    while (h.receipt(id).state !== 'finished') await delay(1);
    const r = h.receipt(id);
    queue.push(r.startedAt - r.acceptedAt);
    assert.notEqual(h.receipt(root).state, 'finished');
  }
  while (h.receipt(root).state !== 'finished') await delay(2);
  const ms = performance.now() - start;
  assert.equal(h.receipt(root).outcome, 'success');
  assert.equal(h.progress(root)[0].total, 1003);
  assert.equal(h.relations(root).length, 41);
  assert.deepEqual(
    [...rows.keys()].map(Number).sort((a, b) => a - b),
    Array.from({ length: 1003 }, (_, i) => i),
  );
  assert.ok([...rows.values()].every((v) => v === 1));
  await h.close();
  console.log(
    JSON.stringify({
      concurrency: c,
      ms,
      rssKiB: process.resourceUsage().maxRSS,
      dbBytes: statSync(db).size,
      admissionP95: admission.sort((a, b) => a - b)[23],
      queueP95: queue.sort((a, b) => a - b)[23],
    }),
  );
} finally {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
}
