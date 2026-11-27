import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('CLI reload authorizes only the named live test snapshot and preserves grants on invalid reload', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'draflow-cli-grants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const api = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer test-token') return res.writeHead(401).end();
    reads++;
    res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => new Promise(resolve => api.close(resolve)));
  const origin = 'http://127.0.0.1:' + api.address().port;
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const workflow = JSON.parse(readFileSync(new URL('../../../examples/order-sync.json', import.meta.url)));
  workflow.nodes.find(n => n.id === 'read').parameters.url = origin + '/orders';
  const grant = { workflowId: workflow.id, nodeId: 'read', id: 'orders-read', origin, kind: 'bearer' };
  const config = { grants: [grant], environment: { 'orders-read': 'DRAFLOW_TEST_TOKEN' } };
  const file = join(dir, 'auth.json');
  writeFileSync(file, JSON.stringify(config));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), join(dir, 'db')], {
    env: { ...process.env, DRAFLOW_HTTP_AUTH_FILE: file, DRAFLOW_TEST_TOKEN: 'test-token',
      DRAFLOW_WEBHOOK_SECRET: 'signing-key', DRAFLOW_WEBHOOK_HOST: '127.0.0.1', DRAFLOW_WEBHOOK_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const closed = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await closed; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  async function command(op, args = {}) {
    child.stdin.write(JSON.stringify({ op, ...args }) + '\n');
    return JSON.parse((await lines.next()).value);
  }
  async function listen() {
    const response = await command('listenTest', { workflow, triggerNodeId: 'hook' });
    assert.equal(response.ok, true);
    return response.result;
  }
  async function deliver(path) {
    const sig = createHmac('sha256', 'signing-key').update(path + '\n\n{}').digest('hex');
    const response = await fetch('http://127.0.0.1:' + port + path, {
      method: 'POST', body: '{}', headers: { 'x-draflow-signature': 'sha256=' + sig },
    });
    assert.equal(response.status, 202);
    const { runId } = await response.json();
    for (let i = 0; i < 500; i++) {
      const { result } = await command('receipt', { runId });
      if (result.state === 'finished') return result.outcome;
      await delay(10);
    }
    assert.fail('Timed out waiting for test webhook');
  }
  const session = await listen();
  const other = await listen();
  assert.equal(await deliver(session.path), 'error');
  assert.equal(reads, 0);
  config.grants.push({ ...grant, workflowId: session.workflowId });
  writeFileSync(file, JSON.stringify(config));
  assert.equal((await command('reloadHttpAuth')).ok, true);
  assert.equal(await deliver(session.path), 'success');
  assert.equal(await deliver(other.path), 'error');
  writeFileSync(file, '{');
  assert.equal((await command('reloadHttpAuth')).ok, false);
  assert.equal(await deliver(session.path), 'success');
  config.grants.pop();
  writeFileSync(file, JSON.stringify(config));
  assert.equal((await command('reloadHttpAuth')).ok, true);
  assert.equal(await deliver(session.path), 'error');
  assert.equal(reads, 2);
});
