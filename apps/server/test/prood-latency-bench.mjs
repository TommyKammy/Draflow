// Compare two built Prood and Draflow checkouts using the same short Outbox bursts.
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { setTimeout as delay } from 'node:timers/promises';
const { NodeHost } = await import(pathToFileURL(resolve(process.argv[3] ?? '.', 'apps/server/dist/host.js')));
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2] ?? '.');
const load = (file) => import(pathToFileURL(join(root, file)));
const { createSystemIdGenerator, createWorkUseCases, deliverNext } = await load(
  'packages/application/dist/index.js',
);
const { selectDatabaseClient } = await load('apps/server/dist/index.js');
const pg = await load('packages/persistence/postgres/dist/index.js');
const url = process.env.DATABASE_URL;
const dir = mkdtempSync(join(tmpdir(), 'prood-write-bench-'));
const schema = 'bench_' + randomUUID().replaceAll('-', '');
if (url) await pg.createPostgresSchema(url, schema);
const db = url
  ? pg.createPostgresDatabase({ connectionString: url, schema })
  : selectDatabaseClient({ PROOD_SQLITE_PATH: join(dir, 'bench.sqlite') });
function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
let host;
try {
  await db.migrate();
  const ids = createSystemIdGenerator();
  const user = ids.next('usr'),
    workspace = ids.next('wks'),
    createdAt = new Date().toISOString();
  const actor = { actorType: 'user', userId: user, channel: 'web' };
  const work = createWorkUseCases({
    uow: db.uow,
    idGenerator: ids,
    clock: { now: () => new Date() },
  });
  await db.uow.run(async (repos) => {
    await repos.users.create({
      id: user,
      email: 'bench@example.test',
      displayName: 'Bench',
      createdAt,
    });
    await repos.workspaces.create({ id: workspace, name: 'Bench', slug: 'bench', createdAt });
    await repos.memberships.create({
      id: ids.next('mbr'),
      workspaceId: workspace,
      userId: user,
      role: 'admin',
      createdAt,
    });
  });
  const { project } = value(
    await work.createProject(actor, workspace, {
      name: 'Bench',
      kind: 'general',
      visibility: 'private',
    }),
  );
  const { task } = value(await work.createTask(actor, project.id, { title: 'Bench' }));
  const deps = { uow: db.uow, clock: { now: () => new Date() }, idGenerator: ids };
  const live = typeof work.executeAutomation === 'function';
  value(
    await work.manageAutomation(actor, project.id, 'bench', {
      op: 'publish',
      delegate: user,
      revision: 0,
      definition: {
        when: 'status.changed',
        action: { field: 'assigneeId', value: user },
        ...(live && { apply: true }),
      },
    }),
  );
  host = new NodeHost(join(dir, 'draflow'), {
    organization: workspace,
    shared: url ? { organization: workspace, connectionString: url } : undefined,
    registry: new NodeRegistry().registerAll(standardNodes),
    prepareBusiness: (...args) => work.prepareAutomation(...args),
    executeBusiness: (...args) => work.executeAutomation(...args),
  });
  const lag = [],
    writes = [];
  for (let round = 0; round < 6; round++) {
    const committed = new Map(),
      runs = [];
    for (let i = 0; i < 20; i++) {
      const t = value(await work.createTask(actor, project.id, { title: 'sample' })).task;
      const start = performance.now();
      value(await work.updateTask(actor, t.id, { statusId: project.statuses[1].id }));
      const end = performance.now();
      if (round) writes.push(end - start);
      committed.set(t.id, end);
    }
    await delay(250);
    while (
      await deliverNext(deps, workspace, (d) => {
        const run = host.acceptBusiness(d);
        runs.push(run);
        assert.ok(committed.has(d.proposal.task));
        if (round) lag.push(performance.now() - committed.get(d.proposal.task));
        return run;
      })
    ) {}
    assert.equal(runs.length, 20);
    const deadline = Date.now() + 30000;
    while (!runs.every((run) => host.receipt(run).outcome === 'success')) {
      assert.ok(Date.now() < deadline, 'worker did not drain');
      await delay(10);
    }
  }
  const p95 = (xs) => xs.sort((a, b) => a - b)[94];
  console.log(
    JSON.stringify({
      backend: url ? 'postgres' : 'sqlite',
      live,
      samples: lag.length,
      writeP95: p95(writes),
      outboxP95: p95(lag),
    }),
  );
} finally {
  await host?.close();
  await db.close();
  if (url) await pg.dropPostgresSchema(url, schema);
  rmSync(dir, { recursive: true, force: true });
}
