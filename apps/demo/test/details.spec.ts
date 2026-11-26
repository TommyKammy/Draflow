import { expect, test } from '@playwright/test';
import type {} from '@draflow/element/define';

test('authors Set and If, reloads, then executes the edited branch and its undo', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
  await page.evaluate(() => {
    const editor = document.querySelector('draflow-editor')!;
    editor.workflow = { ...editor.workflow!, nodes: [], connections: [] };
  });
  const dialog = page.getByRole('dialog');
  const selected = page.locator('.node-card[aria-pressed=true]');
  await page.getByRole('button', { name: 'ノードを追加' }).click();
  await dialog.getByRole('button', { name: 'Manual Trigger' }).click();
  await selected.locator('.output').click();
  await dialog.getByRole('button', { name: 'Edit Fields (Set)' }).click();
  const set = page.locator('.node-card').filter({ hasText: 'Edit Fields (Set)' });
  const branch = page.locator('.node-card').filter({ hasText: 'If' });
  const close = dialog.getByRole('button', { name: 'Close' });
  const step = dialog.getByRole('button', { name: 'Execute step' });
  await set.dblclick();
  await dialog.getByRole('button', { name: 'Add row' }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('color');
  await dialog.getByLabel('Value', { exact: true }).fill('green');
  await close.click();
  await set.locator('.output').click();
  await dialog.getByRole('button', { name: 'If', exact: true }).click();
  await branch.dblclick();
  await dialog.getByRole('button', { name: 'Add row' }).click();
  await dialog.getByLabel('Left', { exact: true }).fill('={{ $json.color }}');
  await dialog.getByLabel('Right', { exact: true }).fill('green');
  await close.click();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await page.reload();
  await branch.dblclick();
  const output = dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Output', exact: true }) });
  await step.click();
  await expect(output).toContainText('main[0] · 1');
  await expect(output).toContainText('main[1] · 0');
  await expect(dialog.locator('form small').filter({ hasText: '"green"' })).toBeVisible();
  await close.click();
  await set.dblclick();
  await dialog.getByLabel('Value', { exact: true }).fill('blue');
  await close.click();
  await branch.dblclick();
  await step.click();
  await expect(output).toContainText('main[1] · 1');
  await expect(output).toContainText('"blue"');
  await close.click();
  await page.getByRole('button', { name: '元に戻す' }).click();
  await branch.dblclick();
  await step.click();
  await expect(output).toContainText('main[0] · 1');
  await expect(output).toContainText('"green"');
});

test('validates JSON and settings, preserves hidden values and supports readonly inspection', async ({ page }) => {
  await page.goto('/');
  const set = page.locator('[data-node-id="set"]');
  await set.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Mode', { exact: true }).selectOption('json');
  const json = dialog.getByLabel('JSON', { exact: true });
  await json.fill('{');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(json).toBeFocused();
  await json.fill('{"amount":7}');
  await dialog.getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog.getByLabel('Retry on Fail').check();
  await dialog.getByLabel('Max Tries').fill('9');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog.getByLabel('Max Tries')).toBeFocused();
  await dialog.getByLabel('Max Tries').fill('4');
  await dialog.getByLabel('Notes', { exact: true }).fill('reviewed');
  await dialog.getByLabel('Show notes on canvas').check();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(set).toContainText('reviewed');
  const node = await page.evaluate(() => document.querySelector('draflow-editor')!.workflow!.nodes[1]!);
  expect(node.parameters).toMatchObject({ mode: 'json', jsonOutput: { amount: 7 }, assignments: [{ name: 'message' }] });
  expect(node.settings).toMatchObject({ retryOnFail: true, maxTries: 4 });
  await page.locator('draflow-editor').evaluate(el => el.setAttribute('readonly', ''));
  await set.dblclick();
  await expect(dialog.getByRole('button', { name: 'Execute step' })).toBeDisabled();
  await expect(dialog.getByLabel('Mode', { exact: true })).toBeDisabled();
});

test('runNode reuses clean upstream tasks, including after a move and its undo', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-node-id="set"]')).toBeVisible();
  const counts = await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!;
    let manual = 0;
    el.nodeTypes = el.nodeTypes.map(t => t.type === 'draflow.manualTrigger'
      ? { ...t, execute() { manual++; return [{ json: { count: manual } }]; } } : t);
    await el.runNode('set').done;
    await el.runNode('set').done;
    return manual;
  });
  expect(counts).toBe(1);
  await page.locator('[data-node-id="manual"]').click();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: '元に戻す' }).click();
  const output = await page.evaluate(async () => {
    const el = document.querySelector('draflow-editor')!;
    return (await el.runNode('set').done).runData.manual?.[0]?.output?.main?.[0]?.[0]?.json;
  });
  expect(output).toEqual({ count: 1 });
});

test('changes Merge mode without losing a hidden key and validates HTTP parameters', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-node-id="set"]')).toBeVisible();
  const dialog = page.getByRole('dialog');
  for (const name of ['Merge', 'HTTP Request']) {
    await page.getByRole('button', { name: 'ノードを追加' }).click();
    await dialog.getByRole('button', { name, exact: true }).click();
    await page.locator('.node-card[aria-pressed=true]').dblclick();
    if (name === 'Merge') {
      await dialog.getByLabel('Mode', { exact: true }).selectOption('mergeByKey');
      await dialog.getByRole('textbox', { name: 'Key Field', exact: true }).fill('customer');
      await dialog.getByLabel('Mode', { exact: true }).selectOption('chooseBranch');
      await expect(dialog.getByRole('textbox', { name: 'Key Field', exact: true })).toHaveCount(0);
      await dialog.getByLabel('Branch', { exact: true }).selectOption('input2');
      await dialog.getByLabel('Mode', { exact: true }).selectOption('mergeByKey');
      await expect(dialog.getByRole('textbox', { name: 'Key Field', exact: true })).toHaveValue('customer');
    } else {
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog.getByLabel('URL', { exact: true })).toBeFocused();
      await dialog.getByLabel('URL', { exact: true }).fill('https://example.invalid/items');
      const timeout = dialog.getByRole('spinbutton', { name: 'Timeout (ms)' });
      await timeout.fill('0');
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(timeout).toBeFocused();
      await timeout.fill('250');
    }
    await dialog.getByRole('button', { name: 'Close' }).click();
  }
});

test('inspects a step on a narrow screen and groups typing into one undo', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 750 });
  await page.goto('/');
  const card = page.locator('[data-node-id="set"]');
  await card.dblclick();
  const dialog = page.getByRole('dialog');
  const value = dialog.getByLabel('Value', { exact: true });
  await value.fill('');
  await value.pressSequentially('updated');
  await dialog.getByRole('button', { name: 'Execute step' }).click();
  await dialog.getByRole('button', { name: 'Output', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Output', exact: true })).toBeVisible();
  await expect(dialog.locator('pre:visible')).toContainText('updated');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: '元に戻す' }).click();
  await card.dblclick();
  await expect(value).toHaveValue('Hello Draflow');
  await dialog.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.locator('.node-card')).toHaveCount(3);
  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page.locator('.node-card')).toHaveCount(2);
});

test('keeps unaffected preview inputs across edits and invalidates downstream inputs', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-node-id="set"]')).toBeVisible();
  await page.evaluate(async () => {
    const editor = document.querySelector('draflow-editor')!;
    const workflow = editor.workflow!;
    workflow.nodes.push({ id: 'if', name: 'If', type: 'draflow.if', typeVersion: 1,
      position: { x: 440, y: 0 }, parameters: { conditions: { combinator: 'and',
        conditions: [{ left: '={{ $json.message }}', operator: 'equals', right: 'Hello Draflow' }] } } });
    workflow.connections.push({ id: 'set-if', from: { node: 'set', port: 'main', index: 0 },
      to: { node: 'if', port: 'main', index: 0 } });
    editor.workflow = workflow;
    await editor.run({ triggerData: { main: [[{ json: { amount: 42 } }]] } }).done;
  });
  const dialog = page.getByRole('dialog');
  const branch = page.locator('[data-node-id="if"]');
  const close = dialog.getByRole('button', { name: 'Close' });
  await branch.dblclick();
  await dialog.getByLabel('Right', { exact: true }).fill('changed');
  await close.click();
  await page.locator('[data-node-id="set"]').dblclick();
  const value = dialog.getByLabel('Value', { exact: true });
  await value.fill('={{ $json.amount }}');
  await expect(dialog.locator('form').getByText('42', { exact: true })).toBeVisible({ timeout: 2000 });
  await value.fill('={{ $json.amount + 1 }}');
  await expect(dialog.locator('form').getByText('43', { exact: true })).toBeVisible({ timeout: 2000 });
  await close.click();
  await branch.dblclick();
  await expect(dialog.getByText('No preview input', { exact: true })).toBeVisible();
});

test('preserves the latest fixed value and expression across mode switches', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-node-id="set"]').dblclick();
  const dialog = page.getByRole('dialog');
  const name = 'Include Other Input Fields';
  const fixed = dialog.getByRole('checkbox', { name, exact: true });
  const expression = dialog.getByRole('textbox', { name, exact: true });
  const toExpression = dialog.getByRole('button', { name: name + ' · Expression' });

  await fixed.uncheck();
  await toExpression.click();
  await expect(expression).toHaveValue('={{ false }}');
  const edited = '={{ $json.keep === true }}';
  await expression.fill(edited);
  await dialog.getByRole('button', { name: name + ' · Fixed' }).click();
  await expect(fixed).not.toBeChecked();
  await toExpression.click();
  await expect(expression).toHaveValue(edited);
  const stored = await page.evaluate(() => document.querySelector('draflow-editor')!
    .workflow!.nodes.find(n => n.id === 'set')!.parameters.includeOtherFields);
  expect(stored).toBe(edited);
});

test('keeps invalid HTTP headers when another field requests a redraw', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-node-id="set"]')).toBeVisible();
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'ノードを追加' }).click();
  await dialog.getByRole('button', { name: 'HTTP Request', exact: true }).click();
  await page.locator('.node-card[aria-pressed=true]').dblclick();
  await dialog.getByLabel('URL', { exact: true }).fill('https://example.invalid/items');
  const headers = dialog.getByLabel('Headers', { exact: true });
  const toggle = dialog.getByRole('button', { name: 'Method · Expression' });
  await headers.fill('{');
  await toggle.click();
  await expect(headers).toHaveValue('{');
  await expect(headers).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('button', { name: 'Execute step' }).click();
  await expect(headers).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Discard invalid input' })).toBeVisible();
  await headers.fill('{"Accept":"application/json"}');
  await toggle.click();
  await expect(dialog.getByRole('textbox', { name: 'Method', exact: true })).toHaveValue('={{ "GET" }}');
  await dialog.getByRole('button', { name: 'Close' }).click();
  const params = await page.evaluate(() => document.querySelector('draflow-editor')!.workflow!
    .nodes.find(n => n.type === 'draflow.httpRequest')!.parameters);
  expect(params).toMatchObject({ method: '={{ "GET" }}', headers: { Accept: 'application/json' } });
});

test('updates conditional fields inside collections without reopening the dialog', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('[data-node-id="set"]');
  await expect(card).toBeVisible();
  await page.evaluate(() => {
    const editor = document.querySelector('draflow-editor')!;
    editor.nodeTypes = editor.nodeTypes.map(type => type.type !== 'draflow.set' ? type : {
      ...type, parameters: [{ type: 'collection', name: 'options', label: 'Options', fields: [
        { type: 'select', name: 'mode', label: 'Mode', default: 'basic',
          options: [{ value: 'basic', label: 'Basic' }, { value: 'advanced', label: 'Advanced' }] },
        { type: 'fixedCollection', name: 'rows', label: 'Rows', multiple: true, default: [{}], fields: [
          { type: 'string', name: 'detail', label: 'Advanced detail',
            displayOptions: { show: { '/options.mode': ['advanced'] } } },
        ] },
      ] }],
    });
  });
  await card.dblclick();
  const dialog = page.getByRole('dialog');
  const mode = dialog.getByRole('combobox', { name: 'Mode' });
  const detail = dialog.getByLabel('Advanced detail', { exact: true });
  await expect(detail).toHaveCount(0);
  await mode.selectOption('advanced');
  await expect(detail).toBeVisible();
  await detail.fill('preserved');
  await mode.selectOption('basic');
  await expect(detail).toHaveCount(0);
  await mode.selectOption('advanced');
  await expect(detail).toHaveValue('preserved');
});
