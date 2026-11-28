import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('manager previews an imported rule and explicitly delegates before publication', async ({ page }) => {
  test.skip(!process.env.PROOD_CHECKOUT, 'requires built Prood integration');
  const load = (file) => import(pathToFileURL(resolve(process.env.PROOD_CHECKOUT, file)).href);
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
    await page.goto('http://127.0.0.1:' + server.address().port + '/automation/review');
    await page.getByLabel('Project ID').fill(project.id);
    await page.getByLabel('Rule ID').fill('review');
    await page.getByRole('button', { name: 'Preview rule' }).press('Enter');
    await expect(page.getByRole('button', { name: 'Delegate and publish' })).toBeFocused();
    await expect(page.locator('#summary')).toContainText('Manager');
    expect(await db.uow.run((r) => r.automation.rules(project.id))).toHaveLength(0);
    await page.getByRole('button', { name: 'Delegate and publish' }).press('Enter');
    await expect(page.getByRole('status')).toHaveText('Published revision 1.');
    expect(await db.uow.run((r) => r.automation.rules(project.id))).toHaveLength(1);
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
