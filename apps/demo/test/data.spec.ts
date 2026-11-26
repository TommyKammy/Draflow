import { test, expect, type Page } from '@playwright/test';
import type {} from '@draflow/element/define';

async function openFiltered(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-node-id="set"]')).toBeVisible();
  await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!;
    const w = el.workflow!;
    const [source, set] = w.nodes;
    source!.name = 'Source';
    const filter = { ...set!, id: 'filter', type: 'draflow.filter', name: 'Filter',
      parameters: { conditions: { combinator: 'and', conditions: [{ left: '={{ $json.keep }}', operator: 'isTrue' }] } } };
    const mask = { ...set!, id: 'mask', name: 'Mask', parameters: {
      includeOtherFields: false, assignments: [{ name: 'label', value: '={{ $json.label }}' }],
    } };
    set!.parameters = { assignments: [{ name: 'mapped', value: '' }] };
    w.nodes = [source!, filter, mask, set!];
    w.nodes.forEach((node, i) => { node.position = { x: i * 230, y: 0 }; });
    w.connections = ['manual', 'filter', 'mask'].map((node, i) => ({ id: 'c' + i,
      from: { node, port: 'main', index: 0 }, to: { node: w.nodes[i + 1]!.id, port: 'main', index: 0 } }));
    el.workflow = w;
    const result = await el.run({ triggerData: { main: [[
      { json: { label: 'discarded', amount: 900, keep: false } },
      { json: { label: 'first', amount: 17, keep: true } },
      { json: { label: 'second', amount: 42, keep: true } },
    ]] } }).done;
    if (result.status !== 'success') throw Error(result.error?.message);
  });
  await page.locator('[data-node-id="set"]').dblclick();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('spinbutton', { name: 'Input item' }).fill('2');
  await dialog.getByRole('spinbutton', { name: 'Input item' }).press('Enter');
  await dialog.getByRole('combobox', { name: 'Map from' }).selectOption('Source');
  return dialog;
}

test('maps the second filtered item back to its numeric ancestor by keyboard and drag', async ({ page }) => {
  const dialog = await openFiltered(page);
  const amount = dialog.getByRole('button', { name: 'amount', exact: true });
  const value = dialog.getByRole('textbox', { name: 'Value', exact: true });
  const expression = "={{ $('Source').item.json.amount }}";
  await amount.focus(); await page.keyboard.press('Enter');
  const insert = dialog.getByRole('button', { name: 'Insert into Value', exact: true });
  await insert.focus(); await page.keyboard.press('Enter');
  await expect(value).toHaveValue(expression);
  await expect(dialog.locator('small[data-type=number]')).toHaveText('42');
  await value.fill('before drag');
  await amount.dragTo(value);
  await expect(value).toHaveValue(expression);
  await expect(dialog.locator('small[data-type=number]')).toHaveText('42');
  await dialog.getByRole('button', { name: 'Execute step' }).click();
  const output = dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Output', exact: true }) });
  await expect(output.locator('pre')).toContainText('"mapped": 42');
  expect(JSON.parse(await output.locator('pre').innerText())).toEqual([{ label: 'first', mapped: 17 }, { label: 'second', mapped: 42 }]);
});

test.describe('touch mapping', () => {
  test.use({ hasTouch: true, viewport: { width: 420, height: 800 } });
  test('inserts the same ancestor expression by tapping a field and its destination', async ({ page }) => {
    // Open the same workflow on desktop width, then exercise the narrow pane tabs by touch.
    await page.setViewportSize({ width: 1000, height: 800 });
    const dialog = await openFiltered(page);
    await page.setViewportSize({ width: 420, height: 800 });
    await dialog.getByRole('button', { name: 'Input', exact: true }).tap();
    await dialog.getByRole('button', { name: 'amount', exact: true }).tap();
    await dialog.getByRole('button', { name: 'Node', exact: true }).tap();
    await dialog.getByRole('button', { name: 'Insert into Value', exact: true }).tap();
    await expect(dialog.getByLabel('Value', { exact: true })).toHaveValue("={{ $('Source').item.json.amount }}");
    await expect(dialog.locator('small[data-type=number]')).toHaveText('42');
  });
});

test('pins an empty output, unpins, and undoes before executing the step again', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('[data-node-id="set"]');
  await expect(card).toBeVisible();
  await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!;
    const w = el.workflow!;
    w.nodes[1]!.type = 'draflow.filter';
    w.nodes[1]!.parameters = { conditions: { combinator: 'and', conditions: [{ left: '={{ $json.keep }}', operator: 'isFalse' }] } };
    el.workflow = w;
    await el.run({ triggerData: { main: [[{ json: { keep: true } }]] } }).done;
  });
  await card.dblclick();
  const dialog = page.getByRole('dialog');
  const run = () => page.evaluate(async () => {
    const result = await document.querySelector('draflow-editor')!.runNode('set').done;
    return result.runData.set![0]!.output!.main![0]!.length;
  });
  await dialog.getByRole('button', { name: 'Pin output' }).click();
  expect(await page.evaluate(() => document.querySelector('draflow-editor')!.workflow!.pinData!.set)).toEqual([]);
  await dialog.getByRole('combobox', { name: 'Operator', exact: true }).selectOption('isTrue');
  expect(await run()).toBe(0);
  await dialog.getByRole('button', { name: 'Unpin' }).click();
  expect(await run()).toBe(1);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: '元に戻す' }).click();
  expect(await run()).toBe(0);
});

test('pages a union of table columns, searches JSON and reports schema types', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-node-id="set"]')).toBeVisible();
  await page.evaluate(async () => {
    await document.querySelector('draflow-editor')!.run({ triggerData: { main: [Array.from({ length: 101 }, (_, i) =>
      ({ json: i === 100 ? { n: i, extra: 'needle' } : { n: i } }))] } }).done;
  });
  await page.locator('[data-node-id="set"]').dblclick();
  const panel = page.getByRole('dialog').locator('section').filter({ has: page.getByRole('heading', { name: 'Input', exact: true }) });
  const view = panel.getByRole('combobox', { name: 'Input view' });
  await view.selectOption('Table');
  await expect(panel.getByRole('columnheader', { name: 'extra' })).toBeVisible();
  await expect(panel.locator('tbody tr')).toHaveCount(100);
  await panel.getByRole('button', { name: 'Next' }).click();
  await expect(panel.locator('tbody tr')).toHaveCount(1);
  await expect(panel.locator('tbody')).toContainText('needle');
  await view.selectOption('Schema');
  await expect(panel.locator('dl')).toContainText('number');
  await panel.getByRole('searchbox').fill('needle');
  await view.selectOption('JSON');
  expect(JSON.parse(await panel.locator('pre').innerText())).toEqual([{ n: 100, extra: 'needle' }]);
});

test('inspects distinct input and output snapshots for repeated node runs', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('[data-node-id="set"]');
  await expect(card).toBeVisible();
  await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!;
    el.nodeTypes = el.nodeTypes.map(t => t.type === 'draflow.set' ? { ...t,
      execute(ctx) { return ctx.runIndex === 2 ? [] : [{ json: { generation: ctx.runIndex + 1 } }]; },
    } : t);
    const w = el.workflow!;
    w.connections.push({ ...w.connections[0]!, id: 'repeat', from: { node: 'set', port: 'main', index: 0 } });
    el.workflow = w;
    await el.run().done;
  });
  await card.dblclick();
  const dialog = page.getByRole('dialog');
  const runs = dialog.getByRole('combobox', { name: 'Run index' });
  await expect(runs).toHaveValue('2');
  const input = dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Input', exact: true }) });
  await expect(input.locator('pre')).toContainText('"generation": 2');
  await runs.selectOption('1');
  await expect(input.locator('pre')).toContainText('"generation": 1');
  await dialog.getByRole('button', { name: 'Pin output' }).click();
  expect(await page.evaluate(() => document.querySelector('draflow-editor')!.workflow!.pinData!.set![0]!.json))
    .toEqual({ generation: 2 });
});

test('disallows pins on If and on a node with an error output', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('[data-node-id="set"]');
  await expect(card).toBeVisible();
  for (const type of ['draflow.if', 'draflow.set']) {
    await page.evaluate(async type => {
      const el = document.querySelector('draflow-editor')!;
      const w = el.workflow!;
      w.nodes[1]!.type = type;
      if (type === 'draflow.set') w.nodes[1]!.settings = { onError: 'errorOutput' };
      el.workflow = w;
      await el.run().done;
    }, type);
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Pin output' })).toBeDisabled();
    await expect(dialog.getByText('Pinning requires a single main[0] output.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
  }
});

test('maps a selected secondary input port into an executable parameter', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-node-id="set"]')).toBeVisible();
  await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!;
    const setType = el.nodeTypes.find(t => t.type === 'draflow.set')!;
    const multi = { ...setType, type: 'demo.twoInputs', ports: {
      ...setType.ports, inputs: [{ type: 'main', required: true }, { type: 'main', required: true }],
    } };
    el.nodeTypes = [...el.nodeTypes, multi];
    const w = el.workflow!;
    const [source, target] = w.nodes;
    target!.type = multi.type;
    target!.parameters = { assignments: [{ name: 'mapped', value: '' }] };
    const branches = [17, 42].map((n, i) => ({ ...target!, id: 'b' + i, name: 'Branch ' + i, type: setType.type,
      parameters: { assignments: [{ name: 'amount', value: n }] }, position: { x: 230, y: i * 120 } }));
    target!.position.x = 460;
    w.nodes = [source!, ...branches, target!];
    w.connections = branches.flatMap((branch, i) => [
      { id: 'to' + i, from: { node: source!.id, port: 'main', index: 0 }, to: { node: branch.id, port: 'main', index: 0 } },
      { id: 'out' + i, from: { node: branch.id, port: 'main', index: 0 }, to: { node: target!.id, port: 'main', index: i } },
    ]);
    el.workflow = w;
    await el.run().done;
  });
  await page.locator('[data-node-id="set"]').dblclick();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Input port' }).selectOption({ label: 'main[1] · 1' });
  await dialog.getByRole('button', { name: 'amount', exact: true }).click();
  await dialog.getByRole('button', { name: 'Insert into Value', exact: true }).click();
  await expect(dialog.locator('small[data-type=number]')).toHaveText('42');
  await dialog.getByRole('button', { name: 'Execute step' }).click();
  const output = dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Output', exact: true }) });
  await expect(output.locator('pre')).toContainText('"mapped": 42');
  expect(JSON.parse(await output.locator('pre').innerText())).toEqual([{ amount: 17, mapped: 42 }]);
});
