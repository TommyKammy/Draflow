// Run from the repository root after building. Uses an isolated on-disk database.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeHost } from '../dist/host.js';
import { event, registry, until, workflow } from './fixture.mjs';

const dir = mkdtempSync(join(tmpdir(), 'draflow-latency-'));
const host = new NodeHost(join(dir, 'bench.db'), { registry: registry() });
try {
  host.activate('flow', host.publish(workflow()));
  const samples = { admission: [], queueWait: [], engine: [] };
  for (let n = 0; n < 100; n++) {
    const start = performance.now();
    const id = host.accept('flow', 'a', { ...event, key: String(n) });
    samples.admission.push(performance.now() - start);
    await until(() => host.receipt(id).state === 'finished');
    const receipt = host.receipt(id);
    const summary = (await host.history.list('flow'))[0];
    samples.queueWait.push(receipt.startedAt - receipt.acceptedAt);
    samples.engine.push(summary.stoppedAt - summary.startedAt);
  }
  for (const [name, values] of Object.entries(samples)) {
    values.sort((a, b) => a - b);
    console.log(name, 'p50', values[49].toFixed(2), 'ms; p95', values[94].toFixed(2), 'ms');
  }
} finally {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
}
