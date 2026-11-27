import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-node-id=manual]')).toBeVisible();
  await page.locator('draflow-editor').evaluate(e => e.setAttribute('locale', 'en'));
});

test('reconnect keeps a failed save retryable until storage acknowledges the edit', async ({ page }) => {
  const editor = page.locator('draflow-editor');
  await editor.evaluate(e => {
    e.ports = { storage: {
      async load() { return null; },
      async save(w) {
        if (!e.dataset.online) throw Error('offline');
        e.dataset.savedY = String(w.nodes[0].position.y);
      },
    } };
  });
  await page.locator('[data-node-id=manual]').click();
  await page.keyboard.press('ArrowDown');
  const retry = page.getByRole('button', { name: 'Retry save' });
  await expect(retry).toBeVisible();
  await editor.evaluate(e => { e.remove(); document.body.append(e); });
  await expect(retry).toBeVisible();
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
  await editor.evaluate(e => { e.dataset.online = '1'; });
  await retry.click();
  await expect(editor).toHaveAttribute('data-saved-y', '16');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
});

async function mapManual(editor) {
  await editor.evaluate(e => {
    const w = e.workflow;
    w.nodes[1].parameters.assignments = [{ name: 'origin', value: '={{ $("Manual").item.json.amount }}' }];
    w.pinData = { manual: [{ json: { amount: 1 } }] };
    e.workflow = w;
  });
}

test('duplicating two connected nodes maps and executes against the duplicate ancestor', async ({ page }) => {
  const editor = page.locator('draflow-editor');
  await mapManual(editor);
  await page.locator('[data-node-id=manual]').click();
  await page.locator('[data-node-id=set]').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+d');
  const values = await editor.evaluate(async e => {
    const w = e.workflow;
    const copy = w.nodes.find(n => n.name === 'Manual 2');
    const sink = w.nodes.find(n => n.name === 'Set 2');
    w.pinData[copy.id][0].json.amount = 2;
    e.workflow = w;
    const result = await e.run().done;
    return [result.runData.set[0], result.runData[sink.id][0]].map(t => t.output.main[0][0].json.origin);
  });
  expect(values).toEqual([1, 2]);
});

test('processing returned pinned data leaves the document and the next run intact', async ({ page }) => {
  const editor = page.locator('draflow-editor');
  await mapManual(editor);
  const values = await editor.evaluate(async e => {
    let changes = 0;
    e.addEventListener('draflow-change', () => changes++);
    const first = await e.run().done;
    first.runData.manual[0].output.main[0][0].json.amount = 77;
    const partial = await e.runNode('set').done;
    const next = await e.run().done;
    return [e.workflow.pinData.manual[0].json.amount, partial.runData.set[0].output.main[0][0].json.origin,
      next.runData.set[0].output.main[0][0].json.origin, changes];
  });
  expect(values).toEqual([1, 1, 1, 0]);
});

test('rename validates, updates references in one undo step, saves and respects readonly', async ({ page }) => {
  const editor = page.locator('draflow-editor');
  await mapManual(editor);
  const card = page.locator('[data-node-id=manual]');
  await card.focus();
  await page.keyboard.press('Enter');
  const rename = page.getByRole('button', { name: 'Rename node' });
  await rename.click();
  const name = page.getByLabel('Node name', { exact: true });
  await name.fill('Set');
  await name.press('Enter');
  await expect(name).toBeFocused();
  expect(await name.evaluate(input => input.validity.customError)).toBe(true);
  await name.fill('   ');
  await name.press('Enter');
  expect(await name.evaluate(input => input.validity.customError)).toBe(true);
  await name.press('Escape');
  await expect(rename).toBeFocused();
  await rename.click();
  const renamed = 'Incoming "orders"';
  await name.fill(renamed);
  await name.press('Enter');
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const original = await editor.evaluate(e => {
    e.undo();
    return [e.workflow.nodes[0].name, e.workflow.nodes[1].parameters.assignments[0].value];
  });
  expect(original).toEqual(['Manual', '={{ $("Manual").item.json.amount }}']);
  await editor.evaluate(e => e.redo());
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(card).toContainText(renamed);
  expect(await editor.evaluate(async e => (await e.runNode('set').done).runData.set[0].output.main[0][0].json.origin)).toBe(1);
  await editor.evaluate(e => { e.setAttribute('locale', 'en'); e.setAttribute('readonly', ''); });
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(rename).toBeDisabled();
});
