import { test, expect, type Page } from '@playwright/test';
import { openEnglishDemo } from './locale.js';
import type {} from '@draflow/element/define';

const state = (page: Page) => page.evaluate(() => document.querySelector('draflow-editor')!.workflow!);

async function fixture(page: Page) {
  await openEnglishDemo(page);
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
  await page.evaluate(() => {
    const el = document.querySelector('draflow-editor')!, w = el.workflow!;
    const branch = { ...w.nodes[1]!, id: 'if', name: 'If', type: 'draflow.if',
      parameters: { conditions: { combinator: 'and', conditions: [{ left: '={{ $json.yes }}', operator: 'isTrue' }] } } };
    const merge = { ...branch, id: 'merge', name: 'Merge', type: 'draflow.merge', parameters: { mode: 'append' }, position: { x: 550, y: 80 } };
    const edge = w.connections[0]!;
    el.workflow = { ...w, nodes: [w.nodes[0]!, branch, merge], connections: [
      { ...edge, id: 'inside', to: { ...edge.to, node: 'if' } },
      ...[0, 1].map(index => ({ id: 'outside' + index, from: { node: 'if', port: 'main', index }, to: { node: 'merge', port: 'main', index } })),
    ] };
  });
  await page.locator('[data-node-id=manual]').click();
  await page.locator('[data-node-id=if]').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Group nodes' }).click();
  await page.getByLabel('Group name').fill('Routing');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}
async function execute(page: Page) {
  return page.evaluate(async () => {
    const result = await document.querySelector('draflow-editor')!.run({ triggerData: { main: [[
      { json: { yes: true } }, { json: { yes: false } },
    ]] } }).done;
    return { status: result.status, json: result.runData.merge?.[0]?.output?.main?.[0]?.map(i => i.json) };
  });
}

test('move, collapse, persist and ungroup preserve both If → Merge slots and output', async ({ page }) => {
  await fixture(page);
  const initial = await state(page), result = await execute(page);
  expect(result).toEqual({ status: 'success', json: [{ yes: true }, { yes: false }] });
  const label = page.getByRole('button', { name: 'Routing', exact: true });
  await label.hover();
  const box = (await label.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 36, y + 20, { steps: 5 }); await page.mouse.up();
  const moved = await state(page);
  const delta = (i: number) => [moved.nodes[i]!.position.x - initial.nodes[i]!.position.x, moved.nodes[i]!.position.y - initial.nodes[i]!.position.y];
  expect(delta(0)).not.toEqual([0, 0]);
  expect(delta(1)).toEqual(delta(0));
  expect(delta(2)).toEqual([0, 0]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await state(page)).toEqual(initial);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await state(page)).toEqual(moved);
  const edge = page.locator('[data-edge-id=outside1]');
  const expandedPath = await edge.getAttribute('d');
  await page.getByRole('button', { name: 'Collapse · Routing' }).press('Enter');
  const folded = await state(page);
  await expect(page.locator('[data-node-id=if]')).toBeHidden();
  await expect(page.locator('[data-edge-id=inside]')).toHaveCount(0);
  await expect(page.locator('path[data-edge-id]')).toHaveCount(2);
  expect(await edge.getAttribute('d')).not.toBe(expandedPath);
  expect(folded.connections).toEqual(initial.connections);
  expect(await execute(page)).toEqual(result);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '展開 · Routing' })).toBeVisible();
  expect(await state(page)).toEqual(folded);
  const canvas = page.locator('.canvas');
  const rect = (await canvas.boundingBox())!;
  await page.mouse.move(rect.x + 2, rect.y + 2); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 2, rect.y + rect.height - 2); await page.mouse.up();
  expect(await page.locator('.node-card[aria-pressed=true]').evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.nodeId))).toEqual(['merge']);
  await page.getByRole('button', { name: '展開 · Routing' }).press('Enter');
  await expect(edge).toHaveAttribute('d', expandedPath!);
  await page.getByRole('button', { name: 'Routing', exact: true }).click();
  await page.getByRole('button', { name: 'グループ解除' }).click();
  const ungrouped = await state(page);
  expect(ungrouped.nodes).toEqual(moved.nodes);
  expect(ungrouped.connections).toEqual(initial.connections);
  expect(await execute(page)).toEqual(result);
});

test('tidy keeps offsets, deletion is reversible and copies use fresh member IDs', async ({ page }) => {
  await fixture(page);
  const before = await state(page);
  await page.locator('.canvas').press('Escape');
  await page.getByRole('button', { name: 'Tidy Up' }).click();
  const after = await state(page);
  function offset(nodes: typeof before.nodes) {
    return [nodes[1]!.position.x - nodes[0]!.position.x, nodes[1]!.position.y - nodes[0]!.position.y];
  }
  expect(offset(after.nodes)).toEqual(offset(before.nodes));
  await page.locator('[data-node-id=if]').click();
  await page.keyboard.press('Delete');
  expect((await state(page)).meta?.draflowEditor).toMatchObject({ groups: [{ members: ['manual'] }] });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await state(page)).toEqual(after);
  await page.locator('[data-node-id=manual]').click();
  await page.locator('[data-node-id=if]').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+d');
  const duplicated = await state(page);
  const meta = duplicated.meta?.draflowEditor as { groups: { id: string; members: string[] }[] };
  expect(meta.groups).toHaveLength(2);
  expect(meta.groups[0]!.id).not.toBe(meta.groups[1]!.id);
  expect(meta.groups[1]!.members).toEqual(duplicated.nodes.slice(-2).map(n => n.id));
});

test('pastes a group into a different workflow with fresh IDs and inspects it on a narrow readonly canvas', async ({ page }) => {
  await fixture(page);
  await page.locator('[data-node-id=manual]').click();
  await page.locator('[data-node-id=if]').click({ modifiers: ['Shift'] });
  await page.evaluate(() => {
    const editor = document.querySelector('draflow-editor')!;
    const canvas = editor.shadowRoot!.querySelector('.canvas')!;
    const data = new DataTransfer();
    canvas.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    const w = editor.workflow!;
    editor.workflow = { schema: w.schema, id: 'destination', name: 'Copy', settings: {}, nodes: [], connections: [], meta: { tenant: 'B' } };
    canvas.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const copied = await state(page);
  const ids = copied.nodes.map(n => n.id);
  expect(ids).toHaveLength(2);
  expect(ids).not.toContain('manual'); expect(ids).not.toContain('if');
  expect(copied.connections.map(e => [e.from.node, e.to.node])).toEqual([ids]);
  expect(copied.meta).toMatchObject({ tenant: 'B', draflowEditor: { groups: [{ members: ids }] } });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.locator('draflow-editor').evaluate(el => el.setAttribute('readonly', ''));
  const toggle = page.getByRole('button', { name: 'Collapse · Routing' });
  await toggle.press('Enter');
  const expand = page.getByRole('button', { name: 'Expand · Routing' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeFocused();
  await expand.press('Space');
  await expect(toggle).toBeFocused();
  expect(await state(page)).toEqual(copied);
});
