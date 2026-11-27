// Trusted local JSON-lines interface. Each input receives one JSON response.
import { createInterface } from 'node:readline';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { loadHttpAuth } from './http-config.js';
import { createWebhookServer } from './webhook.js';
import { NodeHost } from './host.js';

const path = process.argv[2];
if (!path) throw new Error('Usage: node dist/cli.js DATABASE');
const authPath = process.env.DRAFLOW_HTTP_AUTH_FILE;
const httpAuth = authPath ? loadHttpAuth(authPath) : undefined;
const host = new NodeHost(path, {
  ...(httpAuth && { httpAuth }),
  ...(process.env.DRAFLOW_HTTP_MAX_RESPONSE_BYTES !== undefined &&
    { maxHttpResponseBytes: Number(process.env.DRAFLOW_HTTP_MAX_RESPONSE_BYTES) }),
  registry: new NodeRegistry().registerAll(standardNodes),
  onWorkerError(error) {
    console.error(error);
    void stop(1);
  },
});
const webhookPort = process.env.DRAFLOW_WEBHOOK_PORT;
const webhooks = webhookPort === undefined ? undefined : createWebhookServer(host, {
  signingKey: process.env.DRAFLOW_WEBHOOK_SECRET ?? '',
  ...(process.env.DRAFLOW_WEBHOOK_MAX_BODY_BYTES !== undefined &&
    { maxBodyBytes: Number(process.env.DRAFLOW_WEBHOOK_MAX_BODY_BYTES) }),
});
if (webhooks) {
  webhooks.listen(Number(webhookPort), process.env.DRAFLOW_WEBHOOK_HOST ?? '127.0.0.1');
}
const input = createInterface({ input: process.stdin });
async function stop(code: number) {
  webhooks?.close();
  input.close();
  try {
    await host.close();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
  process.exit(code);
}
process.once('SIGTERM', () => void stop(0));
process.once('SIGINT', () => void stop(0));
try {
  for await (const line of input) {
    try {
      const q = JSON.parse(line);
      let result: unknown;
      switch (q.op) {
        case 'publish':
          result = host.publish(q.workflow);
          break;
        case 'activate':
          host.activate(q.workflowId, q.revision);
          break;
        case 'deactivate':
          host.deactivate(q.workflowId);
          break;
        case 'reloadHttpAuth':
          if (!authPath || !httpAuth) throw new Error('DRAFLOW_HTTP_AUTH_FILE is not configured');
          Object.assign(httpAuth, loadHttpAuth(authPath));
          break;
        case 'listenTest':
          result = host.listenTest(q.workflow, q.triggerNodeId, q.ttlMs);
          break;
        case 'accept':
          result = host.accept(q.workflowId, q.triggerNodeId, q.event);
          break;
        case 'cancel':
          result = host.cancel(q.runId);
          break;
        case 'progress':
          result = host.inspect(q.runId);
          break;
        case 'relations':
          result = host.relations(q.runId);
          break;
        case 'effects':
          result = host.effects(q.runId);
          break;
        case 'reconcile':
          result = host.reconcile(q.runId, q.key, q.decision, q.result);
          break;
        case 'waitInfo':
          result = host.waitInfo(q.runId);
          break;
        case 'transitions':
          result = host.transitions(q.runId);
          break;
        case 'resume':
        case 'cancelWait':
          result = host.resolveWait(q.runId, q.token, q.op === 'resume' ? 'event' : 'canceled', q.data);
          break;
        case 'receipt':
          result = host.receipt(q.runId);
          break;
        case 'byEvent':
          result = host.byEvent(q.workflowId, q.triggerNodeId, q.key, q.source);
          break;
        case 'stats':
          result = host.stats();
          break;
        case 'history':
          result = await host.history.list(q.workflowId);
          break;
        case 'detail':
          result = await host.history.get(q.workflowId, q.runId);
          break;
        default:
          throw new Error('Unknown operation');
      }
      console.log(JSON.stringify({ ok: true, result: result ?? null }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: String(error) }));
    }
  }
} finally {
  webhooks?.close();
  try {
    await host.close();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
