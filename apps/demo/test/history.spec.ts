import { expect, test } from '@playwright/test';
import { openEnglishDemo } from './locale.js';
import type { ExecutionStore, ExecutionSummary } from '@draflow/storage';
import type {} from '@draflow/element/define';

test('full and partial runs record visited tasks, scope, reuse and an immutable document', async ({ page }) => {
  await openEnglishDemo(page);
  const records = await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!, store = el.ports.executions!;
    const full = await el.run({ runId: 'full' }).done;
    await el.runPreviousNodes('set').done;
    const partial = await el.runNode('set').done;
    await el.run({ runId: 'missing', destinationNodeId: 'absent' }).done.catch(() => {});
    const w = el.workflow!; w.name = 'Renamed'; el.workflow = w;
    return { rows: await store.list(w.id), detail: await store.get(w.id, partial.id), full: full.id };
  });
  expect(records.rows).toHaveLength(4);
  expect(records.rows.map(r => [r.status, r.destinationMode, r.destinationNodeId])).toEqual([
    ['error', 'inclusive', 'absent'], ['success', 'inclusive', 'set'], ['success', 'exclusive', 'set'], ['success', undefined, undefined],
  ]);
  expect(records.detail?.workflow.name).toBe('Manual → Set');
  expect(records.detail?.tasks.map(t => [t.nodeId, t.reused])).toEqual([['manual', true], ['set', false]]);
  expect(records.detail?.tasks[1]?.task?.output?.main?.[0]).toHaveLength(1);
  await page.getByRole('button', { name: 'Execution history' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('listitem')).toHaveCount(4);
  await dialog.getByLabel('Execution status').selectOption('error');
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('listitem')).toContainText('missing');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByText('No executions')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Execution history' })).toBeFocused();
  await page.reload();
  await page.locator('draflow-editor').getByRole('button', { name: '実行履歴' }).click();
  await expect(page.getByText('実行履歴はありません')).toBeVisible();
});

test('delayed writes and list responses from A cannot replace document B', async ({ page }) => {
  await openEnglishDemo(page);
  const setup = await page.evaluateHandle(() => {
    const el = document.querySelector('draflow-editor')!, delegate = el.ports.executions!;
    const a = el.workflow!, b = { ...a, id: 'B', name: 'B' };
    let write!: () => void, read!: () => void, delayed = false;
    const store: ExecutionStore = {
      async append(summary, detail) {
        if (summary.workflowId === a.id) await new Promise<void>(r => { write = r; });
        await delegate.append(summary, detail);
      },
      async list(id, status) {
        if (id === a.id && delayed) await new Promise<void>(r => { read = r; });
        return delegate.list(id, status);
      },
      get: () => { throw Error('list must not fetch detail'); },
      delete: (id, run) => delegate.delete(id, run),
    };
    el.ports = { ...el.ports, executions: store };
    return { run: async () => { await el.run({ runId: 'run-a' }).done; delayed = true; }, switchDoc: () => { el.workflow = b; },
      settle: () => { write(); read(); }, countA: async () => (await delegate.list(a.id)).length };
  });
  await setup.evaluate(s => s.run());
  const launcher = page.getByRole('button', { name: 'Execution history' });
  await launcher.click();
  await expect(page.getByText('Loading history')).toBeVisible();
  await setup.evaluate(s => s.switchDoc());
  await launcher.click();
  await expect(page.getByText('No executions')).toBeVisible();
  await setup.evaluate(s => s.settle());
  await expect.poll(() => setup.evaluate(s => s.countA())).toBe(1);
  await expect(page.getByText('No executions')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status')).toHaveText('Run the workflow to see its output.');
});

test('persistent host survives reload and readonly browsing on a narrow Japanese display', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  async function attach() {
    await expect(page.locator('[data-node-id=set]')).toBeVisible();
    await page.evaluate(() => {
      const el = document.querySelector('draflow-editor')!;
      const store: ExecutionStore = {
        async append(summary, detail) {
          localStorage.setItem('history-fixture', JSON.stringify(summary));
          localStorage.setItem('detail-fixture', JSON.stringify(detail));
        },
        async list(id, status) {
          const row = JSON.parse(localStorage.getItem('history-fixture') ?? 'null') as ExecutionSummary | null;
          return row?.workflowId === id && (!status || row.status === status) ? [{ ...row, hasDetail: true }] : [];
        },
        async get() { return JSON.parse(localStorage.getItem('detail-fixture') ?? 'null'); },
        async delete() { localStorage.removeItem('history-fixture'); localStorage.removeItem('detail-fixture'); },
      };
      el.ports = { ...el.ports, executions: store };
    });
  }
  await page.goto('/'); await attach();
  await page.evaluate(async () => { const el = document.querySelector('draflow-editor')!; await el.run({ runId: 'persisted' }).done; el.clearExecution(); });
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('history-fixture'))).toBe(true);
  await page.reload(); await attach();
  await page.locator('draflow-editor').evaluate(el => el.setAttribute('readonly',''));
  const launcher = page.getByRole('button', { name: '実行履歴' });
  await launcher.focus(); await launcher.press('Enter');
  await expect(page.getByRole('combobox', { name: '実行状態' })).toBeFocused();
  await expect(page.getByRole('listitem')).toContainText('persisted');
  await expect(page.getByRole('dialog').getByRole('button', { name: '削除' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(launcher).toBeFocused();
});

test('records errors and cancellations even when a partial run is detached by a document switch', async ({ page }) => {
  await page.goto('/?example=mock-http');
  await expect(page.locator('[data-node-id=http]')).toBeVisible();
  const result = await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!, w = el.workflow!, store = el.ports.executions!;
    let slow = false, entered!: () => void;
    el.ports = { ...el.ports, fetch: async (_url, init) => {
      if (slow) {
        entered();
        await new Promise<void>(resolve => init!.signal!.addEventListener('abort', () => resolve(), { once: true }));
      }
      return new Response('mock failure', { status: 503 });
    } };
    await el.run().done;
    await el.runNode('http').done;
    slow = true;
    for (const partial of [false, true]) {
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const handle = partial ? el.runNode('http') : el.run();
      await ready;
      if (partial) el.workflow = { ...w, id: 'other', name: 'Other' };
      else el.stop();
      await handle.done;
    }
    const rows = await store.list(w.id);
    return { statuses: rows.map(r => [r.status, r.destinationNodeId ?? 'full']),
      snapshot: (await store.get(w.id, rows[0]!.id))?.workflow.id, other: await store.list('other'), original: w.id };
  });
  expect(result.statuses).toEqual([['canceled', 'http'], ['canceled','full'], ['error','http'], ['error','full']]);
  expect(result.snapshot).toBe(result.original);
  expect(result.other).toEqual([]);
});

test('summary-only detail, store failure and disabled history leave execution usable', async ({ page }) => {
  await openEnglishDemo(page);
  const launcher = page.getByRole('button', { name: 'Execution history' });
  await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!, delegate = el.ports.executions!;
    let fail = false;
    el.ports = { ...el.ports, executions: {
      async append(summary, detail) {
        if (fail) throw Error('quota');
        await delegate.append(summary, detail);
      },
      async list(id, status) { return (await delegate.list(id, status)).map(row => ({ ...row, hasDetail: false })); },
      get: () => { throw Error('unnecessary detail read'); }, delete: (id, run) => delegate.delete(id, run),
    } };
    await el.run({ runId: 'kept' }).done;
    fail = true;
    await el.run({ runId: 'failed-write' }).done;
  });
  await expect(page.getByText('History unavailable · Error: quota')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Set · 1 item');
  await launcher.click();
  await expect(page.getByRole('listitem')).toContainText('Detail omitted');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Replay' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No executions')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status')).toHaveText('Set · 1 item');
  await page.evaluate(async () => { const el = document.querySelector('draflow-editor')!; el.ports = {}; await el.run().done; });
  await expect(launcher).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Set · 1 item');
});

test('respects document-level execution retention settings', async ({ page }) => {
  await openEnglishDemo(page);
  const ids = await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!, w = el.workflow!;
    const store = el.ports.executions!;
    for (const policy of ['none', 'error'] as const) {
      el.workflow = { ...w, settings: { ...w.settings, saveExecutionData: policy } };
      await el.run({ runId: policy + '-success' }).done;
      await el.run({ runId: policy + '-failure', destinationNodeId: 'absent' }).done.catch(() => {});
    }
    return (await store.list(w.id)).map(row => row.id);
  });
  expect(ids).toEqual(['error-failure']);
});
