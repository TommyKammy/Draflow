// Fault injection runs in a real worker process. Each kill leaves both ledgers on disk.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../../dist/host.js';
import { ExecutionLedger } from '../../dist/sqlite.js';
const [dir, schema, organization, phase] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(resolve(process.env.PROOD_EFFECTS_CHECKOUT, file)));
const { selectDatabaseClient } = await load('apps/server/dist/index.js');
const { createSystemIdGenerator, createWorkUseCases } = await load('packages/application/dist/index.js');
const url = process.env.DRAFLOW_TEST_POSTGRES;
const db = url
  ? (await load('packages/persistence/postgres/dist/index.js')).createPostgresDatabase({
      connectionString: url,
      schema,
    })
  : selectDatabaseClient({ PROOD_SQLITE_PATH: resolve(dir, 'prood') });
const kill = () => process.kill(process.pid, 'SIGKILL');
const uow =
  phase === 'before-commit'
    ? {
        run: (fn) =>
          db.uow.run(async (r) => {
            await fn(r);
            kill();
          }),
      }
    : db.uow;
const work = createWorkUseCases({
  uow,
  idGenerator: createSystemIdGenerator(),
  clock: { now: () => new Date() },
});
if (phase === 'before-finish') ExecutionLedger.prototype.finish = kill;
new NodeHost(resolve(dir, 'ledger'), {
  organization,
  registry: new NodeRegistry().registerAll(standardNodes),
  businessOnly: true,
  prepareBusiness: () => {
    throw Error('unexpected preview');
  },
  shared: url ? { organization, connectionString: url, leaseMs: 500, pollMs: 40 } : undefined,
  executeBusiness: async (...args) => {
    const result = await work.executeAutomation(...args);
    if (phase === 'lost-response') kill();
    return result;
  },
});
