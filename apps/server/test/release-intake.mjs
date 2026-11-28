// A separate event loop and DB connection for each live operator intake in the race test.
import { parentPort, workerData } from 'node:worker_threads';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { createOperatorServer } from '../dist/operator-http.js';

const { organization, connectionString, accounts } = workerData;
const host = new NodeHost(':memory:', {
  organization, registry: new NodeRegistry().registerAll(standardNodes),
  ...(connectionString && { shared: { organization, connectionString, role: 'intake' } }),
});
const server = createOperatorServer([host], () => accounts);
server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
parentPort.once('message', async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await host.close();
  parentPort.close();
});
