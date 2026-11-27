// A separate process owns SQLite. Tests stop it at durable boundaries and start a new owner.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { SqliteLedger } from '../dist/sqlite.js';
import { setTimeout as delay } from 'node:timers/promises';
const [db, phase, shape, countText = '1003'] = process.argv.slice(2);
const count = Number(countText),
  measuring = phase === 'measure';
const load = (id) => JSON.parse(readFileSync(new URL('../../../examples/' + id + '.json', import.meta.url)));
const registry = new NodeRegistry().registerAll(standardNodes);
// The receiver persists accepted keys independently of the workflow checkpoint.
const writesPath = db + '.writes';
const accepted = new Set(existsSync(writesPath)
  ? readFileSync(writesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).key)
  : []);
const options = {
  registry,
  fetch: async (url, init) => {
    if (new URL(url).hostname === 'source.example.test') {
      const at = Number(new URL(url).searchParams.get('cursor') ?? 0);
      if (!measuring) appendFileSync(db + '.reads', at + '\n');
      return Response.json({
        items: Array.from({ length: Math.min(100, count - at) }, (_, i) => ({
          id: at + i + 1,
          amount: 1,
          ...(measuring && { padding: 'x'.repeat(8500) }),
        })),
        nextCursor: at + 100 < count ? String(at + 100) : null,
      });
    }
    const { id } = JSON.parse(init.body);
    const key = new Headers(init.headers).get('idempotency-key');
    const record = JSON.stringify({ id, key }) + '\n';
    appendFileSync(db + '.attempts', record);
    if (!accepted.has(key)) {
      appendFileSync(writesPath, record);
      accepted.add(key);
    }
    if (phase === 'lost-response' && id === 626) kill();
    return Response.json({ id });
  },
};
const kill = () => process.kill(process.pid, 'SIGKILL');
const originalDispatch = SqliteLedger.prototype.dispatchChild;
SqliteLedger.prototype.dispatchChild = function (...args) {
  if (phase === 'before-admit') kill();
  originalDispatch.apply(this, args);
  if (phase === 'after-admit') kill();
};
const originalFinish = SqliteLedger.prototype.finish;
SqliteLedger.prototype.finish = function (receipt, ...args) {
  if (receipt.mode === 'subworkflow' && phase !== 'resume' && !measuring) {
    const parent = this.relations(receipt.runId)[0].parent;
    const info = this.progress(parent)[0];
    if (
      phase === 'before-return' ||
      (phase === 'page-seven' && info.pages === 6 && info.offset === 25) ||
      (phase === 'last-batch' && info.items === 1000)
    )
      kill();
    originalFinish.call(this, receipt, ...args);
    if (phase === 'after-return') kill();
  } else originalFinish.call(this, receipt, ...args);
};
if (measuring) {
  await new NodeHost(db, options).close();
  const sql = new DatabaseSync(db);
  sql.exec(`CREATE TABLE sizes(point INTEGER,page INTEGER);
    INSERT INTO sizes VALUES(0,0);
    CREATE TRIGGER samplePoint AFTER INSERT ON continuations BEGIN
      UPDATE sizes SET point=max(point,length(CAST(NEW.checkpoint AS BLOB))); END;
    CREATE TRIGGER samplePage AFTER UPDATE OF rows ON pageRuns WHEN NEW.rows IS NOT NULL BEGIN
      UPDATE sizes SET page=max(page,length(CAST(NEW.rows AS BLOB))); END;`);
  sql.close();
}
const h = new NodeHost(db, options);
let id;
if (phase === 'resume') id = readFileSync(db + '.id', 'utf8');
else {
  const child = load('process-order-batch'),
    parent = load('order-import');
  if (shape === 'call')
    Object.assign(parent.nodes[1], {
      type: 'draflow.call',
      parameters: { workflowId: child.id, revision: 1 },
    });
  if (measuring) {
    child.settings.saveExecutionData = 'none';
    child.nodes.splice(1, 1);
    child.connections = [
      {
        id: 'r',
        from: { node: 'input', port: 'main', index: 0 },
        to: { node: 'return', port: 'main', index: 0 },
      },
    ];
  }
  h.publish(child);
  h.activate(parent.id, h.publish(parent));
  id = h.accept(parent.id, 'schedule', { items: [{ json: { id: 1, amount: 1 } }] });
  writeFileSync(db + '.id', id);
}
const end = Date.now() + 120000;
while (h.receipt(id).state !== 'finished') {
  if (Date.now() > end) throw new Error('No completion: ' + h.receipt(id).state);
  await delay(2);
}
const receipt = h.receipt(id),
  progress = h.progress(id),
  children = h.relations(id).length;
await h.close();
if (measuring) {
  const sql = new DatabaseSync(db);
  const sizes = sql.prepare('SELECT * FROM sizes').get();
  const audit = sql.prepare('SELECT count(*) AS runs FROM runs').get();
  const dbBytes = sql
    .prepare('SELECT page_count*page_size AS bytes FROM pragma_page_count(),pragma_page_size()')
    .get().bytes;
  console.log(
    JSON.stringify({ count, progress, sizes, rssKiB: process.resourceUsage().maxRSS, audit, dbBytes }),
  );
  sql.close();
} else console.log(JSON.stringify({ outcome: receipt.outcome, children, progress }));
