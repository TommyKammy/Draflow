import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { until } from './fixture.mjs';

test('permanent business receipts survive restart, partial fanout and conflicting replays', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'business-'));
  const organization = randomUUID();
  const registry = new NodeRegistry().registerAll(standardNodes);
  const shared = process.env.DRAFLOW_TEST_POSTGRES && {
    organization,
    connectionString: process.env.DRAFLOW_TEST_POSTGRES,
  };
  const open = () =>
    new NodeHost(join(dir, 'ledger'), {
      organization,
      registry,
      shared,
      dedupMs: 0,
      prepareBusiness: async () => ({ status: 'prepared' }),
    });
  let host = open();
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const d = {
    organization,
    project: 'p',
    event: 'same',
    rule: 'one',
    revision: 1,
    proposal: { task: 'task', version: 1 },
  };
  const first = host.acceptBusiness(d);
  await host.close();
  host = open();
  assert.equal(host.acceptBusiness({ ...d, proposal: { version: 1, task: 'task' } }), first);
  assert.throws(() => host.acceptBusiness({ ...d, revision: 2 }), /conflict/);
  assert.throws(() => host.acceptBusiness({ ...d, organization: 'other' }), /mismatch/);
  const second = host.acceptBusiness({ ...d, rule: 'two' });
  assert.notEqual(first, second);
  await until(() => [first, second].every((id) => host.receipt(id).outcome === 'success'));
  assert.equal(host.operate({ organization, actor: 'auditor', role: 'viewer' }, { op: 'list' }).length, 2);
});

test('a process lost during preparation recovers the same run and rechecks revoked authority', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'business-crash-'));
  const organization = randomUUID(),
    path = join(dir, 'ledger');
  const shared = process.env.DRAFLOW_TEST_POSTGRES && {
    organization,
    connectionString: process.env.DRAFLOW_TEST_POSTGRES,
    leaseMs: 500,
    pollMs: 40,
  };
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync, readFileSync } = await import('node:fs');
  const mod = (specifier) => JSON.stringify(import.meta.resolve(specifier));
  const child = join(dir, 'crash.mjs');
  writeFileSync(
    child,
    `
    import {NodeRegistry} from ${mod('@draflow/core')};
    import {standardNodes} from ${mod('@draflow/nodes')};
    import {NodeHost} from ${JSON.stringify(new URL('../dist/host.js', import.meta.url).href)};
    import {writeFileSync} from 'node:fs';
    const h=new NodeHost(${JSON.stringify(path)},{organization:${JSON.stringify(organization)},shared:${JSON.stringify(shared)},registry:new NodeRegistry().registerAll(standardNodes),
      prepareBusiness:async()=>process.kill(process.pid,'SIGKILL')});
    const run=h.acceptBusiness({organization:${JSON.stringify(organization)},project:'p',event:'x',rule:'r',revision:1,proposal:{}});
    writeFileSync(${JSON.stringify(join(dir, 'run'))},run);
  `,
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(spawnSync(process.execPath, [child], { timeout: 15000 }).signal, 'SIGKILL');
  const run = readFileSync(join(dir, 'run'), 'utf8'),
    checked = [];
  const host = new NodeHost(path, {
    organization,
    shared,
    registry: new NodeRegistry().registerAll(standardNodes),
    prepareBusiness: async (...args) => {
      checked.push(args);
      return { status: 'denied' };
    },
  });
  t.after(() => host.close());
  assert.equal(
    host.acceptBusiness({ organization, project: 'p', event: 'x', rule: 'r', revision: 1, proposal: {} }),
    run,
  );
  await until(() => host.receipt(run).outcome === 'error');
  assert.deepEqual(checked, [[organization, 'x', 'r', run, 'p', 1]]);
});

test(
  'SQLite cutover retains permanent business receipts and pinned publications',
  { skip: !process.env.DRAFLOW_TEST_POSTGRES },
  async (t) => {
    const { migrateLedger } = await import('../dist/migrate.js');
    const dir = mkdtempSync(join(tmpdir(), 'business-migrate-')),
      path = join(dir, 'ledger'),
      organization = randomUUID();
    const options = {
      organization,
      registry: new NodeRegistry().registerAll(standardNodes),
      prepareBusiness: async () => ({ status: 'prepared' }),
    };
    const d = { organization, project: 'p', event: 'e', rule: 'r', revision: 1, proposal: {} };
    let h = new NodeHost(path, options);
    t.after(async () => {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const id = h.acceptBusiness(d);
    await h.close();
    const shared = { organization, connectionString: process.env.DRAFLOW_TEST_POSTGRES };
    const imported = migrateLedger(path, shared);
    assert.equal(imported.counts.business_receipts, 1);
    assert.deepEqual(migrateLedger(path, shared), imported);
    h = new NodeHost('', { ...options, shared });
    assert.equal(h.acceptBusiness(d), id);
    await until(() => h.receipt(id).outcome === 'success');
  },
);
