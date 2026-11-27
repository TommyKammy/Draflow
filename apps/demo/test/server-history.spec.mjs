import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeHost } from '../../server/dist/host.js';
import { registry } from '../../server/test/fixture.mjs';

for (const phase of ['running', 'finished']) {
  test('replays SQLite history after restart at ' + phase, async ({ page }, info) => {
    const path = info.outputPath('history.db');
    const script = fileURLToPath(new URL('../../server/test/crash-child.mjs', import.meta.url));
    expect(spawnSync(process.execPath, [script, path, phase], { timeout: 10000 }).signal).toBe('SIGKILL');
    const host = new NodeHost(path, { registry: registry() });
    try {
      const [summary] = await host.history.list('flow');
      const detail = await host.history.get('flow', summary.id);
      await page.goto('/');
      await page.locator('draflow-editor').evaluate(
        async (editor, { summary, detail }) => {
          editor.setAttribute('locale', 'en');
          editor.workflow = detail.workflow;
          await editor.ports.executions.append(summary, detail);
        },
        { summary, detail },
      );
      await page.getByRole('button', { name: 'Execution history' }).click();
      await page.getByRole('button', { name: 'Replay' }).click();
      const replay = page.getByRole('region', { name: 'Execution replay' });
      await expect(replay.getByRole('heading').first()).toContainText(summary.id);
      if (phase === 'running') {
        await expect(replay.getByText(/Check external effects/)).toBeVisible();
        await expect(replay.getByText(/Not visited/)).toHaveCount(0);
      } else {
        await replay.getByRole('button', { name: 'Next task' }).click();
        await expect(replay.getByText(/2 \/ 2 · sink/)).toBeVisible();
      }
    } finally {
      await host.close();
    }
  });
}

test('replay shows batch progress and discloses related runs with the keyboard', async ({ page }) => {
  await page.goto('/');
  await page.locator('draflow-editor:not([hidden])').evaluate(async (editor) => {
    editor.setAttribute('locale', 'en');
    const workflow = editor.workflow;
    await editor.ports.executions.append(
      {
        id: 'progress',
        workflowId: workflow.id,
        workflowName: workflow.name,
        mode: 'trigger',
        startedAt: 1,
        stoppedAt: 2,
        status: 'waiting',
        executed: 0,
        reused: 0,
      },
      {
        workflow,
        tasks: [],
        orchestration: {
          pages: [{ node: 'pages', pages: 6, batches: 24, items: 600, retryAt: Date.now() + 30000 }],
          calls: [{ child: 'child-run-24', parent: 'progress', childRevision: 1 }],
          uncertain: [],
          canceled: false,
        },
      },
    );
  });
  await page.getByRole('button', { name: 'Execution history' }).click();
  await page.getByRole('button', { name: 'Replay' }).click();
  const replay = page.getByRole('region', { name: 'Execution replay' });
  await expect(
    replay.getByText(/Pages completed 6.*Batches completed 24.*Items completed 600.*Next retry/),
  ).toBeVisible();
  const summary = replay.getByText('Related runs and reconciliation (1 / 0)');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(replay.getByText(/child-run-24/)).toBeVisible();
});
