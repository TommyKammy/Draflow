import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { NodeHost } from '../../server/dist/host.js';
import { until } from '../../server/test/fixture.mjs';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';

test('server-authenticated results can enter the editor but credentials and authenticated requests cannot', async ({
  page,
}, info) => {
  const secret = randomUUID();
  const origin = 'https://orders.example.test';
  const doc = {
    schema: 'draflow/v1',
    id: 'orders',
    name: 'Orders',
    settings: {},
    nodes: [
      {
        id: 'start',
        name: 'Start',
        type: 'draflow.manualTrigger',
        typeVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      },
      {
        id: 'api',
        name: 'API',
        type: 'draflow.httpRequest',
        typeVersion: 2,
        position: { x: 200, y: 0 },
        parameters: { url: origin, authentication: 'credential' },
        credentials: { httpAuth: 'orders-read' },
      },
    ],
    connections: [
      {
        id: 'link',
        from: { node: 'start', port: 'main', index: 0 },
        to: { node: 'api', port: 'main', index: 0 },
      },
    ],
  };
  let requests = 0;
  const host = new NodeHost(info.outputPath('http.db'), {
    registry: new NodeRegistry().registerAll(standardNodes),
    httpAuth: {
      grants: [{ id: 'orders-read', workflowId: doc.id, nodeId: 'api', origin, kind: 'bearer' }],
      resolve: () => secret,
    },
    fetch: async (_, init) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + secret);
      return ++requests === 1 ? Response.json({ orders: 3 }) : new Response(secret, { status: 403 });
    },
  });
  try {
    host.activate(doc.id, host.publish(doc));
    await page.goto('/?example=mock-http');
    const editor = page.locator('draflow-editor');
    await expect(page.locator('[data-node-id=http]')).toBeVisible();
    for (const status of ['success', 'error']) {
      const id = host.accept(doc.id, 'start', { items: [{ json: {} }] });
      await until(() => host.receipt(id).state === 'finished');
      const summary = (await host.history.list(doc.id)).find((row) => row.id === id);
      const detail = await host.history.get(doc.id, id);
      expect(summary.status).toBe(status);
      expect(JSON.stringify({ summary, detail })).not.toContain(secret);
      await editor.evaluate(
        async (el, record) => {
          el.workflow = record.detail.workflow;
          await el.ports.executions.append(record.summary, record.detail);
        },
        { summary, detail },
      );
    }
    const browser = await editor.evaluate(async (el) => {
      let calls = 0;
      el.ports = {
        ...el.ports,
        fetch: async () => {
          calls++;
          return new Response('{}');
        },
      };
      const result = await el.run().done;
      const records = await el.ports.executions.list(el.workflow.id);
      return {
        calls,
        result,
        workflow: el.workflow,
        details: await Promise.all(records.map((row) => el.ports.executions.get(el.workflow.id, row.id))),
      };
    });
    expect(browser.calls).toBe(0);
    expect(browser.result.status).toBe('error');
    expect(browser.workflow.nodes[1].credentials.httpAuth).toBe('orders-read');
    expect(JSON.stringify(browser)).not.toContain(secret);
  } finally {
    await host.close();
  }
});
