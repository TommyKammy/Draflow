import { expect, test, type Locator, type Page } from '@playwright/test';
import type {} from '@draflow/element/define';

async function tabTo(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  for (let i = 0; i < 100; i++) {
    if (await control.evaluate(el => el.matches(':focus'))) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab could not reach ' + control);
}

test('authors and runs a mapped node with the keyboard in Japanese', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog');
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  async function activate(control: Locator) {
    await tabTo(page, control);
    await page.keyboard.press('Enter');
  }
  await activate(button('ノードを追加'));
  await expect(dialog.getByRole('searchbox')).toBeFocused();
  await page.keyboard.type('set');
  await activate(button('Edit Fields (Set)'));
  const card = page.locator('.node-card').filter({ has: page.locator('strong', { hasText: 'Edit Fields (Set)' }) });
  await expect(card).toBeFocused();

  await activate(button('ノードを接続'));
  await expect(dialog.getByLabel('出力ポート')).toBeFocused();
  await page.keyboard.press('s');
  await expect(dialog.getByLabel('出力ポート')).toHaveValue(/^Set ·/);
  await tabTo(page, dialog.getByLabel('入力ポート'));
  await page.keyboard.press('e');
  await expect(dialog.getByLabel('入力ポート')).toHaveValue(/^Edit Fields/);
  await activate(button('接続'));
  await activate(card);
  await activate(button('行を追加'));
  await tabTo(page, dialog.getByLabel('名前', { exact: true }));
  await page.keyboard.type('mapped');
  await activate(button('このノードを実行'));
  await activate(button('message'));
  await activate(button('挿入先 値'));
  await expect(dialog.getByLabel('値', { exact: true })).toHaveValue('={{ $json.message }}');
  await activate(button('このノードを実行'));
  await expect(dialog.getByRole('heading', { name: '出力' }).locator('..').locator('pre')).toContainText('"mapped": "Hello Draflow"');
  await activate(button('閉じる'));
  await expect(card).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(card).toBeFocused();
});

test('composition Enter and Delete leave the selected card and dialog alone', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('[data-node-id=set]');
  await card.focus();
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['Enter', 'Delete']) {
      await card.dispatchEvent('keydown', { bubbles: true, key, ...init });
      await expect(card).toBeFocused();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  }
  await page.keyboard.press('Enter');
  const input = page.getByLabel('値', { exact: true });
  await input.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'へんかん', selectionStart: 4, selectionEnd: 4 });
  await cdp.send('Input.insertText', { text: '変換' });
  await expect(input).toHaveValue(/変換/);
  await page.keyboard.press('Escape');
  await expect(card).toBeFocused();
});

test('switches theme and language, including mobile panes and existing execution logs', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const editor = page.locator('draflow-editor');
  const panel = editor.locator('.editor');
  const background = () => panel.evaluate(el => getComputedStyle(el).backgroundColor);
  const dark = await background();
  await editor.evaluate(el => el.setAttribute('theme', 'light'));
  const light = await background();
  expect(light).not.toBe(dark);
  await editor.evaluate(el => el.setAttribute('theme', 'dark'));
  expect(await background()).toBe(dark);
  await editor.evaluate(el => el.setAttribute('theme', 'auto'));
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await background()).toBe(light);
  await editor.getByRole('button', { name: '実行', exact: true }).click();
  await expect(editor.getByRole('region', { name: '実行ログ' })).toContainText('成功');
  await editor.evaluate(el => el.setAttribute('locale', 'en'));
  await expect(editor.getByRole('region', { name: 'Execution log' })).toContainText('Set · Run 0 · success');
  await editor.locator('[data-node-id=set]').dblclick();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Output', exact: true }).click();
  await expect(dialog.locator('pre:visible')).toContainText('Hello Draflow');
  await editor.evaluate(el => el.setAttribute('theme', 'dark'));
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(dark);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('port picker keeps the selected branch and input slot through Undo and Redo', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-node-id=set]')).toBeVisible();
  const editor = page.locator('draflow-editor');
  await page.evaluate(() => {
    const el = document.querySelector('draflow-editor')!;
    const workflow = el.workflow!;
    workflow.nodes[0]!.type = 'draflow.if';
    workflow.nodes[1]!.type = 'draflow.merge';
    workflow.connections = [];
    el.workflow = workflow;
  });
  await editor.getByRole('button', { name: 'ノードを接続' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('出力ポート').selectOption({ label: 'Manual · False · main[1]' });
  await dialog.getByLabel('入力ポート').selectOption({ label: 'Set · 入力 2 · main[1]' });
  await dialog.getByRole('button', { name: '接続', exact: true }).click();
  const edges = () => page.evaluate(() => document.querySelector('draflow-editor')!.workflow!.connections);
  const connected = await edges();
  expect(connected).toEqual([{ id: expect.any(String), from: { node: 'manual', port: 'main', index: 1 },
    to: { node: 'set', port: 'main', index: 1 } }]);
  await editor.getByRole('button', { name: '元に戻す' }).click();
  expect(await edges()).toEqual([]);
  await editor.getByRole('button', { name: 'やり直す' }).click();
  expect(await edges()).toEqual(connected);
});
