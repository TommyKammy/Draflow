import { expect, test, type Locator, type Page } from '@playwright/test';
import type {} from '@draflow/element/define';

async function center(el: Locator) {
  const b = await el.boundingBox();
  if (!b) throw new Error('Expected visible control');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function drag(page: Page, start: { x: number; y: number }, end: { x: number; y: number }) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}
function documentState(page: Page) {
  return page.evaluate(() => document.querySelector('draflow-editor')!.workflow!);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
});

test('commits one snapped drag, restores deleted connections, saves and reloads', async ({ page }) => {
  const card = page.locator('[data-node-id="manual"]');
  const before = await documentState(page);
  const start = await center(card);
  await drag(page, start, { x: start.x + 35, y: start.y + 51 });
  const moved = await documentState(page);
  expect(moved.nodes[0]!.position).toEqual({ x: 32, y: 48 });
  await page.getByRole('button', { name: '元に戻す' }).click();
  expect(await documentState(page)).toEqual(before);
  await page.getByRole('button', { name: 'やり直す' }).click();
  expect(await documentState(page)).toEqual(moved);
  await card.click();
  await page.keyboard.press('Delete');
  expect((await documentState(page)).connections).toHaveLength(0);
  await page.getByRole('button', { name: '元に戻す' }).click();
  expect(await documentState(page)).toEqual(moved);
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await page.reload();
  await expect(card).toBeVisible();
  expect(await documentState(page)).toEqual(moved);
  await page.getByRole('button', { name: '実行' }).click();
  await expect(page.getByRole('status')).toHaveText('Set · 1件');
});

test('adds a node, wires indexed ports and disconnects a selected edge', async ({ page }) => {
  await page.locator('draflow-editor').evaluate(el => {
    const editor = el as HTMLElementTagNameMap['draflow-editor'];
    const w = editor.workflow!;
    w.nodes[0]!.type = 'draflow.if';
    w.nodes[1]!.type = 'draflow.merge';
    w.nodes[1]!.position.x = 360;
    w.connections = [];
    editor.workflow = w;
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const a = page.locator('[data-node-id="manual"] .output').nth(1);
  const b = page.locator('[data-node-id="set"] .input').nth(1);
  const start = await center(a), end = await center(b);
  await drag(page, start, end);
  const wired = await documentState(page);
  expect(wired.connections).toHaveLength(1);
  expect(wired.connections[0]).toMatchObject({
    from: { node: 'manual', port: 'main', index: 1 }, to: { node: 'set', port: 'main', index: 1 },
  });
  await page.mouse.click((start.x + end.x) / 2, (start.y + end.y) / 2);
  await page.keyboard.press('Backspace');
  expect((await documentState(page)).connections).toEqual([]);
  await page.keyboard.press('Control+z');
  expect(await documentState(page)).toEqual(wired);
  await page.getByRole('combobox').selectOption('draflow.noOp');
  await page.getByRole('button', { name: '追加', exact: true }).click();
  expect((await documentState(page)).nodes.at(-1)?.type).toBe('draflow.noOp');
});

test('serializes delayed saves, isolates documents and retries a failed write', async ({ page }) => {
  const editor = page.locator('draflow-editor');
  const writes = await page.evaluateHandle(() => {
    const editor = document.querySelector('draflow-editor')!;
    const log: string[] = [];
    let release!: () => void;
    let fail = true;
    editor.ports = { storage: {
      async load() { return null; },
      async save(w) {
        log.push(w.id + '/' + w.nodes[0]!.position.x);
        if (log.length === 1) await new Promise<void>(resolve => { release = resolve; });
        if (w.id === 'B' && fail) { fail = false; throw Error('quota'); }
      },
    } };
    return { log, release: () => release() };
  });
  async function nudge() {
    await page.locator('[data-node-id="manual"]').click();
    await page.keyboard.press('ArrowRight');
  }
  await nudge();
  await expect.poll(() => writes.evaluate(w => w.log)).toEqual(['manual-set/16']);
  await nudge();
  await editor.evaluate(el => {
    const editor = el as HTMLElementTagNameMap['draflow-editor'];
    const next = editor.workflow!;
    editor.workflow = { ...next, id: 'B', name: 'Second' };
  });
  await nudge();
  await expect(page.getByText(/Second · Error: quota/)).toBeVisible();
  await writes.evaluate(w => w.release());
  await expect.poll(() => writes.evaluate(w => w.log)).toEqual(['manual-set/16', 'B/48', 'manual-set/32']);
  await expect(page.getByRole('button', { name: '保存を再試行' })).toBeVisible();
  await page.getByRole('button', { name: '保存を再試行' }).click();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  expect(await writes.evaluate(w => w.log.at(-1))).toBe('B/48');
});

test('readonly preserves selection but blocks drag, deletion, duplication and history', async ({ page }) => {
  const editor = page.locator('draflow-editor');
  const before = await documentState(page);
  await editor.evaluate(el => el.setAttribute('readonly', ''));
  const card = page.locator('[data-node-id="manual"]');
  await card.click();
  const start = await center(card);
  await drag(page, start, { x: start.x + 32, y: start.y + 32 });
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+d');
  await editor.evaluate(el => (el as HTMLElementTagNameMap['draflow-editor']).undo());
  expect(await documentState(page)).toEqual(before);
});

test('copies a selection with its internal wiring and undoes a paste as one edit', async ({ page }) => {
  const manual = page.locator('[data-node-id="manual"]'), set = page.locator('[data-node-id="set"]');
  await manual.click();
  await set.click({ modifiers: ['Shift'] });
  const initial = await documentState(page);
  await page.locator('.canvas').evaluate(el => {
    const clipboardData = new DataTransfer();
    el.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  const copy = await documentState(page);
  expect(copy.nodes).toHaveLength(4);
  expect(copy.connections).toHaveLength(2);
  expect(copy.connections[1]?.from.node).toBe(copy.nodes[2]?.id);
  expect(copy.connections[1]?.to.node).toBe(copy.nodes[3]?.id);
  expect(new Set(copy.nodes.map(node => node.name)).size).toBe(4);
  await page.getByRole('button', { name: '元に戻す' }).click();
  expect(await documentState(page)).toEqual(initial);
});
