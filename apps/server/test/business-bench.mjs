// Compare the same synchronous durable admission on a built checkout, without worker drain time.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2] ?? '.');
const { NodeHost } = await import(pathToFileURL(join(root, 'apps/server/dist/host.js')));
const { registry, workflow } = await import(pathToFileURL(join(root, 'apps/server/test/fixture.mjs')));
const { standardNodes } = await import('@draflow/nodes');
const url = process.env.DRAFLOW_TEST_POSTGRES;
for (const kind of ['ordinary', 'business']) {
  if (kind === 'business' && !NodeHost.prototype.acceptBusiness) continue;
  const dir = mkdtempSync(join(tmpdir(), 'admit-bench-')),
    organization = randomUUID();
  const host = new NodeHost(join(dir, 'db'), {
    registry: registry().registerAll(standardNodes),
    organization,
    capacity: 300,
    ...(url && { shared: { organization, connectionString: url, role: 'intake' } }),
  });
  try {
    if (kind === 'ordinary') host.activate('flow', host.publish(workflow()));
    const samples = [],
      ids = new Set();
    for (let i = 0; i < 220; i++) {
      const event = String(i);
      const start = performance.now();
      const id =
        kind === 'business'
          ? host.acceptBusiness({
              organization,
              project: 'p',
              rule: 'r',
              revision: 1,
              event,
              proposal: { task: 't', version: i + 1 },
            })
          : host.accept('flow', 'a', { key: event, items: [{ json: { task: 't', version: i + 1 } }] });
      if (i >= 20) samples.push(performance.now() - start);
      ids.add(id);
    }
    assert.equal(ids.size, 220);
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        backend: url ? 'postgres' : 'sqlite',
        kind,
        samples: samples.length,
        p95Ms: samples[189],
      }),
    );
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
