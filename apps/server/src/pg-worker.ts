// Preserve the synchronous host API while keeping a PostgreSQL session (including
// open transactions) on its own I/O thread. Only shared-mode hosts load pg.
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import pg from 'pg';

const { port, signal, url } = workerData as { port: MessagePort; signal: SharedArrayBuffer; url: string };
const wake = new Int32Array(signal);
const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  idle_in_transaction_session_timeout: 3000,
  application_name: 'draflow',
});
// Notify even an idle intake. Its supervisor can restart it on the writer endpoint.
const disconnected = () => parentPort?.postMessage('disconnected');
client.once('error', disconnected);
client.once('end', disconnected);
pg.types.setTypeParser(20, Number);
let connected = false;
port.on('message', async ({ sql, values, close }) => {
  try {
    if (!connected) {
      await client.connect();
      connected = true;
    }
    if (close) await client.end();
    const result = close ? undefined : await client.query(sql, values);
    const last = Array.isArray(result) ? result.at(-1) : result;
    port.postMessage({ rows: last?.rows ?? [], changes: last?.rowCount ?? 0 });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : 'PostgreSQL operation failed' });
  } finally {
    Atomics.store(wake, 0, 1);
    Atomics.notify(wake, 0);
  }
});
