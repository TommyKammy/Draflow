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
      await dialog.getByLabel('Key Field').fill('customer');
      await dialog.getByLabel('Mode', { exact: true }).selectOption('chooseBranch');
      await expect(dialog.getByLabel('Key Field')).toHaveCount(0);
      await dialog.getByLabel('Branch', { exact: true }).selectOption('input2');
      await dialog.getByLabel('Mode', { exact: true }).selectOption('mergeByKey');
      await expect(dialog.getByLabel('Key Field')).toHaveValue('customer');
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
