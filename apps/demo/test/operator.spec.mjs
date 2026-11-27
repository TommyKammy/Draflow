import { test, expect } from '@playwright/test';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../../server/dist/host.js';
import { createOperatorServer } from '../../server/dist/operator-http.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('operators reconcile the same delivery in two tabs; a viewer can inspect the outcome', async ({
  context,
}) => {
  const grants = ['operator', 'operator', 'viewer'].map((role, i) => ({
    organization: 'orders',
    role,
    actor: 'person' + i,
    token: randomUUID(),
    grants: role === 'operator' ? ['reconcile'] : [],
  }));
  let sends = 0;
  const h = new NodeHost(':memory:', {
    organization: 'orders',
    registry: new NodeRegistry().registerAll(standardNodes),
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
      await p.getByLabel('組織 ID').fill('orders');
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
    await expect(viewer.getByRole('button', { name: '配送結果を照合' })).toHaveCount(0);
    await second.getByRole('combobox', { name: '受信先の確認結果' }).selectOption('notApplied');
    await first.getByRole('button', { name: '配送結果を照合' }).press('Enter');
    await expect(first.getByRole('status')).toContainText('操作を記録');
    await second.getByRole('button', { name: '配送結果を照合' }).press('Enter');
    await expect(second.getByRole('status')).toContainText('最新の状態');
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
