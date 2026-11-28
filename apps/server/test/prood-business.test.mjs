// Optional integration test against a built Prood checkout (no production dependency on its workspace).
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
  'Prood subscriptions, actor and action boundaries across an actual host restart',
  { skip: !process.env.PROOD_CHECKOUT },
  async (t) => {
    const load = (file) => import(pathToFileURL(resolve(process.env.PROOD_CHECKOUT, file)).href);
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
    const shared = url ? { connectionString: url, organization: workspace } : undefined;
    const open = () =>
      new NodeHost(join(dir, 'draflow'), {
        registry: new NodeRegistry().registerAll(standardNodes),
        organization: workspace,
        shared,
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
    const neighbor = unwrap(
      await work.createProject(actor, workspace, { name: 'Other', kind: 'general', visibility: 'private' }),
    ).project;
    const save = (op, rule, definition, delegate = user, revision = 0, as = actor) =>
      work.manageAutomation(as, project.id, rule, { op, definition, delegate, revision });
    const def = { when: 'manual', action: { field: 'statusId', value: project.statuses[1].id } };
    assert.equal((await save('preview', 'r', def)).data.delegateName, user);
    for (const bad of [
      { ...def, child: { workflow: 'other' } },
      { ...def, action: { field: 'http', value: 'https://sink.test' } },
      { ...def, action: { field: 'statusId', value: neighbor.statuses[0].id } },
      { ...def, action: { field: 'assigneeId', value: outsider } },
    ]) {
      for (const op of ['preview', 'publish']) assert.equal((await save(op, 'r', bad)).ok, false);
    }
    assert.equal((await save('publish', 'r', def, outsider)).ok, false);
    assert.equal((await save('publish', 'r', def, outsider, 0, stranger)).status, 404);
    unwrap(await save('publish', 'r', def));
    const parent = unwrap(await work.createTask(actor, project.id, { title: 'Parent' })).task;
    const task = unwrap(
      await work.createTask(actor, project.id, { title: 'Child', parentTaskId: parent.id }),
    ).task;
    const wrong = unwrap(await work.createTask(actor, neighbor.id, { title: 'Other' })).task;
    assert.equal((await work.manualAutomation(actor, project.id, 'r', wrong.id)).ok, false);
    assert.equal((await work.manualAutomation(stranger, project.id, 'r', task.id)).ok, false);
    const { event } = unwrap(await work.manualAutomation(actor, project.id, 'r', task.id));
    let run;
    await assert.rejects(
      deliverNext(
        deps,
        workspace,
        (d) => {
          run = host.acceptBusiness(d);
          throw Error('lost reply');
        },
        5,
      ),
      /lost reply/,
    );
    await until(() => host.receipt(run).outcome === 'success');
    await host.close();
    host = open();
    now += 10;
    assert.equal(
      await deliverNext(deps, workspace, (d) => {
        assert.equal(host.acceptBusiness(d), run);
        return run;
      }),
      true,
    );
    assert.equal((await work.prepareAutomation(workspace, event, 'r', run, neighbor.id, 1)).status, 'denied');
    assert.equal((await work.prepareAutomation(other, event, 'r', run, project.id, 1)).status, 'denied');
    assert.equal(
      (await work.prepareAutomation(workspace, event, 'r', run, project.id, 1)).status,
      'prepared',
    );
    assert.equal((await work.getTask(actor, task.id)).data.task.statusId, task.statusId);
    assert.equal(
      (await db.uow.run((r) => r.outbox.listByWorkspace(workspace))).filter(
        (e) => e.eventType === 'automation.prepared' && e.payload.run === run,
      ).length,
      1,
    );
    // Future automation-originated events carry only a trusted parent run; ancestry comes from the ledger.
    const recorded = await db.uow.run((r) => r.outbox.listByWorkspace(workspace));
    const manual = recorded.find((e) => e.eventId === event);
    async function derived(parentRun, rule) {
      await db.uow.run(async (r) => {
        const e = await r.outbox.append({
          ...manual,
          id: ids.next('out'),
          eventId: ids.next('evt'),
          channel: 'automation',
          payload: { ...manual.payload, parentRun, rule },
        });
        await routeTaskEvent(r, e);
      });
    }
    await derived(run, 'r');
    assert.equal(await deliverNext(deps, workspace, () => assert.fail('self cycle')), false);
    unwrap(await save('publish', 'next', def));
    await derived(run, 'next');
    let child;
    await deliverNext(deps, workspace, (d) => {
      child = host.acceptBusiness(d);
      return child;
    });
    await derived(child, 'r');
    assert.equal(await deliverNext(deps, workspace, () => assert.fail('indirect cycle')), false);
    await assert.rejects(derived(randomUUID(), 'next'), /parent/);
    await work.updateTask(actor, task.id, { assigneeId: user });
    assert.equal((await work.prepareAutomation(workspace, event, 'r', run, project.id, 1)).status, 'skipped');
    // A same-delegate edit pins the original operation. Stop + a new grant invalidates old authority.
    const grantEvent = unwrap(await work.manualAutomation(actor, project.id, 'r', task.id)).event;
    unwrap(await save('publish', 'r', { ...def, action: { field: 'assigneeId', value: user } }, user, 1));
    assert.equal(
      (await work.prepareAutomation(workspace, grantEvent, 'r', run, project.id, 1)).field,
      'statusId',
    );
    unwrap(await save('stop', 'r', undefined, user, 2));
    unwrap(await save('publish', 'r', def, user, 3));
    assert.equal(
      (await work.prepareAutomation(workspace, grantEvent, 'r', run, project.id, 1)).status,
      'denied',
    );
    await deliverNext(deps, workspace, (d) => host.acceptBusiness(d));
    await db.uow.run((r) =>
      r.projects.upsertMembership({
        id: ids.next('mbr'),
        projectId: project.id,
        userId: outsider,
        role: 'member',
        createdAt,
      }),
    );
    unwrap(
      await save('publish', 'assign', { when: 'manual', action: { field: 'assigneeId', value: outsider } }),
    );
    unwrap(await work.manualAutomation(actor, project.id, 'assign', task.id));
    await db.kysely
      .deleteFrom('project_memberships')
      .where('project_id', '=', project.id)
      .where('user_id', '=', outsider)
      .execute();
    let lostCandidate;
    await deliverNext(deps, workspace, (delivery) => {
      lostCandidate = host.acceptBusiness(delivery);
      return lostCandidate;
    });
    await until(() => host.receipt(lostCandidate).outcome === 'error');
    const pending = unwrap(await work.manualAutomation(actor, project.id, 'r', task.id));
    await db.kysely
      .updateTable('workspace_memberships')
      .set({ role: 'viewer' })
      .where('user_id', '=', user)
      .where('workspace_id', '=', workspace)
      .execute();
    assert.equal((await work.prepareAutomation(workspace, event, 'r', run, project.id, 1)).status, 'denied');
    let denied;
    await deliverNext(deps, workspace, (d) => {
      assert.equal(d.event, pending.event);
      denied = host.acceptBusiness(d);
      return denied;
    });
    await until(() => host.receipt(denied).outcome === 'error');
    await db.kysely
      .deleteFrom('workspace_memberships')
      .where('workspace_id', '=', workspace)
      .where('user_id', '=', user)
      .execute();
    assert.equal(
      (await work.prepareAutomation(workspace, pending.event, 'r', denied, project.id, 4)).status,
      'denied',
    );
    assert.equal((await save('publish', 'departed', def)).ok, false);
    assert.equal(
      (
        await work.updateTask({ ...actor, channel: 'automation' }, task.id, {
          statusId: project.statuses[1].id,
        })
      ).ok,
      false,
    );
    const audit = await db.uow.run((r) => r.outbox.listByWorkspace(workspace));
    assert.ok(
      audit.some(
        (e) => e.eventType === 'automation.denied' && e.payload.run === denied && e.actorUserId === user,
      ),
    );
  },
);
