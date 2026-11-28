import { test, expect } from '@playwright/test';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../../server/dist/host.js';
import { createOperatorServer } from '../../server/dist/operator-http.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

function hostOptions(organization) {
  const connectionString = process.env.DRAFLOW_TEST_POSTGRES;
  return {
    organization,
    registry: new NodeRegistry().registerAll(standardNodes),
    ...(connectionString && { shared: { organization, connectionString, pollMs: 50 } }),
  };
}

test('operators reconcile the same delivery in two tabs; a viewer can inspect the outcome', async ({
  context,
}) => {
  const organization = randomUUID();
  const grants = ['operator', 'operator', 'viewer'].map((role, i) => ({
    organization,
    role,
    actor: 'person' + i,
    token: randomUUID(),
    grants: role === 'operator' ? ['reconcile'] : [],
  }));
  let sends = 0;
  const h = new NodeHost(':memory:', {
    ...hostOptions(organization),
    fetch: async () => {
      sends++;
      throw Error('private response');
    },
  });
  const srv = createOperatorServer([h], () =>
    grants.map(({ token, ...p }) => ({ ...p, sha256: createHash('sha256').update(token).digest('hex') })),
  );
  try {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + srv.address().port + '/operator/';
    const flow = JSON.parse(readFileSync(new URL('../../../examples/order-import.json', import.meta.url)));
    flow.nodes[1] = {
      ...flow.nodes[1],
      type: 'draflow.httpRequest',
      typeVersion: 2,
      parameters: { method: 'POST', url: 'https://upstream.test/order', delivery: 'manual' },
    };
    h.activate(flow.id, h.publish(flow));
    const id = h.accept(flow.id, 'schedule', { items: [{ json: { value: 'private order' } }] });
    await expect.poll(() => h.receipt(id).state).toBe('review');
    const pages = [];
    for (const account of grants) {
      const p = await context.newPage();
      pages.push(p);
      if (account.role === 'viewer') {
        await p.route(
          '**/api?op=metrics',
          (route) =>
            route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: '{}',
            }),
          { times: 1 },
        );
      }
      await p.goto(url);
      await p.getByLabel('組織 ID').fill(organization);
      await p.getByLabel('アクセストークン').fill(account.token);
      await p.getByLabel('アクセストークン').press('Enter');
      await p.getByRole('combobox', { name: '状態', exact: true }).selectOption('review');
      await p.getByRole('button', { name: '検索', exact: true }).press('Enter');
      await p.getByRole('link', { name: flow.id, exact: true }).press('Enter');
      await expect(p.getByRole('heading', { name: '実行詳細' })).toBeFocused();
    }
    const [first, second, viewer] = pages;
    await expect(viewer.getByRole('region', { name: '稼働状況' })).toContainText('最終ハートビート');
    await expect(viewer.locator('#monitorError')).toBeHidden();
    await expect(viewer.locator('#record')).toContainText('外部操作の結果が不明');
    await expect(viewer.getByRole('button', { name: '配送結果を照合' })).toHaveCount(0);
    await second.getByRole('combobox', { name: '受信先の確認結果' }).selectOption('notApplied');
    await first.getByRole('button', { name: '配送結果を照合' }).press('Enter');
    await expect(first.getByRole('status')).toContainText('操作を記録');
    await second.getByRole('button', { name: '配送結果を照合' }).press('Enter');
    await expect(second.getByRole('status')).toContainText('最新の状態');
    await expect(second.getByRole('button', { name: '配送結果を照合' })).toHaveCount(0);
    await expect.poll(() => h.receipt(id).outcome).toBe('success');
    await viewer.getByRole('button', { name: '詳細を更新' }).press('Enter');
    await expect(viewer.locator('#record')).toContainText('成功');
    await first.reload();
    expect(sends).toBe(1);
    expect(
      h
        .operate(grants[0], { op: 'audit' })
        .filter((a) => a.action === 'reconcile' && JSON.parse(a.result) === true),
    ).toHaveLength(1);
    await expect(viewer.locator('body')).not.toContainText('private order');
  } finally {
    await new Promise((r) => {
      srv.close(r);
      srv.closeAllConnections();
    });
    await h.close();
  }
});

test('an operator refreshing an expired event wait sees the deadline and can still cancel', async ({ page }) => {
  const organization = randomUUID(), token = randomUUID();
  let now = Date.now();
  const dueAt = now + 60000;
  const h = new NodeHost(':memory:', {
    ...hostOptions(organization),
    scheduleClock: { now: () => now, arm: () => () => {} },
  });
  const srv = createOperatorServer([h], () => [{
    organization, actor: 'oncall', role: 'operator', sha256: createHash('sha256').update(token).digest('hex'),
  }]);
  try {
    const flow = JSON.parse(readFileSync(new URL('../../../examples/order-import.json', import.meta.url)));
    flow.nodes[1] = { ...flow.nodes[1], type: 'draflow.wait', typeVersion: 1, parameters: { mode: 'event', dueAt } };
    h.activate(flow.id, h.publish(flow));
    const id = h.accept(flow.id, 'schedule', { items: [{ json: {} }] });
    await expect.poll(() => h.receipt(id).state).toBe('waiting');
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await page.goto('http://127.0.0.1:' + srv.address().port + '/operator/');
    await page.getByLabel('組織 ID').fill(organization);
    await page.getByLabel('アクセストークン').fill(token);
    await page.getByLabel('アクセストークン').press('Enter');
    await page.getByRole('link', { name: flow.id, exact: true }).press('Enter');
    const resume = page.getByRole('button', { name: '待機を再開' });
    await expect(resume).toBeVisible();
    now = dueAt;
    await resume.press('Enter');
    await expect(page.getByRole('status')).toContainText('最新の状態');
    await expect(resume).toHaveCount(0);
    await expect(page.locator('#record')).toContainText('イベントの受付期限を過ぎました');
    await page.getByRole('button', { name: '取消', exact: true }).press('Enter');
    await expect.poll(() => h.receipt(id).outcome).toBe('canceled');
  } finally {
    srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
    await h.close();
  }
});

test('publisher previews an order draft before publication', async ({ page }) => {
  const organization = randomUUID(), token = randomUUID();
  const h = new NodeHost(':memory:', hostOptions(organization));
  const srv = createOperatorServer([h], () => [{
    organization, actor: 'publisher', role: 'publisher', sha256: createHash('sha256').update(token).digest('hex'),
  }]);
  try {
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    await page.goto('http://127.0.0.1:' + srv.address().port + '/operator/');
    await page.getByLabel('組織 ID').fill(organization);
    await page.getByLabel('アクセストークン').fill(token);
    await page.getByLabel('アクセストークン').press('Enter');
    const previewPanel = page.getByText('公開前の影響を確認', { exact: true });
    await expect(previewPanel).toBeVisible();
    await previewPanel.press('Enter');
    const input = page.getByLabel('フロー定義（JSON）');
    const file = readFileSync(new URL('../../../examples/order-sync.json', import.meta.url));
    await input.setInputFiles({ name: 'orders.json', mimeType: 'application/json', buffer: file });
    await page.getByRole('button', { name: '影響を確認' }).press('Enter');
    const result = page.locator('#previewResult');
    await expect(result).toContainText('Order webhook');
    await expect(result).toContainText('60 秒ごと');
    await expect(result.getByText(/読み取り · GET · https:.*orders · 資格情報 orders-read/)).toHaveCount(2);
    await expect(result.getByText(/書き込み · POST · https:.*totals · 資格情報 orders-send/)).toHaveCount(2);
    await input.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') });
    await expect(result).toBeEmpty();
    await page.getByRole('button', { name: '影響を確認' }).press('Enter');
    await expect(page.getByRole('status')).toContainText('JSON 形式');
    expect(h.publish(JSON.parse(file))).toBe(1);
  } finally {
    srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
    await h.close();
  }
});
