// Optional two-checkout deployment entry point. Prood owns the outbox, roles and business operations.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { QueueFull } from '../dist/sqlite.js';
import { NodeHost } from '../dist/host.js';

const [proodRoot, organization, ledgerPath] = process.argv.slice(2);
if (!proodRoot || !organization || !ledgerPath)
  throw Error('Usage: node apps/server/src/prood-worker.mjs PROOD_CHECKOUT WORKSPACE_ID DRAFLOW_SQLITE_PATH');
const load = (file) => import(pathToFileURL(resolve(proodRoot, file)).href);
const { selectDatabaseClient } = await load('apps/server/dist/index.js');
const { createWorkUseCases, createSystemIdGenerator, deliverNext } = await load(
  'packages/application/dist/index.js',
);
const db = selectDatabaseClient();
let host;
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
try {
  await db.migrate();
  const deps = { uow: db.uow, idGenerator: createSystemIdGenerator(), clock: { now: () => new Date() } };
  const work = createWorkUseCases(deps);
  host = new NodeHost(ledgerPath, {
    organization,
    businessOnly: true,
    registry: new NodeRegistry().registerAll(standardNodes),
    ...(process.env.DRAFLOW_POSTGRES_URL && {
      shared: { organization, connectionString: process.env.DRAFLOW_POSTGRES_URL },
    }),
    executeBusiness: (...args) => work.executeAutomation(...args),
    prepareBusiness: (...args) => work.prepareAutomation(...args),
    onWorkerError: () => {
      process.exitCode = 1;
      stop.abort();
    },
  });
  while (!stop.signal.aborted) {
    let sent;
    try {
      sent = await deliverNext(deps, organization, (d) => host.acceptBusiness(d));
    } catch (error) {
      if (!(error instanceof QueueFull)) throw error;
      // The unconfirmed lease can be reclaimed after capacity becomes available.
    }
    if (!sent) await delay(250);
  }
} finally {
  try {
    await host?.close();
  } finally {
    await db.close();
  }
}
