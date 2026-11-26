// Trusted local JSON-lines interface. Each input receives one JSON response.
import { createInterface } from 'node:readline';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from './host.js';

const path = process.argv[2];
if (!path) throw new Error('Usage: node dist/cli.js DATABASE');
const host = new NodeHost(path, {
  registry: new NodeRegistry().registerAll(standardNodes),
  onWorkerError(error) {
    console.error(error);
    void stop(1);
  },
});
const input = createInterface({ input: process.stdin });
async function stop(code: number) {
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
        case 'accept':
          result = host.accept(q.workflowId, q.triggerNodeId, q.event);
          break;
        case 'receipt':
          result = host.receipt(q.runId);
          break;
        case 'byEvent':
          result = host.byEvent(q.workflowId, q.triggerNodeId, q.key);
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
  try {
    await host.close();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
