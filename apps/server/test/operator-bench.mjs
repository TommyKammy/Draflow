// Measure the authenticated first-page path against real ledger rows and archived histories.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { PostgresDatabase } from '../dist/postgres.js';
import { createOperatorServer } from '../dist/operator-http.js';
const dir = mkdtempSync(join(tmpdir(), 'df-operator-bench-')),
  path = join(dir, 'bench.db'),
  org = randomUUID(),
  token = randomUUID();
const options = {
  registry: new NodeRegistry().registerAll(standardNodes),
  organization: org,
  ...(process.env.DRAFLOW_TEST_POSTGRES && {
    shared: { organization: org, connectionString: process.env.DRAFLOW_TEST_POSTGRES, role: 'intake' },
  }),
};
const flow = JSON.parse(readFileSync(new URL('../../../examples/order-import.json', import.meta.url)));
flow.nodes = [flow.nodes[0]];
flow.connections = [];
let host = new NodeHost(path, options),
  server;
try {
  host.publish(flow);
  await host.close();
  const source = options.shared
    ? 'SELECT generate_series(1,100000) AS i'
    : 'WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000) SELECT i FROM n';
  const seed = `INSERT INTO runs("runId","workflowId",revision,"triggerNodeId",mode,state,"acceptedAt",outcome)
 SELECT 'run-'||i,'order-import',1,'schedule','trigger','finished',i,'success' FROM (${source}) inputs;
 INSERT INTO history("workflowId",id,status,"startedAt",summary,detail)
 SELECT "workflowId","runId",'success',"acceptedAt",'{}','{"private":"archived body"}' FROM runs;`;
  if (options.shared) {
    const db = new PostgresDatabase(options.shared);
    try {
      db.atomic(() => db.raw(seed));
    } finally {
      db.close();
    }
  } else {
    const db = new DatabaseSync(path);
    try {
      db.exec('BEGIN;' + seed + 'COMMIT;');
    } finally {
      db.close();
    }
  }
  host = new NodeHost(path, options);
  server = createOperatorServer([host], () => [
    {
      actor: 'benchmark',
      organization: org,
      role: 'viewer',
      sha256: createHash('sha256').update(token).digest('hex'),
    },
  ]);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const times = [];
  for (let i = 0; i < 31; i++) {
    const start = performance.now();
    const reply = await fetch(
      'http://127.0.0.1:' + server.address().port + '/operator/' + org + '/api?op=list',
      { headers: { authorization: 'Bearer ' + token } },
    );
    assert.equal(reply.status, 200);
    const page = await reply.json();
    assert.equal(page.length, 50);
    assert.equal(page[0].runId, 'run-100000');
    assert.ok(!JSON.stringify(page).includes('archived body'));
    if (i) times.push(performance.now() - start);
  }
  const p95 = times.sort((a, b) => a - b)[28];
  assert.ok(p95 < 1000);
  console.log(
    JSON.stringify({
      backend: options.shared ? 'postgres' : 'sqlite',
      histories: 100000,
      samples: times.length,
      firstPageP95Ms: p95,
    }),
  );
} finally {
  if (server) await new Promise((r) => server.close(r));
  await host.close();
  rmSync(dir, { recursive: true, force: true });
}
