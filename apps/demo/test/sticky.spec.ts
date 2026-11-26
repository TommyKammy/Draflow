import { expect, test, type Page } from '@playwright/test';
import type {} from '@draflow/element/define';

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
}
function documentState(page: Page) {
  return page.evaluate(() => document.querySelector('draflow-editor')!.workflow!);
}

test('saves plain-text annotations, moves with the pointer and restores deletion with Undo', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const editor = document.querySelector('draflow-editor')!;
    editor.workflow = { ...editor.workflow!, meta: { host: { labels: ['維持'] } } };
  });
  const before = await documentState(page);
  const add = page.getByRole('button', { name: '付箋を追加' });
  await add.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  const body = dialog.getByRole('textbox', { name: '本文' });
  await expect(body).toBeFocused();
  const text = '分岐の確認\n<b>入力</b>';
  await body.fill('下書き');
  await dialog.getByRole('button', { name: '保存' }).click();
  const annotation = page.getByRole('button', { name: '付箋 · ' + text });
  const draft = page.getByRole('button', { name: '付箋 · 下書き' });
  await expect(draft).toBeFocused();
  const created = await documentState(page);
  expect(created.nodes).toEqual(before.nodes);
  expect(created.connections).toEqual(before.connections);
  expect(created.meta?.host).toEqual(before.meta?.host);
  await page.keyboard.press('Enter');
  await body.fill(text);
  await dialog.getByLabel('色').selectOption('blue');
  await dialog.getByLabel('幅').fill('230');
  await dialog.getByLabel('高さ').fill('104');
  await dialog.getByLabel('X', { exact: true }).fill('48');
  await dialog.getByLabel('Y', { exact: true }).fill('128');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(annotation).toBeFocused();
  expect(await annotation.locator('b').count()).toBe(0);
  const card = page.locator('.sticky-card');
  await expect(card).toHaveCSS('width', '230px');
  await expect(card).toHaveCSS('height', '104px');
  await expect(card).toHaveAttribute('data-color', 'blue');
  await page.getByRole('button', { name: '全体表示' }).click();
  await card.locator('.sticky-grip').hover();
  const grip = (await card.locator('.sticky-grip').boundingBox())!;
  const scale = (await card.boundingBox())!.width / 230;
  const start = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 32 * scale, start.y + 16 * scale, { steps: 4 });
  await page.mouse.up();
  await expect(card).toHaveCSS('left', '80px');
  await expect(card).toHaveCSS('top', '144px');
  const moved = await documentState(page);
  expect(moved.meta?.draflowEditor).toMatchObject({ version: 1, notes: [
    { id: expect.any(String), text, width: 230, height: 104, color: 'blue', x: 80, y: 144 },
  ] });
  await annotation.click();
  await dialog.getByRole('button', { name: '削除' }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: '元に戻す' }).click();
  expect(await documentState(page)).toEqual(moved);
  await page.getByRole('button', { name: 'やり直す' }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await page.reload();
  await expect(annotation).toBeVisible();
  expect(await documentState(page)).toEqual(moved);
  await page.setViewportSize({ width: 360, height: 720 });
  await page.locator('draflow-editor').evaluate(el => el.setAttribute('readonly', ''));
  await expect(add).toBeHidden();
  await annotation.click();
  await expect(body).toHaveValue(text);
  await expect(body).not.toBeEditable();
  await expect(dialog.getByRole('button', { name: '保存' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(annotation).toBeFocused();
});

test('unknown metadata versions survive normal node editing and persistence', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const editor = document.querySelector('draflow-editor')!;
    editor.workflow = { ...editor.workflow!, meta: { tenant: 'A', draflowEditor: { version: 27, notes: ['future'], other: true } } };
  });
  const before = await documentState(page);
  await expect(page.getByRole('button', { name: '付箋を追加' })).toBeDisabled();
  await page.getByRole('button', { name: '自動整列' }).click();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
  const restored = await documentState(page);
  expect(restored.nodes).not.toEqual(before.nodes);
  expect(restored.meta).toEqual(before.meta);
  await expect(page.getByRole('button', { name: '付箋を追加' })).toBeDisabled();
});
