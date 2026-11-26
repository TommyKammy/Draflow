import { expect, test, type Page } from '@playwright/test';
import type {} from '@draflow/element/define';

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
}
function snapshot(page: Page) {
  return page.evaluate(() => document.querySelector('draflow-editor')!.workflow!);
}

test('lays out branches, joins, cycles and disconnected nodes in one saved move', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const editor = document.querySelector('draflow-editor')!;
    const w = editor.workflow!;
    const types = ['manualTrigger', 'if', 'set', 'set', 'merge', 'set', 'set', 'set', 'set'];
    w.nodes = types.map((type, i) => ({ ...w.nodes[0]!, id: String(i), name: type + i,
      type: 'draflow.' + type, position: { x: 51 - i * 7, y: i % 2 ? -31 : 309 } }));
    w.connections = [[0,1],[1,2],[1,3],[2,4],[3,4],[4,5],[5,6],[6,5],[6,7]].map(([a,b], i) => ({
      id: String(i), from: { node: String(a), port: 'main', index: i === 2 ? 1 : 0 },
      to: { node: String(b), port: 'main', index: i === 4 ? 1 : 0 },
    }));
    editor.workflow = w;
  });
  const before = await snapshot(page);
  const tidy = page.getByRole('button', { name: '自動整列' });
  await tidy.focus();
  await page.keyboard.press('Enter');
  const after = await snapshot(page);
  expect(after.connections).toEqual(before.connections);
  const p = after.nodes.map(n => n.position);
  for (const [i, { x, y }] of p.entries()) {
    expect(x / 16).toBe(Math.round(x / 16));
    expect(y / 16).toBe(Math.round(y / 16));
    for (const other of p.slice(i + 1)) expect(Math.abs(x - other.x) >= 180 || Math.abs(y - other.y) >= 72).toBe(true);
  }
  const columns = p.map(point => point.x);
  expect(columns[2]).toBe(columns[3]);
  expect(columns[5]).toBe(columns[6]);
  for (const [left, right] of [[0,1],[1,2],[3,4],[4,5],[6,7]] as const) expect(columns[left]).toBeLessThan(columns[right]!);
  expect(p[2]!.y).toBeLessThan(p[3]!.y);
  expect(p[8]!.y).toBeGreaterThan(Math.max(...p.slice(0,8).map(point => point.y)));
  await tidy.click();
  expect(await snapshot(page)).toEqual(after);
  await page.getByRole('button', { name: '元に戻す' }).click();
  expect(await snapshot(page)).toEqual(before);
  await expect(page.getByRole('button', { name: '元に戻す' })).toBeDisabled();
  await page.getByRole('button', { name: 'やり直す' }).click();
  expect(await snapshot(page)).toEqual(after);
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.node-card')).toHaveCount(9);
  expect(await snapshot(page)).toEqual(after);
});

test('partial layout avoids an off-grid fixed card and preserves the selection', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page);
  await page.evaluate(() => {
    const el = document.querySelector('draflow-editor')!;
    const w = el.workflow!;
    w.nodes[0]!.position = { x: 0, y: 200 };
    w.nodes[1]!.position = { x: 487, y: 0 };
    w.nodes.push({ ...w.nodes[1]!, id: 'fixed', name: 'Fixed', position: { x: -9, y: -5 } });
    el.workflow = w;
  });
  const card = (id: string) => page.locator('[data-node-id="' + id + '"]');
  await card('manual').click();
  await card('set').click({ modifiers: ['Shift'] });
  const tidy = page.getByRole('button', { name: '自動整列' });
  const before = await snapshot(page);
  await tidy.click();
  const after = await snapshot(page);
  expect(after.nodes[2]).toEqual(before.nodes[2]);
  expect(after.connections).toEqual(before.connections);
  const [manual, set, fixed] = after.nodes;
  expect(manual!.position.y).toBeGreaterThanOrEqual(fixed!.position.y + 72);
  expect(set!.position.x).toBeGreaterThan(manual!.position.x);
  await expect(page.locator('.node-card[aria-pressed=true]')).toHaveCount(2);
  await tidy.click();
  expect(await snapshot(page)).toEqual(after);
  await page.getByRole('button', { name: '元に戻す' }).click();
  expect(await snapshot(page)).toEqual(before);
  await page.locator('draflow-editor').evaluate(el => el.setAttribute('readonly', ''));
  await expect(tidy).toBeHidden();
});
