// Optional integration test against a built Prood checkout (no production dependency on its workspace).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { until } from './fixture.mjs';

test(
  'receiver and host recover a single write on either side of the commit and finish boundaries',
  { skip: !process.env.PROOD_EFFECTS_CHECKOUT },
  async (t) => {
    const load = (file) => import(pathToFileURL(resolve(process.env.PROOD_EFFECTS_CHECKOUT, file)).href);
    const { createSystemIdGenerator, createWorkUseCases, deliverNext, routeTaskEvent } = await load(
      'packages/application/dist/index.js',
    );
    const { selectDatabaseClient } = await load('apps/server/dist/index.js');
    const dir = mkdtempSync(join(tmpdir(), 'business-e2e-'));
    const url = process.env.DRAFLOW_TEST_POSTGRES;
    const pg = await load('packages/persistence/postgres/dist/index.js');
    const schema = 'business_' + randomUUID().replaceAll('-', '');
    if (url) await pg.createPostgresSchema(url, schema);
    const db = url
      ? pg.createPostgresDatabase({ connectionString: url, schema })
      : selectDatabaseClient({ PROOD_SQLITE_PATH: join(dir, 'prood') });
    await db.migrate();
    const ids = createSystemIdGenerator(),
      workspace = ids.next('wks'),
      other = ids.next('wks'),
      user = ids.next('usr'),
      outsider = ids.next('usr');
    let now = Date.now();
    const deps = { uow: db.uow, clock: { now: () => new Date(now) }, idGenerator: ids };
    const work = createWorkUseCases(deps);
    const shared = url
      ? { connectionString: url, organization: workspace, leaseMs: 500, pollMs: 40 }
      : undefined;
    const open = () =>
      new NodeHost(join(dir, 'ledger'), {
        registry: new NodeRegistry().registerAll(standardNodes),
        organization: workspace,
        shared,
        executeBusiness: (...args) => work.executeAutomation(...args),
        prepareBusiness: (...args) => work.prepareAutomation(...args),
      });
    let host = open();
    t.after(async () => {
      await host.close();
      await db.close();
      if (url) await pg.dropPostgresSchema(url, schema);
      rmSync(dir, { recursive: true, force: true });
    });
    const actor = { userId: user, channel: 'web', actorType: 'user' };
    const stranger = { ...actor, userId: outsider };
    const createdAt = new Date(now).toISOString();
    await db.uow.run(async (r) => {
      for (const id of [workspace, other]) await r.workspaces.create({ id, name: id, slug: id, createdAt });
      for (const id of [user, outsider]) {
        await r.users.create({ id, email: id + '@example.test', displayName: id, createdAt });
        await r.memberships.create({
          id: ids.next('mbr'),
          workspaceId: workspace,
          userId: id,
          role: id === user ? 'admin' : 'member',
          createdAt,
        });
      }
    });
    const unwrap = (r) => {
      assert.equal(r.ok, true, JSON.stringify(r));
      return r.data;
    };
    const project = unwrap(
      await work.createProject(actor, workspace, { name: 'Private', kind: 'general', visibility: 'private' }),
    ).project;

    unwrap(
      await work.manageAutomation(actor, project.id, 'assign', {
        op: 'publish',
        revision: 0,
        delegate: user,
        definition: {
          when: 'manual',
          apply: true,
          reversible: true,
          action: { field: 'assigneeId', value: user },
        },
      }),
    );
    for (const phase of ['before-commit', 'lost-response', 'before-finish']) {
      const task = unwrap(await work.createTask(actor, project.id, { title: phase })).task;
      const { event } = unwrap(await work.manualAutomation(actor, project.id, 'assign', task.id));
      let run;
      // Stop intake before its scheduled drain, leaving a durable queued run.
      await deliverNext(deps, workspace, async (d) => {
        run = host.acceptBusiness(d);
        await host.close();
        return run;
      });
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./fixtures/prood-effect-worker.mjs', import.meta.url)),
          dir,
          schema,
          workspace,
          phase,
        ],
        { timeout: 15000 },
      );
      assert.equal(child.signal, 'SIGKILL', child.stderr?.toString());
      const prior = await db.uow.run((r) => r.automation.receipt(workspace, run));
      assert.equal(!!prior, phase !== 'before-commit');
      if (prior) unwrap(await work.updateTask(actor, task.id, { assigneeId: null }));
      host = open();
      await until(() => host.receipt(run).outcome === 'success');
      const events = await db.uow.run((r) => r.automation.events(project.id, task.id));
      assert.equal(
        events.filter((e) => e.channel === 'automation' && e.eventType === 'task.updated').length,
        1,
      );
      assert.equal(unwrap(await work.getTask(actor, task.id)).task.assigneeId, prior ? null : user);
      assert.equal((await db.uow.run((r) => r.automation.receipt(workspace, run))).event, event);
    }
  },
);
