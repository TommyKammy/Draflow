import { openEnglishDemo } from './locale.js';
import { expect, test, type Page } from '@playwright/test';
import type {} from '@draflow/element/define';

async function mockHttp(page: Page, mode: 'success' | 'slow' | 'error') {
  await openEnglishDemo(page);
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
  return page.evaluateHandle(mode => {
    const editor = document.querySelector('draflow-editor')!;
    const original = editor.workflow!;
    const state = { calls: 0, aborted: false, release() {}, switchDocument() { editor.workflow = original; } };
    editor.ports = { fetch: async (_url, init) => {
      const call = ++state.calls;
      if (mode === 'slow' && call === 1) {
        init?.signal?.addEventListener('abort', () => { state.aborted = true; });
        await new Promise<void>(resolve => { state.release = resolve; });
      }
      return mode === 'error' ? new Response('mock error', { status: 503 }) : Response.json({ call });
    } };
    const edge = original.connections[0]!;
    editor.workflow = { ...original, id: 'http-demo', name: 'HTTP demo', nodes: [...original.nodes,
      { id: 'http', name: 'Fetch', type: 'draflow.httpRequest', typeVersion: 1,
        position: { x: 50, y: 160 }, parameters: { url: 'https://example.test/items' } }],
      connections: [{ ...edge, to: { ...edge.to, node: 'http' } },
        { ...edge, id: 'after-http', from: { ...edge.from, node: 'http' } }] };
    return state;
  }, mode);
}

test('previous nodes exclude the target and subsequent steps reuse HTTP until clear or full run', async ({ page }) => {
  const state = await mockHttp(page, 'success');
  const log = page.getByRole('region', { name: 'Execution log' });
  await page.locator('[data-node-id=set]').dblclick();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Execute previous nodes' }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('status')).toHaveText('Fetch · 1 item');
  await expect(log.locator('summary')).toHaveCount(2);
  const fetch = log.locator('details').filter({ hasText: 'Fetch · Run 0' });
  await fetch.locator('summary').click();
  await expect(fetch.locator('code')).toContainText('"call": 1');
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-node-id=set]').dblclick();
    await dialog.getByRole('button', { name: 'Execute step' }).click();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(fetch.locator('summary')).toContainText('reused');
    await expect(page.getByRole('status')).toHaveText('Set · 1 item');
  }
  expect(await state.evaluate(s => s.calls)).toBe(1);
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await expect(fetch.locator('summary')).not.toContainText('reused');
  expect(await state.evaluate(s => s.calls)).toBe(2);
  const before = await page.evaluate(() => document.querySelector('draflow-editor')!.workflow);
  await log.getByRole('button', { name: 'Clear execution' }).click();
  await expect(log).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('Run the workflow to see its output.');
  expect(await page.evaluate(() => document.querySelector('draflow-editor')!.workflow)).toEqual(before);
  await page.evaluate(() => document.querySelector('draflow-editor')!.runNode('set').done);
  expect(await state.evaluate(s => s.calls)).toBe(3);
});

for (const action of ['stop', 'switch'] as const) {
  test('a late HTTP response cannot replace the current view after ' + action, async ({ page }) => {
    const state = await mockHttp(page, 'slow');
    const oldRun = await page.evaluateHandle(() => document.querySelector('draflow-editor')!.run());
    const log = page.getByRole('region', { name: 'Execution log' });
    const fetch = log.locator('details').filter({ hasText: 'Fetch · Run 0' });
    await expect(fetch.locator('summary')).toContainText('running · In 1');
    await fetch.locator('summary').click();
    await expect(fetch.locator('code')).toContainText('"input"');
    await expect.poll(() => state.evaluate(s => s.calls)).toBe(1);
    await expect(page.getByRole('button', { name: 'Tidy Up' })).toBeDisabled();
    if (action === 'stop') {
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(log).toContainText('canceled');
    } else {
      await state.evaluate(s => s.switchDocument());
      await expect(log).toBeHidden();
    }
    expect(await oldRun.evaluate(h => h.done.then(r => r.status))).toBe('canceled');
    expect(await state.evaluate(s => s.aborted)).toBe(true);
    await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Set · 1 item');
    const current = await log.innerText();
    const output = await page.locator('draflow-editor pre').innerText();
    await state.evaluate(async s => { s.release(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(await log.innerText()).toBe(current);
    expect(await page.locator('draflow-editor pre').innerText()).toBe(output);
    await expect(page.getByRole('status')).toHaveText('Set · 1 item');
    expect(await state.evaluate(s => s.calls)).toBe(action === 'stop' ? 2 : 1);
  });
}

test('upstream HTTP failure is visible inside the destination dialog and in its task log', async ({ page }) => {
  await mockHttp(page, 'error');
  await page.locator('[data-node-id=set]').dblclick();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Execute step' }).click();
  await expect(dialog).toContainText('mock error');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('status')).toContainText('503');
  const row = page.locator('summary').filter({ hasText: 'Fetch · Run 0' });
  await expect(row).toContainText(/error · In 1 · Out 0 · [\d.]+ ms.*mock error/);
});

test('a rejected run shows a clearable error and releases the editor for another run', async ({ page }) => {
  await mockHttp(page, 'success');
  const error = await page.evaluate(async () => {
    const run = document.querySelector('draflow-editor')!.runNode('missing');
    return run.done.catch((e: Error) => e.message);
  });
  expect(error).toContain('missing');
  const log = page.getByRole('region', { name: 'Execution log' });
  await expect(log).toContainText('error');
  await log.getByRole('button', { name: 'Clear execution' }).click();
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Set · 1 item');
});

test('tidying and undoing a layout keep the clean upstream HTTP result', async ({ page }) => {
  const state = await mockHttp(page, 'success');
  const read = () => page.evaluate(() => document.querySelector('draflow-editor')!.workflow!.nodes.map(n => n.position));
  const before = await read();
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  const status = page.getByRole('status');
  await expect(status).toHaveText('Set · 1 item');
  await page.getByRole('button', { name: 'Tidy Up' }).click();
  expect(await read()).not.toEqual(before);
  await expect(status).toHaveText('Set · 1 item');
  for (const undo of [false, true]) {
    if (undo) await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.locator('[data-node-id=set]').dblclick();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Execute step' }).click();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(status).toHaveText('Set · 1 item');
    expect(await state.evaluate(s => s.calls)).toBe(1);
  }
});

test('sticky edits retain pins, the current result and cached HTTP output', async ({ page }) => {
  const state = await mockHttp(page, 'success');
  await page.evaluate(() => {
    const el = document.querySelector('draflow-editor')!;
    el.workflow = { ...el.workflow!, pinData: { manual: [{ json: { pinned: true } }] } };
  });
  const runStep = () => page.evaluate(() => document.querySelector('draflow-editor')!.runNode('set').done.then(r => r.status));
  expect(await runStep()).toBe('success');
  const log = page.getByRole('region', { name: 'Execution log' });
  const initialLog = await log.innerText();
  const output = page.locator('draflow-editor pre');
  const initialOutput = await output.innerText();
  await page.getByRole('button', { name: 'Add sticky note' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Note text').fill('Review');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Sticky note · Review' }).click();
  await dialog.getByLabel('Note text').fill('Reviewed');
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect(await log.innerText()).toBe(initialLog);
  expect(await output.innerText()).toBe(initialOutput);
  expect(await page.evaluate(() => document.querySelector('draflow-editor')!.workflow!.pinData)).toEqual({ manual: [{ json: { pinned: true } }] });
  expect(await runStep()).toBe('success');
  expect(await state.evaluate(s => s.calls)).toBe(1);
});
