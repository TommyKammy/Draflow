// Opt-in destructive fault injection confined to this test's uniquely named Docker resources.
import pg from 'pg';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'draflow-backup-'));
const name = 'draflow-ha-' + randomUUID().slice(0, 8);
const primary = name + '-primary',
  standby = name + '-standby',
  volume = name + '-p',
  replica = name + '-s';
const password = randomUUID(),
  image = process.env.DRAFLOW_TEST_POSTGRES_IMAGE ?? 'postgres:18.4-alpine';
const pgdata = '/var/lib/postgresql/ha';
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 90000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const sql = (container, statement) =>
  docker(
    'exec',
    container,
    'psql',
    '-h',
    '127.0.0.1',
    '-XAt',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-c',
    statement,
  );
async function wait(fn) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await delay(200);
  }
  throw Error('PostgreSQL readiness deadline exceeded');
}
const opts = (container, vol, alias) => [
  'run',
  '-d',
  '--name',
  container,
  '--network',
  name,
  '--network-alias',
  alias,
  '-p',
  '127.0.0.1::5432',
  '-v',
  vol + ':/var/lib/postgresql',
  '-e',
  'PGDATA=' + pgdata,
  '-e',
  'POSTGRES_PASSWORD=' + password,
  '-e',
  'PGPASSWORD=' + password,
  image,
];
const endpoint = (container) =>
  'postgres://postgres:' + password + '@' + docker('port', container, '5432/tcp') + '/postgres';
function intake(url, commands) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url))], {
    input: commands.map((q) => JSON.stringify(q)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 25000,
    env: { ...process.env, DRAFLOW_ROLE: 'intake', DRAFLOW_POSTGRES_URL: url, DRAFLOW_ORGANIZATION: name },
  });
}
function answers(url, ops) {
  const r = intake(url, ops);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const v = JSON.parse(line);
      assert.equal(v.ok, true, v.error);
      return v.result;
    });
}
try {
  docker('network', 'create', name);
  docker(...opts(primary, volume, 'primary'));
  await wait(() => sql(primary, 'SELECT 1') === '1');
  docker(
    'exec',
    primary,
    'sh',
    '-ec',
    `echo 'host replication postgres all scram-sha-256' >> "$PGDATA/pg_hba.conf"`,
  );
  sql(primary, 'SELECT pg_reload_conf()');
  docker(
    ...opts(standby, replica, 'standby'),
    'sh',
    '-ec',
    `
    mkdir -p "$PGDATA"; chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"
    pg_basebackup -h primary -U postgres -D "$PGDATA" -R -X stream
    chown -R postgres:postgres "$PGDATA"
    exec docker-entrypoint.sh postgres`,
  );
  await wait(() => sql(primary, "SELECT count(*) FROM pg_stat_replication WHERE state='streaming'") === '1');
  sql(primary, "ALTER SYSTEM SET synchronous_standby_names='*'");
  sql(primary, 'SELECT pg_reload_conf()');
  await wait(() => sql(primary, "SELECT count(*) FROM pg_stat_replication WHERE sync_state='sync'") === '1');
  const a = endpoint(primary),
    b = endpoint(standby);
  for (const connectionString of [a, b])
    await wait(async () => {
      const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
      try {
        await client.connect();
        await client.query('SELECT 1');
        return true;
      } finally {
        await client.end();
      }
    });
  const flow = JSON.parse(readFileSync(new URL('../../../examples/order-import.json', import.meta.url)));
  flow.nodes = [flow.nodes[0]];
  flow.connections = [];
  const events = Array.from({ length: 20 }, (_, i) => ({
    op: 'accept',
    workflowId: flow.id,
    triggerNodeId: 'schedule',
    event: { key: 'event' + i, items: [{ json: {} }] },
  }));
  const ids = answers(a, [
    { op: 'publish', workflow: flow },
    { op: 'activate', workflowId: flow.id, revision: 1 },
    ...events,
  ]).slice(2);
  assert.equal(new Set(ids).size, 20);
  docker('exec', primary, 'pg_dump', '-U', 'postgres', '-Fc', '-f', '/tmp/receipts.backup', 'postgres');
  // Keep stdin open. Losing its DB session must make an idle intake restartable
  // without a new request or a separate health-check command.
  const live = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url))], {
    env: { ...process.env, DRAFLOW_ROLE: 'intake', DRAFLOW_POSTGRES_URL: a, DRAFLOW_ORGANIZATION: name },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exit = once(live, 'exit');
  const lines = createInterface({ input: live.stdout });
  let started;
  try {
    const ready = once(lines, 'line');
    live.stdin.write('{"op":"stats"}\n');
    assert.equal(JSON.parse((await ready)[0]).ok, true);
    started = Date.now();
    docker('kill', '--signal', 'KILL', primary);
    await wait(() => live.exitCode !== null);
    assert.equal((await exit)[0], 1);
  } finally {
    lines.close();
    if (live.exitCode === null && live.signalCode === null) live.kill('SIGKILL');
  }
  const denied = intake(a, [events[0]]);
  assert.ok(denied.status !== 0 || !denied.stdout.includes('"ok":true'));
  sql(standby, 'SELECT pg_promote(true,30)');
  assert.deepEqual(answers(b, events), ids);
  const recoveryMs = Date.now() - started;
  assert.ok(recoveryMs < 300000);

  // Rejoin the fenced old primary as read-only, following the promoted timeline.
  docker(
    'run',
    '--rm',
    '-v',
    volume + ':/var/lib/postgresql',
    '-e',
    'PGDATA=' + pgdata,
    '-e',
    'PW=' + password,
    image,
    'sh',
    '-ec',
    `touch "$PGDATA/standby.signal"; echo "primary_conninfo = 'host=standby user=postgres password=$PW'" >> "$PGDATA/postgresql.auto.conf"; chown postgres:postgres "$PGDATA/standby.signal"`,
  );
  docker('start', primary);
  await wait(() => sql(primary, 'SELECT pg_is_in_recovery()') === 't');
  await wait(() => sql(standby, "SELECT count(*) FROM pg_stat_replication WHERE state='streaming'") === '1');
  assert.throws(() => sql(primary, 'CREATE TABLE forbidden_write(x integer)'));
  docker('cp', primary + ':/tmp/receipts.backup', join(scratch, 'receipts.backup'));
  docker('cp', join(scratch, 'receipts.backup'), standby + ':/tmp/receipts.backup');
  docker('exec', standby, 'createdb', '-U', 'postgres', 'restored');
  docker(
    'exec',
    standby,
    'pg_restore',
    '--exit-on-error',
    '-U',
    'postgres',
    '-d',
    'restored',
    '/tmp/receipts.backup',
  );
  const restored = b.replace(/\/postgres$/, '/restored');
  const receipts = answers(
    restored,
    ids.map((runId) => ({ op: 'receipt', runId })),
  );
  assert.deepEqual(
    receipts.map((r) => r.runId),
    ids,
  );
  assert.ok(receipts.every((r) => r.state === 'queued'));
  console.log(
    JSON.stringify({
      acknowledged: ids.length,
      missing: 0,
      recoveryMs,
      oldPrimaryReadOnly: true,
      restored: receipts.length,
    }),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
  for (const n of [primary, standby]) spawnSync('docker', ['rm', '-fv', n], { stdio: 'ignore' });
  for (const v of [volume, replica]) spawnSync('docker', ['volume', 'rm', v], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
}
