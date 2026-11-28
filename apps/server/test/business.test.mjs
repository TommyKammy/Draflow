import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
import { registry, workflow, until } from './fixture.mjs';

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

test('ordinary and business workers leave incompatible jobs for their owner after restart', async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'business-lanes-')), 'ledger');
  const organization = randomUUID();
  const shared = process.env.DRAFLOW_TEST_POSTGRES && {
    organization,
    connectionString: process.env.DRAFLOW_TEST_POSTGRES,
  };
  const options = { registry: registry().registerAll(standardNodes), organization, shared };
  let host = new NodeHost(path, options);
  t.after(async () => {
    await host.close();
    rmSync(resolve(path, '..'), { recursive: true, force: true });
  });
  const open = async (extra) => {
    await host.close();
    host = new NodeHost(path, { ...options, ...extra });
  };
  const business = host.acceptBusiness({
    organization,
    project: 'p',
    event: 'e',
    rule: 'r',
    revision: 1,
    proposal: {},
  });
  const revision = host.publish(workflow());
  host.activate('flow', revision);
  const ordinary = () => host.accept('flow', 'a', { items: [{ json: {} }] });
  const first = ordinary();
  await until(() => host.receipt(first).outcome === 'success');
  assert.equal(host.receipt(business).state, 'queued');
  const second = ordinary();
  await open({
    businessOnly: true,
    registry: new NodeRegistry().registerAll(standardNodes),
    prepareBusiness: async () => ({ status: 'prepared' }),
  });
  await until(() => host.receipt(business).outcome === 'success');
  assert.equal(host.receipt(second).state, 'queued');
  await open({});
  await until(() => host.receipt(second).outcome === 'success');
});

test('business retries have a durable limit and conflicting review decisions cannot send twice', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'business-review-')),
    organization = randomUUID();
  const shared = process.env.DRAFLOW_TEST_POSTGRES && {
    organization,
    connectionString: process.env.DRAFLOW_TEST_POSTGRES,
  };
  let tries = 0,
    probes = 0,
    available = false;
  const host = new NodeHost(join(dir, 'ledger'), {
    organization,
    shared,
    registry: new NodeRegistry().registerAll(standardNodes),
    prepareBusiness: async () => ({ status: 'prepared' }),
    executeBusiness: async (_o, _e, _r, _run, _p, _v, probe) => {
      if (probe) {
        probes++;
        return { status: 'review' };
      }
      tries++;
      if (!available) throw Error('connection lost');
      return { status: 'applied' };
    },
  });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = host.acceptBusiness({
    organization,
    project: 'p',
    event: 'e',
    rule: 'r',
    revision: 1,
    proposal: { definition: { apply: true } },
  });
  await until(() => host.receipt(run).state === 'review');
  assert.deepEqual([tries, probes], [3, 1]);
  assert.equal(host.effects(run)[0].key, run);
  available = true;
  assert.equal(host.reconcile(run, run, 'notApplied'), true);
  assert.equal(host.reconcile(run, run, 'applied'), false);
  await until(() => host.receipt(run).outcome === 'success');
  assert.equal(tries, 4);
});

test('a canceled handoff cannot start a business write after the receiver becomes ready', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cancel-effect-')),
    organization = randomUUID();
  const shared = process.env.DRAFLOW_TEST_POSTGRES && {
    connectionString: process.env.DRAFLOW_TEST_POSTGRES,
    organization,
  };
  let waiting,
    release,
    writes = 0;
  const entered = new Promise((r) => (waiting = r)),
    ready = new Promise((r) => (release = r));
  const host = new NodeHost(join(dir, 'ledger'), {
    registry: new NodeRegistry().registerAll(standardNodes),
    organization,
    shared,
    prepareBusiness: async () => ({ status: 'prepared' }),
    executeBusiness: async (_org, _event, _rule, _run, _project, _revision, _probe, canStart) => {
      waiting();
      await ready;
      if (!canStart()) return { status: 'canceled' };
      writes++;
      return { status: 'applied' };
    },
  });
  t.after(async () => {
    release();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = host.acceptBusiness({
    organization,
    event: 'e',
    rule: 'r',
    project: 'p',
    revision: 1,
    proposal: { definition: { apply: true } },
  });
  await entered;
  assert.equal(host.cancel(id), true);
  release();
  await until(() => host.receipt(id).state === 'finished');
  assert.equal(writes, 0);
});

test('cancellation of an uncertain business effect keeps receipt lookup available without resending', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cancel-business-review-'));
  const organization = randomUUID();
  const shared = process.env.DRAFLOW_TEST_POSTGRES && {
    organization,
    connectionString: process.env.DRAFLOW_TEST_POSTGRES,
  };
  let sends = 0,
    canceledLookups = 0,
    recovered = false;
  const host = new NodeHost(join(dir, 'ledger'), {
    organization,
    shared,
    registry: new NodeRegistry().registerAll(standardNodes),
    prepareBusiness: async () => ({ status: 'prepared' }),
    executeBusiness: async (_org, _event, _rule, _run, _project, _revision, probe, canStart) => {
      if (!probe) sends++;
      else if (!canStart()) {
        canceledLookups++;
        if (recovered) return { status: 'applied' };
      }
      throw Error('receiver unavailable');
    },
  });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = host.acceptBusiness({
    organization,
    event: 'e',
    rule: 'r',
    project: 'p',
    revision: 1,
    proposal: { definition: { apply: true } },
  });
  await until(() => host.receipt(run).state === 'review');
  assert.equal(host.cancel(run), true);
  await until(() => canceledLookups === 1 && host.receipt(run).state === 'review');
  assert.equal(host.reconcile(run, run, 'retryKeyed'), false);
  recovered = true;
  assert.equal(host.reconcile(run, run, 'applied'), true);
  await until(() => host.receipt(run).outcome === 'success');
  assert.deepEqual([sends, canceledLookups], [3, 2]);
});

test('a live run requires an applied or skipped result and reports a conflicting receiver receipt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'business-result-'));
  const organization = randomUUID();
  const shared = process.env.DRAFLOW_TEST_POSTGRES && {
    organization, connectionString: process.env.DRAFLOW_TEST_POSTGRES,
  };
  const host = new NodeHost(join(dir, 'ledger'), {
    organization, shared, registry: new NodeRegistry().registerAll(standardNodes),
    prepareBusiness: async () => ({ status: 'prepared' }),
    executeBusiness: async (_org, event, _rule, _run, _project, _revision, probe) => ({
      status: event === 'review' && probe ? 'applied' : event,
    }),
  });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const uncertain = host.acceptBusiness({
    organization, event: 'review', project: 'p', rule: 'r', revision: 1,
    proposal: { definition: { apply: true } },
  });
  await until(() => host.receipt(uncertain).state === 'review');
  assert.equal(host.reconcile(uncertain, uncertain, 'applied'), true);
  await until(() => host.receipt(uncertain).outcome === 'success');
  for (const event of ['prepared', 'conflict']) {
    const run = host.acceptBusiness({
      organization, event, project: 'p', rule: 'r', revision: 1, proposal: { definition: { apply: true } },
    });
    await until(() => host.receipt(run).outcome === 'error');
    if (event === 'conflict') assert.equal((await host.history.get(host.receipt(run).workflowId, run)).error.name, 'BusinessConflict');
  }
});
