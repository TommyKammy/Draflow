import { expect, test, type Locator } from '@playwright/test';
import type {} from '@draflow/element/define';

async function bounds(node: Locator) {
  const box = await node.boundingBox();
  if (!box) throw new Error('Expected a visible canvas element');
  return box;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
});

test('pans on two axes, zooms around the cursor, and fits the graph again', async ({ page }) => {
  const canvas = page.getByRole('group', { name: 'ワークフローキャンバス' });
  const card = canvas.locator('[data-node-id="manual"]');
  await expect(canvas.locator('svg path')).toHaveCount(1);
  const before = await bounds(card);
  const area = await bounds(canvas);
  await page.mouse.move(area.x + 20, area.y + 20);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(area.x + 65, area.y + 50);
  await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => Math.round((await bounds(card)).x - before.x)).toBe(45);
  expect(Math.round((await bounds(card)).y - before.y)).toBe(30);
  const panned = await bounds(card);
  await page.mouse.move(panned.x + panned.width / 2, panned.y + panned.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -160);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await bounds(card)).width).toBeGreaterThan(panned.width);
  const zoomed = await bounds(card);
  expect(zoomed.x + zoomed.width / 2).toBeCloseTo(panned.x + panned.width / 2, 0);
  await page.getByRole('button', { name: '全体表示' }).click();
  await expect.poll(async () => (await bounds(card)).x).toBeCloseTo(before.x, 1);
  expect((await bounds(card)).width).toBeCloseTo(before.width, 1);
  await canvas.focus();
  await page.keyboard.down('Space');
  await page.mouse.move(area.x + 30, area.y + 20);
  await page.mouse.down();
  await page.mouse.move(area.x + 8, area.y + 60);
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect.poll(async () => Math.round((await bounds(card)).x - before.x)).toBe(-22);
  await page.keyboard.press('1');
  await expect.poll(async () => (await bounds(card)).y).toBeCloseTo(before.y, 1);
});

test('selects individual nodes, extends selection, and selects a rectangle in readonly mode', async ({ page }) => {
  const editor = page.locator('draflow-editor');
  await editor.evaluate(el => el.setAttribute('readonly', ''));
  const manual = editor.locator('[data-node-id="manual"]');
  const set = editor.locator('[data-node-id="set"]');
  const selections = await page.evaluateHandle(() => {
    const seen: string[][] = [];
    document.addEventListener('draflow-selection', e => seen.push((e as CustomEvent).detail.nodeIds));
    return seen;
  });
  await manual.click();
  await expect(manual).toHaveAttribute('aria-pressed', 'true');
  await set.click({ modifiers: ['Shift'] });
  await expect(set).toHaveAttribute('aria-pressed', 'true');
  await set.click({ modifiers: ['Shift'] });
  await expect(set).toHaveAttribute('aria-pressed', 'false');
  const a = await bounds(manual), b = await bounds(set);
  await page.mouse.move(a.x - 8, a.y - 8);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 8, b.y + b.height + 8);
  await page.mouse.up();
  await expect(set).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(manual).toHaveAttribute('aria-pressed', 'false');
  expect(await selections.jsonValue()).toEqual([['manual'], ['manual', 'set'], ['manual'], ['manual', 'set'], []]);
  await expect(page.getByRole('button', { name: '実行' })).toBeDisabled();
});

test('keeps indexed ports distinct, fits negative coordinates, and shows execution state', async ({ page }) => {
  await page.getByRole('button', { name: '実行' }).click();
  const editor = page.locator('draflow-editor');
  await expect(editor.locator('[data-node-id="set"]')).toContainText('成功 · 1件');
  await editor.evaluate(el => {
    const editor = el as HTMLElementTagNameMap['draflow-editor'];
    const wf = editor.workflow!;
    wf.nodes[0]!.type = 'draflow.if';
    wf.nodes[0]!.position = { x: -900, y: -500 };
    wf.nodes[1]!.type = 'draflow.merge';
    wf.connections.push({
      id: 'second', from: { node: 'manual', port: 'main', index: 1 },
      to: { node: 'set', port: 'main', index: 1 },
    });
    editor.workflow = wf;
  });
  const paths = await editor.locator('svg path').evaluateAll(paths => paths.map(p => p.getAttribute('d')));
  expect(new Set(paths).size).toBe(2);
  const area = await bounds(editor.locator('.canvas'));
  await expect.poll(async () => (await bounds(editor.locator('[data-node-id="manual"]'))).x).toBeGreaterThan(area.x);
  expect((await bounds(editor.locator('[data-node-id="manual"]'))).y).toBeGreaterThan(area.y);
  await editor.evaluate(el => (el as HTMLElementTagNameMap['draflow-editor']).focusNode('set'));
  await expect(editor.locator('[data-node-id="set"]')).toBeFocused();
});
