import { PostgresDatabase } from '../dist/postgres.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const url = process.env.DRAFLOW_TEST_POSTGRES;
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const example = (name) =>
  JSON.parse(readFileSync(new URL('../../../examples/' + name + '.json', import.meta.url)));
function processHost(t, organization, role) {
  const proc = spawn(process.execPath, [cli], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DRAFLOW_POSTGRES_URL: url,
      DRAFLOW_ORGANIZATION: organization,
      DRAFLOW_ROLE: role,
      DRAFLOW_POLL_MS: '60',
      DRAFLOW_LEASE_MS: '1800',
    },
  });
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  let errors = '';
  proc.stderr.on('data', (s) => {
    errors += s;
  });
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGCONT');
      proc.kill('SIGKILL');
    }
    await exited;
  });
  return {
    proc,
    async request(op) {
      proc.stdin.write(JSON.stringify(op) + '\n');
      const { value, done } = await lines.next();
      assert.ok(!done, errors);
      const reply = JSON.parse(value);
      assert.ok(reply.ok, reply.error + ' ' + errors);
      return reply.result;
    },
  };
}
async function eventually(fn, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await delay(40);
  }
  throw Error('Timed out waiting for distributed progress');
}
test(
  'two intakes and three workers fence resumed owner across 1003 rows',
  { skip: !url, timeout: 120000 },
  async (t) => {
    const org = randomUUID();
    const intake = [processHost(t, org, 'intake'), processHost(t, org, 'intake')];
    const old = processHost(t, org, 'worker');
    const rows = new Map(),
      keys = new Map();
    let held, replayAt, stoppedAt;
    const server = createServer(async (req, res) => {
      const json = (v) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(v));
      };
      if (req.method === 'GET') {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const at = Number(params.get('cursor') ?? 0);
        return json({
          items: Array.from({ length: Math.min(100, 1003 - at) }, (_, i) => ({
            id: String(at + i),
            amount: 1,
            op: 'upsert',
            version: 1,
          })),
          nextCursor: at + 100 < 1003 ? String(at + 100) : null,
          syncToken: 'end',
        });
      }
      let s = '';
      for await (const part of req) s += part;
      const row = JSON.parse(s),
        key = req.headers['idempotency-key'];
      if (keys.has(row.id)) assert.equal(keys.get(row.id), key);
      keys.set(row.id, key);
      if (!rows.has(key)) rows.set(key, row);
      if (row.id === '0' && !held) {
        held = res;
        return;
      }
      if (row.id === '0') replayAt = Date.now();
      json({});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const parent = example('order-import'),
      child = example('process-order-batch');
    child.nodes[1].parameters.url = origin + '/sink';
    Object.assign(parent.nodes[1].parameters, {
      url: origin + '/source',
      concurrency: 4,
      syncScope: 'orders',
      keyLifetimeMs: 86400000,
    });
    await intake[0].request({ op: 'publish', workflow: child });
    await intake[0].request({ op: 'publish', workflow: parent });
    await intake[0].request({ op: 'activate', workflowId: parent.id, revision: 1 });
    const accept = {
      op: 'accept',
      workflowId: parent.id,
      triggerNodeId: 'schedule',
      event: { key: 'duplicate', items: [{ json: {} }] },
    };
    const [id, dup] = await Promise.all(intake.map((h) => h.request(accept)));
    assert.equal(id, dup);
    intake[0].proc.kill('SIGKILL');
    assert.equal(await intake[1].request(accept), id);
    await eventually(() => held);
    old.proc.kill('SIGSTOP');
    stoppedAt = Date.now();
    const replacements = [processHost(t, org, 'worker'), processHost(t, org, 'worker')];
    await eventually(() => replayAt);
    assert.ok(replayAt - stoppedAt < 60000);
    old.proc.kill('SIGCONT');
    held.end('{}');
    const result = await eventually(async () => {
      const r = await intake[1].request({ op: 'receipt', runId: id });
      return r.state === 'finished' && r;
    });
    assert.equal(result.outcome, 'success');
    const info = await intake[1].request({ op: 'progress', runId: id });
    assert.equal(info.pages[0].items, 1003);
    assert.equal(info.pages[0].total, 1003);
    assert.equal(info.calls.length, 41);
    assert.equal(keys.size, 1003);
    assert.equal(rows.size, 1003);
    assert.deepEqual(
      [...rows.values()].map((x) => Number(x.id)).sort((a, b) => a - b),
      Array.from({ length: 1003 }, (_, i) => i),
    );
    assert.ok([...rows.values()].every((x) => x.version === 1));
    // A paused session that held a DB transaction may be terminated by PostgreSQL.
    // Both fenced continuation and fail-stop exit must leave the destination identical.
    await Promise.all(replacements.map((h) => h.request({ op: 'stats' })));
    console.log('Worker takeover ms', replayAt - stoppedAt);
  },
);

test('two scheduler processes admit one overdue interval', { skip: !url }, async (t) => {
  const organization = randomUUID();
  const intake = processHost(t, organization, 'intake');
  const doc = example('order-import');
  doc.nodes = [doc.nodes[0]];
  doc.connections = [];
  await intake.request({ op: 'publish', workflow: doc });
  await intake.request({ op: 'activate', workflowId: doc.id, revision: 1 });
  const a = processHost(t, organization, 'scheduler');
  const b = processHost(t, organization, 'scheduler');
  await Promise.all([a.request({ op: 'stats' }), b.request({ op: 'stats' })]);
  const db = new PostgresDatabase({ connectionString: url, organization });
  t.after(() => db.close());
  const due = db.now() - 1000;
  db.atomic(() => db.raw('UPDATE schedules SET "nextAt"=$1', [due]));
  await eventually(() => db.raw('SELECT count(*) AS n FROM deliveries').rows[0].n === 1);
  await delay(250);
  assert.equal(db.raw('SELECT count(*) AS n FROM runs').rows[0].n, 1);
  assert.equal(db.raw('SELECT "nextAt" FROM schedules').rows[0].nextAt, due + 3600000);
});
