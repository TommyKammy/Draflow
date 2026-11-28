import { readFileSync } from 'node:fs';
import { createOperatorServer } from './operator-http.js';
// Trusted local JSON-lines interface. Each input receives one JSON response.
import { createInterface } from 'node:readline';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { loadHttpAuth } from './http-config.js';
import { createWebhookServer } from './webhook.js';
import { NodeHost } from './host.js';

const path = process.argv[2] ?? (process.env.DRAFLOW_POSTGRES_URL ? ':memory:' : undefined);
if (!path) throw new Error('Usage: node dist/cli.js DATABASE');
const authPath = process.env.DRAFLOW_HTTP_AUTH_FILE;
const httpAuth = authPath ? loadHttpAuth(authPath) : undefined;
const host = new NodeHost(path, {
  ...(process.env.DRAFLOW_MAX_PARALLEL_BATCHES !== undefined && {
    maxParallelBatches: Number(process.env.DRAFLOW_MAX_PARALLEL_BATCHES),
  }),
  ...(process.env.DRAFLOW_ORGANIZATION && { organization: process.env.DRAFLOW_ORGANIZATION }),
  ...(process.env.DRAFLOW_POSTGRES_URL && {
    shared: {
      connectionString: process.env.DRAFLOW_POSTGRES_URL,
      organization: process.env.DRAFLOW_ORGANIZATION ?? '',
      role: (process.env.DRAFLOW_ROLE ?? 'all') as 'all' | 'intake' | 'scheduler' | 'worker',
      ...(process.env.DRAFLOW_LEASE_MS && { leaseMs: Number(process.env.DRAFLOW_LEASE_MS) }),
      ...(process.env.DRAFLOW_POLL_MS && { pollMs: Number(process.env.DRAFLOW_POLL_MS) }),
      ...(process.env.DRAFLOW_ORG_ACTIVE_RUNS && {
        maxActiveRuns: Number(process.env.DRAFLOW_ORG_ACTIVE_RUNS),
      }),
      ...(process.env.DRAFLOW_TARGET_CONCURRENCY && {
        maxTargetRequests: Number(process.env.DRAFLOW_TARGET_CONCURRENCY),
      }),
      ...(process.env.DRAFLOW_RATE_ACCOUNTS && {
        rateAccounts: JSON.parse(process.env.DRAFLOW_RATE_ACCOUNTS),
      }),
    },
  }),
  ...(httpAuth && { httpAuth }),
  ...(process.env.DRAFLOW_HTTP_MAX_RESPONSE_BYTES !== undefined && {
    maxHttpResponseBytes: Number(process.env.DRAFLOW_HTTP_MAX_RESPONSE_BYTES),
  }),
  registry: new NodeRegistry().registerAll(standardNodes),
  onWorkerError(error) {
    console.error(error);
    void stop(1);
  },
});
const webhookPort = process.env.DRAFLOW_WEBHOOK_PORT;
const webhooks =
  webhookPort === undefined
    ? undefined
    : createWebhookServer(host, {
        signingKey: process.env.DRAFLOW_WEBHOOK_SECRET ?? '',
        ...(process.env.DRAFLOW_WEBHOOK_MAX_BODY_BYTES !== undefined && {
          maxBodyBytes: Number(process.env.DRAFLOW_WEBHOOK_MAX_BODY_BYTES),
        }),
      });
if (webhooks) {
  webhooks.listen(Number(webhookPort), process.env.DRAFLOW_WEBHOOK_HOST ?? '127.0.0.1');
}
const operatorPort = process.env.DRAFLOW_OPERATOR_PORT;
const operator =
  operatorPort === undefined
    ? undefined
    : createOperatorServer(
        [host],
        () => {
          const file = process.env.DRAFLOW_OPERATOR_ACCOUNTS;
          if (!file) throw Error('Missing operator account configuration');
          return JSON.parse(readFileSync(file, 'utf8'));
        },
        Number(process.env.DRAFLOW_MONITOR_MS ?? 30000),
        (event) => console.error(JSON.stringify({ monitor: event })),
      );
operator?.listen(Number(operatorPort), process.env.DRAFLOW_OPERATOR_HOST ?? '127.0.0.1');
const input = createInterface({ input: process.stdin });
async function stop(code: number) {
  operator?.close();
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
        case 'preview':
          result = host.previewPublication(q.workflow);
          break;
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
          const replacement = loadHttpAuth(authPath);
          if (
            process.env.DRAFLOW_ORGANIZATION &&
            replacement.organization !== process.env.DRAFLOW_ORGANIZATION
          )
            throw Error('HTTP credential organization mismatch');
          Object.assign(httpAuth, replacement);
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
        case 'compensate':
          result = host.compensate(q.runId);
          break;
        case 'compensationInfo':
          result = host.compensationInfo(q.runId);
          break;
        case 'retryCompensation':
          result = host.retryCompensation(q.runId, q.failureId);
          break;
        case 'redrive':
          result = host.redrive(q.runId, q.failureId);
          break;
        case 'recoveryInfo':
          result = host.recoveryInfo(q.runId);
          break;
        case 'resetSync':
          result = host.resetSync(q.workflowId, q.nodeId, q.scope);
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
  operator?.close();
  webhooks?.close();
  try {
    await host.close();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
