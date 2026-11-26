import { expect, test } from '@playwright/test';
import type { EditorRunEvent } from '@draflow/element';
import type {} from '@draflow/element/define';

test('runs the embedded Manual → Set example and displays the emitted item', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('draflow-editor');
  await expect(editor.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
  const events = await page.evaluateHandle(() => {
    const seen: string[] = [];
    const editor = document.querySelector('draflow-editor')!;
    for (const name of ['run-start', 'node-start', 'node-finish', 'run-finish']) {
      editor.addEventListener('draflow-' + name, event => {
        const { detail } = event as CustomEvent<EditorRunEvent['detail']>;
        seen.push('nodeId' in detail ? name + '/' + detail.nodeId : name);
      });
    }
    return seen;
  });
  await editor.getByRole('button', { name: '実行', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('Set · 1件');
  expect(JSON.parse(await editor.locator('pre').innerText())).toEqual([{ message: 'Hello Draflow' }]);
  expect(await events.jsonValue()).toEqual([
    'run-start', 'node-start/manual', 'node-finish/manual', 'node-start/set', 'node-finish/set', 'run-finish',
  ]);
});

test('detaches a running editor and can reconnect the same instance', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
  const canceled = await page.evaluate(async () => {
    const editor = document.querySelector('draflow-editor')!;
    const parent = editor.parentElement!;
    const handle = editor.run();
    editor.remove();
    parent.append(editor);
    return (await handle.done).status;
  });
  expect(canceled).toBe('canceled');
  await expect(page.getByRole('status')).toHaveText('実行すると結果が表示されます。');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Set · 1件');
});

test('loading the embedded bundle again preserves the registered element class', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const initial = customElements.get('draflow-editor');
    const module = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!;
    await import(module.src + '?second-registration');
    return initial === customElements.get('draflow-editor');
  })).toBe(true);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Set · 1件');
});

test('changing presentation retains the output and applies readonly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Set · 1件');
  await page.locator('draflow-editor').evaluate(editor => {
    editor.setAttribute('locale', 'en');
    editor.setAttribute('theme', 'dark');
    editor.setAttribute('readonly', '');
  });
  await expect(page.getByRole('status')).toHaveText('Set · 1 item');
  await expect(page.getByRole('button', { name: 'Run workflow' })).toBeDisabled();
  await expect(page.locator('draflow-editor pre')).toContainText('Hello Draflow');
});

test('runs the HTTP example using the host mock', async ({ page }) => {
  const outbound: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).hostname === 'example.test') outbound.push(request.url());
  });
  await page.goto('/?example=mock-http');
  await expect(page.getByRole('heading', { name: 'Manual → HTTP' })).toBeVisible();
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('HTTP · 1件');
  expect(JSON.parse(await page.locator('draflow-editor pre').innerText())).toEqual([{ amount: 42 }]);
  expect(outbound).toEqual([]);
});
