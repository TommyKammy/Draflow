import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../../server/dist/host.js';
import { createWebhookServer } from '../../server/dist/webhook.js';
import { until } from '../../server/test/fixture.mjs';

const doc = JSON.parse(readFileSync(new URL('../../../examples/order-sync.json', import.meta.url)));
const origin = 'https://orders.example.test';
const signingKey = 'order-sync-test-key';

test('published order sync sends once per webhook delivery or scheduled instant across restart and replay', async ({ page }, info) => {
  const lines = [
    { id: 'a', amount: 12.5, approved: true },
    { id: 'b', amount: 100, approved: false },
    { id: 'c', amount: 7, approved: true },
  ];
  let orders = lines;
  const attempts = [];
  const sent = [];
  const db = info.outputPath('orders.db');
  let now = Date.UTC(2024, 0, 1);
  let tick;
  let host, webhooks;
  async function start() {
    host = new NodeHost(db, {
      registry: new NodeRegistry().registerAll(standardNodes),
      scheduleClock: {
        now: () => now,
        arm(callback) { tick = callback; return () => { tick = undefined; }; },
      },
      httpAuth: {
        grants: ['read', 'send'].map(nodeId => ({
          id: 'orders-' + nodeId, workflowId: doc.id, nodeId, origin, kind: 'bearer',
        })),
        resolve: id => 'test-token-' + id,
      },
      fetch: async (url, init) => {
        attempts.push([init.method, url]);
        const token = new Headers(init.headers).get('authorization');
        if (url === origin + '/orders' && init.method === 'GET' && token === 'Bearer test-token-orders-read') {
          return Response.json(orders);
        }
        if (url === origin + '/totals' && init.method === 'POST' && token === 'Bearer test-token-orders-send') {
          sent.push(JSON.parse(init.body));
          return Response.json({ received: true });
        }
        return new Response(null, { status: 403 });
      },
    });
    webhooks = createWebhookServer(host, { signingKey });
    webhooks.listen(0, '127.0.0.1');
    await once(webhooks, 'listening');
  }
  async function stop() {
    const closed = once(webhooks, 'close');
    webhooks.close();
    webhooks.closeAllConnections();
    await closed;
    await host.close();
  }
  async function deliver(id) {
    const path = '/webhook/orders';
    const body = '{}';
    const signature = createHmac('sha256', signingKey).update([path, id, body].join('\n')).digest('hex');
    const res = await fetch('http://127.0.0.1:' + webhooks.address().port + path, {
      method: 'POST', body, headers: { 'x-draflow-signature': 'sha256=' + signature, 'x-draflow-delivery': id },
    });
    expect(res.status).toBe(202);
    return (await res.json()).runId;
  }

  await start();
  try {
    const revision = host.publish(doc);
    host.activate(doc.id, revision);
    const hookId = await deliver('initial');
    await until(() => host.receipt(hookId).state === 'finished');
    expect(await deliver('initial')).toBe(hookId);
    now += 60_000;
    tick();
    const timerId = host.byEvent(doc.id, 'timer', new Date(now).toISOString()).runId;
    expect(timerId).not.toBe(hookId);
    await until(() => host.receipt(timerId).state === 'finished');
    const payload = { items: [{ data: lines[0] }, { data: lines[2] }], count: 2, total: 19.5 };
    expect(sent).toEqual([payload, payload]);
    await stop();
    await start();
    tick(); // Recheck the same scheduled instant on the restored host.
    expect(await deliver('initial')).toBe(hookId);
    expect(host.byEvent(doc.id, 'timer', new Date(now).toISOString()).runId).toBe(timerId);
    const history = await host.history.list(doc.id);
    expect(history).toHaveLength(2);
    for (const [runId, trigger] of [[hookId, 'hook'], [timerId, 'timer']]) {
      expect(host.receipt(runId).revision).toBe(revision);
      expect(history.find(row => row.id === runId)?.status).toBe('success');
      const detail = await host.history.get(doc.id, runId);
      expect(detail.tasks.map(task => task.nodeId)).toEqual([trigger, 'read', 'split', 'keep', 'aggregate', 'send']);
    }

    const detail = await host.history.get(doc.id, hookId);
    const summary = history.find(row => row.id === hookId);
    await page.goto('/');
    await page.locator('draflow-editor').evaluate(async (editor, { summary, detail }) => {
      editor.dataset.replayRuns = '0';
      editor.addEventListener('draflow-run-start', () => {
        editor.dataset.replayRuns = String(Number(editor.dataset.replayRuns) + 1);
      });
      editor.setAttribute('locale', 'en');
      editor.workflow = detail.workflow;
      await editor.ports.executions.append(summary, detail);
    }, { summary, detail });
    await page.getByRole('button', { name: 'Execution history' }).click();
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    const replay = page.getByRole('region', { name: 'Execution replay' });
    await expect(replay.getByRole('heading').first()).toContainText(hookId);
    for (let i = 1; i < detail.tasks.length; i++) {
      await replay.getByRole('button', { name: 'Next task' }).click();
    }
    await expect(replay.getByText(/6 \/ 6 · Send totals/i)).toBeVisible();
    await expect(page.locator('draflow-editor')).toHaveAttribute('data-replay-runs', '0');
    const read = ['GET', origin + '/orders'];
    const send = ['POST', origin + '/totals'];
    expect(attempts).toEqual([read, send, read, send]);
    expect(sent).toEqual([payload, payload]);

    orders = [];
    const emptyId = await deliver('empty');
    await until(() => host.receipt(emptyId).state === 'finished');
    expect((await host.history.list(doc.id)).find(row => row.id === emptyId).status).toBe('success');
    expect(attempts).toEqual([read, send, read, send, read]);
    expect(sent).toHaveLength(2);
  } finally {
    await stop();
  }
});
