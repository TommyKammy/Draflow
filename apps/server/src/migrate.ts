// Offline, resumable-at-the-transaction-boundary import. The source is never written.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { ledgerTables } from './ledger-schema.js';
import { PostgresDatabase, type SharedOptions } from './postgres.js';

const tables = [...ledgerTables.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
// Additive tables may be absent on older or organization-less source ledgers.
const optionalTables = new Set([
  'business_publications',
  'business_receipts',
  'business_attempts',
  'memberships',
  'credential_access',
  'operator_audit',
  'review_clock',
  'operator_alerts',
  'inactive_registrations',
]);
function identifier(name: string) {
  return '"' + name.replaceAll('"', '""') + '"';
}

export function migrateLedger(path: string, options: SharedOptions) {
  const source = new DatabaseSync(path, { readOnly: true });
  let dest: PostgresDatabase | undefined;
  try {
    source.exec('BEGIN EXCLUSIVE');
    if (
      source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledgerOrganization'").get()
    ) {
      const bound = source.prepare('SELECT organization FROM ledgerOrganization').get() as
        | { organization: string }
        | undefined;
      if (bound && bound.organization !== options.organization) throw Error('Source organization mismatch');
    }
    dest = new PostgresDatabase(options);
    const pg = dest;
    return pg.atomic(() => {
      pg.raw('CREATE TABLE IF NOT EXISTS migration(fingerprint text PRIMARY KEY)');
      const previous = pg.raw('SELECT fingerprint FROM migration').rows[0];
      const hash = createHash('sha256');
      const counts: Record<string, number> = {};
      for (const table of [...tables, ...optionalTables]) {
        const t = identifier(table);
        if (!previous && pg.raw('SELECT 1 FROM ' + t + ' LIMIT 1').rows.length)
          throw Error('Destination must be empty');
        const columns = source
          .prepare('PRAGMA table_info(' + t + ')')
          .all()
          .map((c) => String((c as { name: string }).name));
        if (!columns.length && optionalTables.has(table)) continue;
        if (!columns.length) throw Error('Missing Phase 6 table: ' + table);
        const ordered =
          pg.raw(
            "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name='rowid'",
            [pg.schema, table],
          ).rows.length > 0;
        if (ordered) columns.push('rowid');
        const names = columns.map(identifier).join(',');
        const insert =
          'INSERT INTO ' +
          t +
          '(' +
          names +
          ') VALUES(' +
          columns.map((_, i) => '$' + (i + 1)).join(',') +
          ')';
        hash.update(JSON.stringify([table, columns]));
        let count = 0;
        const statement = source.prepare('SELECT ' + names + ' FROM ' + t + ' ORDER BY rowid');
        // Node 22.13's native iterator does not keep its StatementSync alive across GC.
        const rows = Object.assign(statement.iterate(), { sourceStatement: statement });
        for (const row of rows) {
          const values = columns.map((c) => (row as Record<string, string | number | null>)[c]!);
          hash.update(JSON.stringify(values));
          if (!previous) pg.raw(insert, values);
          count++;
        }
        if (!previous && ordered && count)
          pg.raw("SELECT setval(pg_get_serial_sequence($1,'rowid'),max(rowid)) FROM " + t, [t]);
        counts[table] = count;
      }
      const fingerprint = hash.digest('hex');
      if (previous && previous.fingerprint !== fingerprint)
        throw Error('Different source snapshot already imported');
      if (!previous) {
        pg.raw(
          `INSERT INTO review_clock SELECT "runId",COALESCE("startedAt","acceptedAt") FROM runs WHERE state='review' ON CONFLICT DO NOTHING`,
        );
        for (const row of pg.raw('SELECT target,"untilMs" FROM "rateLimits" WHERE "untilMs">$1', [pg.now()])
          .rows)
          pg.holdTarget(String(row.target), Number(row.untilMs));
        pg.raw('INSERT INTO migration VALUES($1)', [fingerprint]);
      }
      return { organization: options.organization, fingerprint, counts };
    });
  } finally {
    source.close();
    dest?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path] = process.argv.slice(2);
  if (!path || !process.env.DRAFLOW_POSTGRES_URL)
    throw Error('Expected SQLite path and DRAFLOW_POSTGRES_URL');
  console.log(
    JSON.stringify(
      migrateLedger(path, {
        connectionString: process.env.DRAFLOW_POSTGRES_URL,
        organization: process.env.DRAFLOW_ORGANIZATION ?? '',
        ...(process.env.DRAFLOW_TARGET_CONCURRENCY && {
          maxTargetRequests: Number(process.env.DRAFLOW_TARGET_CONCURRENCY),
        }),
        ...(process.env.DRAFLOW_RATE_ACCOUNTS && {
          rateAccounts: JSON.parse(process.env.DRAFLOW_RATE_ACCOUNTS),
        }),
      }),
    ),
  );
}
