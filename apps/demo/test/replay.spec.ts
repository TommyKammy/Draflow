import { expect, test } from '@playwright/test';
import { openEnglishDemo, setEnglish } from './locale.js';
import type {} from '@draflow/element/define';

test('replays historical HTTP → Filter → Set data offline and copies without reusing its tasks', async ({ page }) => {
  await openEnglishDemo(page);
  const fixture = await page.evaluateHandle(async () => {
    const el = document.querySelector('draflow-editor')!, w = el.workflow!;
    let calls = 0;
    el.ports = { ...el.ports, fetch: async () => Response.json({ amount: ++calls }) };
    const [manual, set] = w.nodes;
    const http = { ...set!, id: 'http', name: 'Recorded HTTP', type: 'draflow.httpRequest',
      parameters: { url: 'https://example.test/items' } };
    const filter = { ...set!, id: 'filter', name: 'Filter', type: 'draflow.filter',
      parameters: { conditions: { combinator: 'and', conditions: [{ left: '={{ $json.amount }}', operator: 'gt', right: 0 }] } } };
    w.nodes = [manual!, http, filter, set!];
    w.nodes.forEach((n, i) => { n.position = { x: i * 220, y: 0 }; });
    w.connections = w.nodes.slice(1).map((n, i) => ({ id: 'c' + i, from: { node: w.nodes[i]!.id, port: 'main', index: 0 },
      to: { node: n.id, port: 'main', index: 0 } }));
    el.workflow = w;
    await el.run({ runId: 'offline', triggerData: { main: [[{ json: {} }, { json: {} }]] } }).done;
    const store = el.ports.executions!, record = await store.get(w.id, 'offline');
    const original = el.workflow!;
    original.nodes[1]!.name = 'Edited HTTP';
    original.connections.pop();
    el.workflow = original;
    return { calls: () => calls, record, original, w, stored: () => store.get(w.id, 'offline') };
  });
  await page.getByRole('button', { name: 'Add sticky note' }).click();
  await page.getByLabel('Note text').fill('Original work');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const working = await page.evaluate(() => document.querySelector('draflow-editor')!.workflow!);
  expect(await fixture.evaluate(f => f.calls())).toBe(2);
  const launcher = page.getByRole('button', { name: 'Execution history' });
  const dialog = page.getByRole('dialog');
  await launcher.click();
  const replay = dialog.getByRole('region', { name: 'Execution replay' });
  await dialog.getByRole('button', { name: 'Replay', exact: true }).click();
  await replay.getByText('Recorded workflow', { exact: true }).click();
  await expect(replay.getByText('Recorded HTTP · main[0] → Filter · main[0]', { exact: true })).toBeVisible();
  await expect(replay.getByText('Filter · main[0] → Set · main[0]', { exact: true })).toBeVisible();
  const next = replay.getByRole('button', { name: 'Next task' });
  await next.click();
  await expect(replay.locator('[aria-live]')).toContainText('Recorded HTTP · Run 0');
  await next.click();
  const item = replay.getByRole('spinbutton', { name: 'Output item' });
  await item.fill('2'); await item.press('Enter');
  await expect(replay.locator('mark').last()).toContainText('"amount": 2');
  await replay.getByRole('button', { name: 'Previous task' }).click();
  await page.keyboard.press('Escape');
  await expect(launcher).toBeFocused();
  await launcher.click(); await dialog.getByRole('button', { name: 'Replay', exact: true }).click();
  expect(await fixture.evaluate(f => f.calls())).toBe(2);
  await replay.getByRole('button', { name: 'Copy to editor' }).click();
  const copied = await page.evaluate(() => document.querySelector('draflow-editor')!.workflow!);
  expect(copied.id).not.toBe('manual-set');
  expect({ ...copied, id: 'manual-set' }).toEqual(await fixture.evaluate(f => f.w));
  const copy = await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!;
    return el.ports.storage!.load(el.workflow!.id);
  });
  expect(copy).toEqual(copied);
  await page.locator('[data-node-id=set]').dblclick();
  await dialog.getByLabel('Value', { exact: true }).fill('copy only');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(async () => { await document.querySelector('draflow-editor')!.runNode('set').done; });
  expect(await fixture.evaluate(f => f.calls())).toBe(3);
  expect(await fixture.evaluate(f => f.stored())).toEqual(await fixture.evaluate(f => f.record));
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const copyUrl = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { name: copied.name })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('draflow-editor')!.workflow!.id)).toBe(copied.id);
  expect(await page.evaluate(() => document.querySelector('draflow-editor')!.workflow!.nodes.at(-1)!.parameters))
    .toMatchObject({ assignments: [{ value: 'copy only' }] });
  await page.getByRole('button', { name: '元の文書に戻る' }).click();
  expect(page.url()).not.toBe(copyUrl);
  expect(await page.evaluate(() => document.querySelector('draflow-editor')!.workflow)).toEqual(working);
});

test('late detail never replaces another replay, a closed dialog or a new document', async ({ page }) => {
  await openEnglishDemo(page);
  const state = await page.evaluateHandle(async () => {
    const el = document.querySelector('draflow-editor')!, store = el.ports.executions!, w = el.workflow!;
    let release!: () => void;
    el.ports = { ...el.ports, executions: { append: store.append.bind(store), list: store.list.bind(store), delete: store.delete.bind(store),
      async get(id, run) {
        if (run === 'slow') await new Promise<void>(r => { release = r; });
        return store.get(id, run);
      } } };
    await el.run({ runId: 'slow' }).done;
    await el.run({ runId: 'fast' }).done;
    return { release: () => release(), switchDoc: () => { el.workflow = { ...w, id: 'other' }; } };
  });
  const dialog = page.getByRole('dialog');
  const open = (run: string) => dialog.getByRole('listitem').filter({ hasText: run }).getByRole('button', { name: 'Replay' }).click();
  await page.getByRole('button', { name: 'Execution history' }).click();
  await open('slow'); await open('fast');
  const visible = dialog.getByRole('region', { name: 'Execution replay' }).getByRole('heading').first();
  await expect(visible).toContainText('fast');
  await state.evaluate(s => s.release()); await expect(visible).toContainText('fast');
  await open('slow'); await page.keyboard.press('Escape'); await state.evaluate(s => s.release());
  await expect(page.locator('.execution-history section')).toHaveCount(0);
  await page.getByRole('button', { name: 'Execution history' }).click();
  await open('slow'); await state.evaluate(s => { s.switchDoc(); s.release(); });
  await expect(page.locator('.execution-history section')).toHaveCount(0);
});

test('failed and stopped runs distinguish unvisited nodes and support narrow readonly replay', async ({ page }) => {
  await page.goto('/?example=mock-http');
  await expect(page.locator('[data-node-id=http]')).toBeVisible();
  await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!, w = el.workflow!;
    w.nodes.push({ ...w.nodes[1]!, id: 'later', name: 'Later', type: 'draflow.set', parameters: {} });
    w.connections.push({ id: 'later-edge', from: { node: 'http', port: 'main', index: 0 }, to: { node: 'later', port: 'main', index: 0 } });
    el.ports = { ...el.ports, fetch: async () => new Response('failed response', { status: 503 }) };
    el.workflow = w;
    await el.run({ runId: 'failed' }).done;
    const handle = el.run({ runId: 'stopped' });
    handle.cancel(); await handle.done;
    el.setAttribute('readonly', '');
  });
  await page.setViewportSize({ width: 360, height: 800 });
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '実行履歴' }).press('Enter');
  await dialog.getByRole('listitem').filter({ hasText: 'failed' }).getByRole('button', { name: 'リプレイ' }).press('Enter');
  const replay = dialog.getByRole('region', { name: '実行リプレイ' });
  await expect(replay.getByText('未実行 · Later')).toBeVisible();
  await replay.getByRole('button', { name: '次のタスク' }).press('Enter');
  await expect(replay.locator('[aria-live]')).toContainText('503');
  await expect(replay.getByRole('button', { name: 'エディタへコピー' })).toHaveCount(0);
  await dialog.getByRole('listitem').filter({ hasText: 'stopped' }).getByRole('button', { name: 'リプレイ' }).click();
  await expect(replay.getByText('記録されたタスクはありません')).toBeVisible();
  await expect(replay.getByText(/未実行.*HTTP.*Later/)).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('authors Manual → Set → If from an empty demo, completes a field, and replays and saves its copy', async ({ page }) => {
  await page.goto('/?example=workspace');
  await expect(page.getByRole('heading', { name: '作業用キャンバス' })).toBeVisible();
  await setEnglish(page);
  const doc = () => page.evaluate(() => document.querySelector('draflow-editor')!.workflow!);
  expect((await doc()).nodes).toHaveLength(0);
  const dialog = page.getByRole('dialog');
  async function command(name: string) {
    await page.getByRole('button', { name: 'Command palette' }).click();
    await dialog.getByRole('option', { name, exact: true }).click();
  }
  await command('Add node');
  await dialog.getByRole('button', { name: 'Manual Trigger' }).click();
  for (const name of ['Edit Fields (Set)', 'If']) {
    await page.locator('.node-card[aria-pressed=true] .output').first().click();
    await dialog.getByRole('button', { name, exact: true }).click();
  }
  await command('Tidy Up');
  await command('Fit view');
  const cards = page.locator('.canvas .node-card');
  await cards.nth(0).click(); await cards.nth(1).click({ modifiers: ['Shift'] });
  await command('Group nodes');
  await dialog.getByLabel('Group name').fill('Input');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await command('Add sticky note');
  await dialog.getByLabel('Note text').fill('Route positive values');
  await dialog.getByRole('button', { name: 'Save' }).click();
  async function run(id: string) {
    return page.evaluate(async runId => {
      const el = document.querySelector('draflow-editor')!, w = el.workflow!;
      const result = await el.run({ runId, triggerData: { main: [[{ json: { amount: 7 } }, { json: { amount: 0 } }]] } }).done;
      return result.runData[w.nodes.find(n => n.type === 'draflow.if')!.id]?.[0]?.output?.main?.map(slot => slot?.map(item => item.json));
    }, id);
  }
  await run('preview');
  // Focus through the host API so that a nearby note cannot intercept the edit.
  async function openNode(type: string) {
    await page.evaluate(type => {
      const el = document.querySelector('draflow-editor')!;
      el.focusNode(el.workflow!.nodes.find(n => n.type === type)!.id);
    }, type);
    await page.keyboard.press('Enter');
  }
  await openNode('draflow.set');
  await dialog.getByRole('button', { name: 'Add row' }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('value');
  const value = dialog.getByLabel('Value', { exact: true });
  await value.fill('={{ $json.am');
  await dialog.getByRole('option', { name: 'amount', exact: true }).click();
  await value.pressSequentially(' }}');
  await expect(dialog.locator('small[data-type=number]')).toHaveText('7');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await openNode('draflow.if');
  await dialog.getByRole('button', { name: 'Add row' }).click();
  await dialog.getByLabel('Left', { exact: true }).fill('={{ $json.value }}');
  await dialog.getByLabel('Operator', { exact: true }).selectOption('isTrue');
  await dialog.getByLabel('Left', { exact: true }).fill('={{ $json.value > 0 }}');
  await dialog.getByRole('button', { name: 'Close' }).click();
  const expected = await run('branch-check');
  expect(expected?.map(items => items?.map(i => i.value))).toEqual([[7], [0]]);
  const original = await doc();
  await page.getByRole('button', { name: 'Execution history' }).click();
  await dialog.getByRole('listitem').filter({ hasText: 'branch-check' }).getByRole('button', { name: 'Replay' }).click();
  await dialog.getByRole('button', { name: 'Copy to editor' }).click();
  const copy = await doc();
  expect(copy.id).not.toBe(original.id);
  expect({ ...copy, id: original.id }).toEqual(original);
  expect(await run('copy-check')).toEqual(expected);
  await page.reload();
  await expect(page.getByRole('heading', { name: original.name })).toBeVisible();
  expect(await doc()).toEqual(copy);
  expect(await run('reloaded-check')).toEqual(expected);
  await page.getByRole('button', { name: '元の文書に戻る' }).click();
  expect(await doc()).toEqual(original);
});

test('follows recorded run indices and ports when a node runs repeatedly', async ({ page }) => {
  await openEnglishDemo(page);
  await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!;
    el.nodeTypes = el.nodeTypes.map(t => t.type === 'draflow.set' ? { ...t,
      ports: { ...t.ports, outputs: [{ type: 'main' }, { type: 'main' }] },
      execute(ctx) { return { main: [ctx.runIndex < 2 ? [{ json: { step: ctx.runIndex + 1 } }] : [], [{ json: { side: ctx.runIndex } }]] }; },
    } : t);
    const w = el.workflow!;
    w.connections.push({ ...w.connections[0]!, id: 'repeat', from: { node: 'set', port: 'main', index: 0 } });
    el.workflow = w;
    await el.run().done;
  });
  await page.getByRole('button', { name: 'Execution history' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Replay', exact: true }).click();
  const replay = dialog.getByRole('region', { name: 'Execution replay' });
  const next = replay.getByRole('button', { name: 'Next task' });
  await next.click(); await next.click();
  await expect(replay.locator('[aria-live]')).toContainText('Set · Run 1');
  await replay.getByLabel('Output port').selectOption({ label: 'main[1] · 1' });
  await expect(replay.locator('mark').last()).toContainText('"side": 1');
});
