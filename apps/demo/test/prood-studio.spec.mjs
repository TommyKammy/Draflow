import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('project manager tests a reviewer rule, publishes, inspects both histories and pauses using the keyboard', async ({
  page,
}) => {
  test.skip(!process.env.PROOD_EFFECTS_CHECKOUT, 'requires built Prood integration');
  const load = (file) => import(pathToFileURL(resolve(process.env.PROOD_EFFECTS_CHECKOUT, file)).href);
  const { createApp, createNodeAppListener, mountWebShellAssets, selectDatabaseClient } =
    await load('apps/server/dist/index.js');
  const { createSystemIdGenerator, createWorkUseCases } = await load('packages/application/dist/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'prood-review-'));
  const db = selectDatabaseClient({ PROOD_SQLITE_PATH: join(dir, 'prood.sqlite') });
  let server;
  try {
    await db.migrate();
    const clock = { now: () => new Date() },
      ids = createSystemIdGenerator(),
      workspace = ids.next('wks'),
      user = ids.next('usr');
    const createdAt = clock.now().toISOString(),
      email = 'manager@example.test';
    await db.uow.run(async (r) => {
      await r.workspaces.create({ id: workspace, name: 'Ops', slug: 'ops', createdAt });
      await r.users.create({ id: user, email, displayName: 'Manager', createdAt });
      await r.users.linkAuthIdentity({
        userId: user,
        authProvider: 'better-auth',
        authSubject: 'session-user',
        createdAt,
      });
      await r.memberships.create({
        id: ids.next('mbr'),
        workspaceId: workspace,
        userId: user,
        role: 'admin',
        createdAt,
      });
    });
    const deps = { uow: db.uow, clock, idGenerator: ids };
    const {
      data: { project },
    } = await createWorkUseCases(deps).createProject(
      { userId: user, actorType: 'user', channel: 'web' },
      workspace,
      { name: 'Ops', kind: 'general', visibility: 'private' },
    );
    const work = createWorkUseCases(deps),
      actor = { userId: user, actorType: 'user', channel: 'web' };
    const {
      data: { task },
    } = await work.createTask(actor, project.id, { title: 'Review worksheet' });
    await work.updateTask(actor, task.id, { statusId: project.statuses[1].id });
    const app = createApp({
      ...deps,
      dbHealth: db,
      auth: {
        getSession: async () => ({
          sessionId: 'test',
          authSubject: 'session-user',
          authProvider: 'better-auth',
          email,
          name: 'Manager',
          emailVerified: true,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      },
    });
    mountWebShellAssets(app);
    server = createServer(createNodeAppListener(app));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const scripts = [];
    page.on('request', (req) => {
      if (req.resourceType() === 'script') scripts.push(new URL(req.url()).pathname);
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/');
    await page.waitForLoadState('networkidle');
    expect(scripts).not.toContain('/automation/studio.js');
    await page.goto('http://127.0.0.1:' + server.address().port + '/projects/' + project.id + '/automation');
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue(project.id);
    await expect(page.getByRole('button', { name: 'Test rule' })).toBeEnabled();
    await page.getByLabel('Rule ID').fill('review');
    await page.getByRole('combobox', { name: 'Status', exact: true }).press('Home');
    await page.getByRole('combobox', { name: 'Status', exact: true }).press('i');
    await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue(
      project.statuses[1].id,
    );
    await page.getByRole('checkbox').press('Space');
    const before = await db.uow.run((r) => r.outbox.listByWorkspace(workspace));
    await page.getByRole('button', { name: 'Test rule' }).press('Enter');
    await expect(page.getByRole('button', { name: 'Delegate and publish' })).toBeFocused();
    await expect(page.locator('#summary')).toContainText('Eligible');
    expect(await db.uow.run((r) => r.outbox.listByWorkspace(workspace))).toEqual(before);
    expect(await db.kysely.selectFrom('automation_deliveries').selectAll().execute()).toHaveLength(0);
    await page.getByRole('button', { name: 'Delegate and publish' }).press('Enter');
    await expect(page.getByRole('status')).toHaveText('Saved');
    await work.updateTask(actor, task.id, { statusId: project.statuses[0].id });
    await work.updateTask(actor, task.id, { statusId: project.statuses[1].id });
    const { deliverNext } = await load('packages/application/dist/index.js');
    let delivery;
    expect(
      await deliverNext(deps, workspace, (d) => {
        delivery = d;
        return 'studio-run';
      }),
    ).toBe(true);
    expect(
      (await work.executeAutomation(workspace, delivery.event, 'review', 'studio-run', project.id, 1)).status,
    ).toBe('applied');
    for (const label of ['Task history', 'Rule history']) {
      await page.getByRole('button', { name: label }).press('Enter');
      await expect(page.locator('#entries')).toContainText('Change applied');
    }
    const second = await page.context().newPage();
    await second.goto(page.url());
    await expect(second.getByRole('button', { name: 'Test rule' })).toBeEnabled();
    await second.getByRole('button', { name: 'Task history' }).press('Enter');
    await expect(second.getByRole('button', { name: 'Restore previous value' })).toBeVisible();
    const decisions = [page, second].map((tab) =>
      tab.waitForResponse((reply) => {
        const body = reply.request().postDataJSON();
        return body?.op === 'keep' || body?.op === 'undo';
      }),
    );
    await Promise.all([
      page.getByRole('button', { name: 'Keep change' }).press('Enter'),
      second.getByRole('button', { name: 'Restore previous value' }).press('Enter'),
    ]);
    expect((await Promise.all(decisions)).map((r) => r.status()).sort()).toEqual([200, 409]);
    const events = await db.uow.run((r) => r.outbox.listByWorkspace(workspace));
    expect(events.filter((e) => ['automation.keep', 'automation.undo'].includes(e.eventType))).toHaveLength(
      1,
    );
    await second.close();
    await page.getByRole('button', { name: 'Pause rule' }).press('Enter');
    await expect(page.getByRole('button', { name: 'Pause rule' })).toBeDisabled();
  } finally {
    if (server)
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      });
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
