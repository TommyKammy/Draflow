import { businessSchema, describeDelivery, type BusinessDelivery } from './business.js';
import { operatorSchema, sqliteReviewClock, seedReviewClock } from './operator-schema.js';
import { OperatorStore } from './operator-store.js';
import { deliverySchema, ledgerTables, sqliteTriggers } from './ledger-schema.js';
import { PostgresDatabase, validateOrganization, type SharedOptions } from './postgres.js';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ExecutionDetail, ExecutionStore, ExecutionSummary } from '@draflow/storage';
import type { PublishedWorkflow, TriggerEvent } from '@draflow/runtime';

import type {
  Item,
  Workflow,
  WorkflowNode,
  Checkpoint,
  JournalItem,
  JsonObject,
  RunData,
  SuspensionRequest,
  WaitResult,
} from '@draflow/core';
import { buildGraph, hasPath } from '@draflow/core';
import { recordedTransport, UnsentCredentialError } from './http-auth.js';
import { compensationSpec, validateCompensations, type CompensationSpec } from './compensation.js';
import { retryTime, pageConfig, type readPage } from './pages.js';
import type { Schedule } from './schedule.js';

export class QueueFull extends Error {
  constructor() {
    super('Queue full');
  }
}

export type DeliverySource = 'trigger' | 'webhook' | 'schedule';
export type Reconciliation = 'applied' | 'notApplied' | 'retryKeyed';
export type RunState = 'queued' | 'running' | 'waiting' | 'review' | 'finished' | 'interrupted';
export interface Receipt {
  runId: string;
  workflowId: string;
  revision: number;
  triggerNodeId: string;
  eventKey: string | null;
  mode: 'trigger' | 'webhook' | 'subworkflow';
  state: RunState;
  acceptedAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  outcome: ExecutionSummary['status'] | null;
}

// Scheduled instants stay reserved for the lifetime of the receipt, including after reactivation.
const noExpiry = -1;

const fields =
  'runId, workflowId, revision, triggerNodeId, eventKey, mode, state, acceptedAt, startedAt, stoppedAt, outcome';

export function executionTasks(runData: RunData): ExecutionDetail['tasks'] {
  return Object.values(runData)
    .flat()
    .sort((a, b) => a.executionIndex - b.executionIndex)
    .map((task) => ({ nodeId: task.nodeId, runIndex: task.runIndex, reused: false, task }));
}

function encodeCheckpoint(state: Checkpoint) {
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error('Checkpoint exceeds 8 MiB');
  return json;
}

export class ExecutionLedger {
  readonly #db: DatabaseSync | PostgresDatabase;
  readonly shared?: PostgresDatabase;
  readonly operators: OperatorStore;
  readonly #businessEnabled: boolean;
  #inTransaction = false;
  readonly history: ExecutionStore;

  #now() {
    return this.shared?.now() ?? Date.now();
  }

  constructor(
    path: string,
    private readonly maxDetailBytes: number,
    private readonly maxCallDepth = 8,
    shared?: SharedOptions,
    organization?: string,
  ) {
    this.#businessEnabled = Boolean(organization || shared);
    if (organization !== undefined) validateOrganization(organization);
    this.#db = shared ? (this.shared = new PostgresDatabase(shared)) : new DatabaseSync(path);
    if (!shared) {
      try {
        // Keep the writer lock until close. Only the owner may recover running jobs.
        this.#db.exec(`PRAGMA locking_mode=EXCLUSIVE;
        PRAGMA foreign_keys=ON;
        PRAGMA synchronous=FULL;
        BEGIN EXCLUSIVE;
        ${ledgerTables}
        ${sqliteTriggers}`);
        if (organization)
          this.#db.exec(businessSchema + operatorSchema + sqliteReviewClock + seedReviewClock);
        if (!this.#prepare("SELECT 1 FROM pragma_table_info('active') WHERE name='registration'").get()) {
          this.#db.exec(
            "ALTER TABLE active ADD COLUMN registration TEXT NOT NULL DEFAULT ''; UPDATE active SET registration=lower(hex(randomblob(16)))",
          );
        }
        if (!this.#prepare("SELECT 1 FROM pragma_table_info('pageRuns') WHERE name='skipped'").get()) {
          this.#db.exec('ALTER TABLE pageRuns ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0');
        }
        if (!this.#prepare("SELECT 1 FROM pragma_table_info('deliveries') WHERE name='source'").get()) {
          // Earlier ledgers reserved scheduled instants with noExpiry and used run mode for other deliveries.
          this.#db.exec(`ALTER TABLE deliveries RENAME TO legacy_deliveries;
          ${deliverySchema}
          INSERT INTO deliveries(workflowId,triggerNodeId,eventKey,source,expiresAt,runId)
          SELECT d.workflowId,d.triggerNodeId,d.eventKey,
            CASE WHEN d.expiresAt=${noExpiry} THEN 'schedule' ELSE r.mode END,d.expiresAt,d.runId
          FROM legacy_deliveries d JOIN runs r USING(runId);
          DROP TABLE legacy_deliveries;`);
        }
        this.#db.exec(
          'CREATE TABLE IF NOT EXISTS ledgerOrganization(singleton INTEGER PRIMARY KEY CHECK(singleton=1), organization TEXT NOT NULL)',
        );
        if (organization)
          this.#prepare('INSERT OR IGNORE INTO ledgerOrganization VALUES(1,?)').run(organization);
        const bound = this.#prepare('SELECT organization FROM ledgerOrganization').get();
        if (bound && bound.organization !== organization) throw Error('SQLite ledger organization mismatch');
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.close();
        throw error;
      }
    }
    this.operators = new OperatorStore(
      (sql) => this.#prepare(sql),
      (fn) => this.#transaction(fn),
      () => this.#now(),
      Boolean(this.shared),
    );
    this.history = {
      append: async (summary, detail) => this.#append(summary, detail),
      list: async (id, status) =>
        this.#prepare(
          `SELECT summary, detail IS NOT NULL AS hasDetail
        FROM history WHERE workflowId=? AND (? IS NULL OR status=?) ORDER BY startedAt DESC, rowid DESC`,
        )
          .all(id, status ?? null, status ?? null)
          .map((row) => ({
            ...(JSON.parse(String(row.summary)) as ExecutionSummary),
            hasDetail: Boolean(row.hasDetail),
          })),
      get: async (id, run) => {
        const row = this.#prepare('SELECT detail FROM history WHERE workflowId=? AND id=?').get(id, run);
        if (!row?.detail) return null;
        const detail = JSON.parse(String(row.detail)) as ExecutionDetail;
        const info = this.inspect(run);
        if (info.pages.length || info.calls.length) detail.orchestration = info;
        return detail;
      },
      delete: async (id, run) => {
        this.#prepare('DELETE FROM history WHERE workflowId=? AND id=?').run(id, run);
      },
    };
  }

  // Node 22 types leave SELECT results unknown. Every projection here uses SQLite column names.
  #prepare(sql: string) {
    type Row = Record<string, string | number | null>;
    type Bindings = Array<string | number | null>;
    return this.#db.prepare(sql) as {
      run(...values: Bindings): { changes: number | bigint };
      all(...values: Bindings): Row[];
      get(...values: Bindings): Row | undefined;
    };
  }

  #transaction<T>(operation: () => T): T {
    if (this.shared) return this.shared.atomic(operation);
    if (this.#inTransaction) return operation();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#inTransaction = true;
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      // SQLite may already have rolled back a failed write or COMMIT.
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* no active transaction */
      }
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  publish(workflow: PublishedWorkflow['workflow']) {
    return this.#transaction(() => {
      this.validateTargets(workflow);
      const revision = Number(
        this.#prepare('SELECT COALESCE(MAX(revision),0)+1 AS next FROM publications WHERE workflowId=?').get(
          workflow.id,
        )!.next,
      );
      this.#prepare('INSERT INTO publications VALUES(?,?,?)').run(
        workflow.id,
        revision,
        JSON.stringify(workflow),
      );
      return revision;
    });
  }

  publication(id: string, revision: number): PublishedWorkflow {
    const row = this.#prepare('SELECT document FROM publications WHERE workflowId=? AND revision=?').get(
      id,
      revision,
    );
    if (!row) throw new Error(`Unknown publication ${id}@${revision}`);
    return { revision, workflow: JSON.parse(String(row.document)) };
  }

  private validateTargets(root: Workflow) {
    validateCompensations(root, (id, rev) => this.publication(id, rev).workflow);
    const visit = (workflow: Workflow, ancestors: string[]) => {
      for (const node of workflow.nodes) {
        if (
          node.type === 'draflow.httpRequest' &&
          node.parameters.allowRedrive === true &&
          (node.typeVersion !== 2 ||
            !['manual', 'keyed'].includes(String(node.parameters.delivery)) ||
            !Number.isSafeInteger(node.parameters.redriveRetentionMs ?? 604800000) ||
            Number(node.parameters.redriveRetentionMs ?? 604800000) < 1)
        )
          throw new Error('Redrive requires recorded HTTP v2 and positive retention');
        if (node.disabled || !['draflow.call', 'draflow.pages'].includes(node.type)) continue;
        if (node.type === 'draflow.pages') pageConfig(node);
        const { workflowId, revision } = node.parameters;
        if (
          typeof workflowId !== 'string' ||
          typeof revision !== 'number' ||
          !Number.isSafeInteger(revision) ||
          revision < 1
        )
          throw new Error('Expected a child workflow ID and exact revision');
        if (ancestors.includes(workflowId) || ancestors.length > this.maxCallDepth)
          throw new Error('Recursive or too deep subworkflow');
        const child = this.publication(workflowId, revision).workflow;
        if (
          child.nodes.some(
            (n) =>
              !n.disabled &&
              (compensationSpec(n) ||
                (n.type === 'draflow.httpRequest' && n.parameters.allowRedrive === true) ||
                (n.type === 'draflow.pages' && pageConfig(n).recoverable)),
          )
        )
          throw new Error('Recoverable steps must belong to a root workflow');
        const entries = child.nodes.filter((n) => !n.disabled && n.type === 'draflow.childInput');
        const returns = child.nodes.filter((n) => !n.disabled && n.type === 'draflow.return');
        const callers = entries[0]?.parameters.callers;
        if (
          entries.length !== 1 ||
          returns.length !== 1 ||
          !Array.isArray(callers) ||
          !callers.includes(workflow.id)
        )
          throw new Error('Child requires one callable entry, caller permission and one return');
        if (child.connections.some((c) => c.from.node === returns[0]!.id))
          throw new Error('Return must be terminal');
        if (!hasPath(buildGraph(child), entries[0]!.id, returns[0]!.id))
          throw new Error('Return must be reachable from the callable entry');
        if (node.type === 'draflow.pages' && pageConfig(node).recoverable) {
          const write = child.nodes.find((n) => n.type === 'draflow.httpRequest' && n.typeVersion === 2);
          if (
            node.parameters.syncScope &&
            write?.parameters.delivery === 'keyed' &&
            node.parameters.keyLifetimeMs === undefined
          )
            throw new Error('Configure the receiver key lifetime for incremental keyed delivery');
          const connected = (a: string, b: string) =>
            child.connections.some(
              (e) =>
                e.from.node === a &&
                e.to.node === b &&
                e.from.port === 'main' &&
                e.to.port === 'main' &&
                e.from.index === 0 &&
                e.to.index === 0,
            );
          if (
            !write ||
            write.disabled ||
            !['manual', 'keyed'].includes(String(write.parameters.delivery)) ||
            Object.keys(child.pinData ?? {}).length > 0 ||
            child.nodes.length !== 3 ||
            child.connections.length !== 2 ||
            !connected(entries[0]!.id, write.id) ||
            !connected(write.id, returns[0]!.id) ||
            child.nodes.some((n) => n.settings?.onError && n.settings.onError !== 'stop') ||
            (node.settings?.onError && node.settings.onError !== 'stop') ||
            workflow.connections.some((e) => e.from.node === node.id) ||
            workflow.nodes.filter((n) => n.type === 'draflow.pages').length !== 1
          )
            throw new Error(
              'Recoverable pages require a terminal pages node and a direct recorded HTTP child',
            );
        }
        visit(child, [...ancestors, workflowId]);
      }
    };
    visit(root, [root.id]);
  }

  relations(id: string) {
    return this.#prepare(
      `SELECT c.*,p.revision AS parentRevision,k.revision AS childRevision,k.state AS childState
      FROM calls c JOIN runs p ON p.runId=c.parent JOIN runs k ON k.runId=c.child
      WHERE c.parent=? OR c.child=? ORDER BY c.rowid`,
    ).all(id, id);
  }

  #admitChild(id: string, revision: number, payload: string) {
    const entry = this.publication(id, revision).workflow.nodes.find(
      (n) => !n.disabled && n.type === 'draflow.childInput',
    )!;
    const child = randomUUID();
    this.#prepare(
      `INSERT INTO runs(runId,workflowId,revision,triggerNodeId,mode,payload,state,acceptedAt)
      VALUES(?,?,?,?,'subworkflow',?,'queued',?)`,
    ).run(child, id, revision, entry.id, payload, this.#now());
    return child;
  }

  #spawn(parent: Receipt, node: WorkflowNode, visit: number, batch: number, items: Item[]) {
    const id = String(node.parameters.workflowId);
    const revision = Number(node.parameters.revision);
    const child = this.#admitChild(id, revision, JSON.stringify(items));
    if (node.type === 'draflow.pages' && pageConfig(node).scope) {
      const scope = this.syncScope(parent.runId)!;
      const insert = this.#prepare('INSERT INTO syncWork VALUES(?,?,?,?,?,?,NULL)');
      items.forEach(({ json }, i) =>
        insert.run(
          child,
          i,
          String(scope.scope),
          String(json.id),
          Number(json.version),
          pageConfig(node).keyLifetimeMs,
        ),
      );
    }
    this.#prepare('INSERT INTO calls VALUES(?,?,?,?,?)').run(child, parent.runId, node.id, visit, batch);
    this.#prepare("UPDATE runs SET state='waiting' WHERE runId=?").run(parent.runId);
    this.#recordPause(parent.runId);
    return child;
  }

  pendingMode(id: string) {
    return this.#prepare('SELECT mode FROM continuations WHERE runId=? AND response IS NULL').get(id)?.mode;
  }

  dispatchChild(parent: Receipt, node: WorkflowNode) {
    const entry = this.continuation(parent.runId)!.checkpoint.stack[0]!;
    this.#transaction(() => {
      if (this.shared && this.canceled(parent.runId)) return this.#yieldPage(parent.runId);
      this.#spawn(parent, node, entry.runIndex, 0, entry.input.main?.[0] ?? []);
    });
  }

  #yieldPage(id: string) {
    this.#prepare("UPDATE runs SET state='queued' WHERE runId=?").run(id);
    this.#prepare('INSERT OR REPLACE INTO readyAfter SELECT ?,MAX(rowid) FROM runs').run(id);
  }

  canceled(id: string) {
    return !!this.#prepare('SELECT 1 FROM canceledRuns WHERE runId=?').get(id);
  }

  cancelTree(id: string) {
    return this.#transaction(() => {
      const receipt = this.get(id);
      if (!receipt || ['finished', 'interrupted'].includes(receipt.state) || this.canceled(id)) return [];
      const rows = this.#prepare(
        `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL
        SELECT c.child FROM calls c JOIN tree ON c.parent=tree.id)
        SELECT runId,state FROM runs JOIN tree ON runs.runId=tree.id WHERE state NOT IN ('finished','interrupted')`,
      ).all(id);
      for (const row of rows) {
        const run = String(row.runId);
        this.#prepare('INSERT OR IGNORE INTO canceledRuns VALUES(?)').run(run);
        this.#prepare('DELETE FROM syncQueue WHERE runId=?').run(run);
        this.#prepare('UPDATE pageRuns SET retryAt=NULL WHERE runId=?').run(run);
        this.#prepare("INSERT INTO transitions VALUES(?, '', ?, 'cancelRequested')").run(run, this.#now());
        if (row.state === 'waiting') this.#prepare("UPDATE runs SET state='queued' WHERE runId=?").run(run);
      }
      return rows.map((row) => String(row.runId));
    });
  }

  finishCanceled(r: Receipt) {
    // A queued keyed retry still owns an unknown effect. Cancellation suppresses the resend.
    if (this.endJournal(r.runId) === 'review') return;
    const { workflow } = this.publication(r.workflowId, r.revision);
    const saved = this.continuation(r.runId)?.checkpoint;
    const tasks = saved ? executionTasks(saved.runData) : [];
    this.finish(
      r,
      {
        id: r.runId,
        workflowId: r.workflowId,
        workflowName: workflow.name,
        mode: r.mode,
        startedAt: r.startedAt!,
        stoppedAt: this.#now(),
        status: 'canceled',
        executed: tasks.length,
        reused: 0,
      },
      { workflow, tasks },
    );
  }

  throttle(
    id: string,
    node: WorkflowNode,
    visit: number,
    status: number,
    header: string | null,
    now: number,
  ) {
    const state = this.pageState(id, node.id, visit);
    const config = pageConfig(node);
    const attempt = Number(state.attempts) + 1;
    const due = retryTime(header, now, attempt);
    if (attempt >= config.maxAttempts || due >= Number(state.created) + config.deadlineMs)
      return this.pageFailure(id, node.id, visit, 'HTTP ' + status + ' retry budget exhausted');
    this.waitForPage(id, node.id, visit, attempt, due);
  }

  waitForPage(id: string, nodeId: string, visit: number, attempt: number, due: number) {
    this.#transaction(() => {
      if (this.shared && this.canceled(id)) return this.#yieldPage(id);
      this.#prepare('UPDATE pageRuns SET attempts=?,retryAt=? WHERE runId=? AND node=? AND visit=?').run(
        attempt,
        due,
        id,
        nodeId,
        visit,
      );
      this.#prepare("UPDATE runs SET state='waiting' WHERE runId=?").run(id);
      this.#recordPause(id);
    });
  }

  wakeRetries(now: number): number {
    if (this.shared) return this.shared.atomic(() => this.#wakeRetries(now));
    return this.#wakeRetries(now);
  }
  #wakeRetries(now: number) {
    const due = this.#prepare('SELECT runId FROM pageRuns WHERE retryAt<=?').all(now);
    if (due.length)
      this.#transaction(() => {
        for (const row of due) {
          const id = String(row.runId);
          this.#prepare('UPDATE pageRuns SET retryAt=NULL WHERE runId=?').run(id);
          this.#yieldPage(id);
        }
      });
    return due.length;
  }

  syncScope(owner: string) {
    return this.#prepare('SELECT scope,token FROM syncScopes WHERE owner=?').get(owner);
  }

  #nextSync(key: string) {
    const next = this.#prepare('SELECT runId FROM syncQueue WHERE scope=? ORDER BY rowid LIMIT 1').get(key);
    if (!next) return;
    this.#prepare('DELETE FROM syncQueue WHERE runId=?').run(String(next.runId));
    this.#prepare('UPDATE syncScopes SET owner=? WHERE scope=?').run(String(next.runId), key);
    this.#yieldPage(String(next.runId));
  }

  resetSync(workflow: string, node: string, name: string) {
    const key = JSON.stringify([workflow, node, name]);
    return this.#transaction(() => {
      const row = this.#prepare('SELECT owner FROM syncScopes WHERE scope=?').get(key);
      if (!row) throw new Error('Unknown sync scope');
      if (row.owner) {
        const state = this.get(String(row.owner))?.state;
        if (
          (state !== 'finished' && state !== 'interrupted') ||
          this.inspect(String(row.owner)).uncertain.length
        )
          throw new Error('Sync is active or requires reconciliation');
        if (
          this.#prepare(
            `SELECT 1 FROM calls JOIN runs ON child=runId
          WHERE parent=? AND state NOT IN ('finished','interrupted')`,
          ).get(row.owner)
        )
          throw new Error('Child is still active');
      }
      if (row.owner) {
        this.#prepare('DELETE FROM syncWork WHERE child IN (SELECT child FROM calls WHERE parent=?)').run(
          row.owner,
        );
        this.#prepare('UPDATE recoveryPoints SET data=NULL WHERE runId=?').run(row.owner);
      }
      this.#prepare('UPDATE syncScopes SET owner=NULL,candidate=NULL,token=NULL WHERE scope=?').run(key);
      this.#nextSync(key);
      return true;
    });
  }

  pageState(id: string, node: string, visit: number) {
    return this.#prepare('SELECT * FROM pageRuns WHERE runId=? AND node=? AND visit=?').get(id, node, visit)!;
  }

  #canRetryUnsent(id: string, nodeId: string) {
    const receipt = this.get(id)!;
    if (receipt.mode === 'subworkflow')
      return Boolean(
        this.#recoverableParent(id) || this.#prepare('SELECT 1 FROM compensationSteps WHERE child=?').get(id),
      );
    return this.publication(receipt.workflowId, receipt.revision).workflow.nodes.some(
      (n) => n.id === nodeId && (n.parameters.allowRedrive === true || Boolean(n.parameters.compensation)),
    );
  }

  #recoverableParent(child: string) {
    const link = this.#prepare('SELECT parent,node,visit FROM calls WHERE child=?').get(child);
    if (!link) return;
    const parent = this.get(String(link.parent))!;
    const node = this.publication(parent.workflowId, parent.revision).workflow.nodes.find(
      (n) => n.id === link.node,
    )!;
    if (node.type === 'draflow.pages' && pageConfig(node).recoverable)
      return { parent, node, visit: Number(link.visit) };
  }

  // Called inside the failure transaction, before either receipt releases its recovery data.
  #archivePage(parent: Receipt, node: WorkflowNode, visit: number, reason: string, child?: Receipt) {
    if (parent.mode === 'subworkflow' || this.canceled(parent.runId) || !pageConfig(node).recoverable) return;
    const id = parent.runId;
    const config = pageConfig(node);
    this.#purgeRecovery();
    const snapshot = {
      point: this.#prepare('SELECT checkpoint FROM continuations WHERE runId=?').get(id)?.checkpoint,
      page: this.pageState(id, node.id, visit),
      cursors: this.#prepare('SELECT digest FROM seenCursors WHERE runId=? AND node=? AND visit=?').all(
        id,
        node.id,
        visit,
      ),
      wave: this.#prepare('SELECT * FROM parallelWork WHERE parent=? ORDER BY start').all(id),
      payload: child && this.#prepare('SELECT payload FROM runs WHERE runId=?').get(child.runId)?.payload,
      effects:
        child &&
        this.#prepare("SELECT key,result FROM effects WHERE runId=? AND state='success'").all(child.runId),
    };
    this.#prepare('INSERT INTO recoveryPoints VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL)').run(
      randomUUID(),
      id,
      node.id,
      visit,
      child?.runId ?? null,
      reason,
      this.#now() + config.retention,
      JSON.stringify(snapshot),
    );
  }

  #archiveHttp(receipt: Receipt, detail: ExecutionDetail) {
    if (receipt.mode === 'subworkflow' || this.canceled(receipt.runId)) return;
    const failed = detail.tasks.at(-1);
    if (failed?.task?.status !== 'error') return;
    const node = detail.workflow.nodes.find((n) => n.id === failed.nodeId);
    if (node?.type !== 'draflow.httpRequest' || node.parameters.allowRedrive !== true) return;
    const point = this.#prepare("SELECT checkpoint FROM continuations WHERE runId=? AND mode='effect'").get(
      receipt.runId,
    );
    if (!point) return;
    const entry = (JSON.parse(String(point.checkpoint)) as Checkpoint).stack[0]!;
    if (entry.nodeId !== node.id || entry.runIndex !== failed.task.runIndex) return;
    this.#purgeRecovery();
    const effects = this.#prepare(
      "SELECT key,result FROM effects WHERE runId=? AND nodeId=? AND visit=? AND state='success'",
    ).all(receipt.runId, node.id, entry.runIndex);
    this.#prepare('INSERT INTO recoveryPoints VALUES(?,?,?,?,NULL,?,?,?,NULL,NULL,NULL)').run(
      randomUUID(),
      receipt.runId,
      node.id,
      entry.runIndex,
      detail.error?.message ?? 'Recorded HTTP failed',
      this.#now() + Number(node.parameters.redriveRetentionMs ?? 604800000),
      JSON.stringify({ point: point.checkpoint, effects }),
    );
  }

  recoveryInfo(id: string) {
    this.#purgeRecovery();
    return this.#prepare(
      `SELECT runId,failure,node,visit,child,reason,expires,attempt,accepted,outcome,
      data IS NOT NULL AS retained FROM recoveryPoints WHERE runId=? OR attempt=? ORDER BY rowid`,
    ).all(id, id);
  }

  #purgeRecovery() {
    const cutoff = this.#now();
    this.#prepare('UPDATE recoveryPoints SET data=NULL WHERE data IS NOT NULL AND expires<=?').run(cutoff);
  }

  redrive(id: string, failure: string, now: number) {
    this.#purgeRecovery();
    return this.#transaction(() => {
      const point = this.#prepare('SELECT * FROM recoveryPoints WHERE runId=? AND failure=?').get(
        id,
        failure,
      );
      if (!point) {
        if (this.canceled(id)) throw new Error('Canceled run cannot be redriven');
        if (this.inspect(id).uncertain.length) throw new Error('Reconcile uncertain sends before redrive');
        throw new Error('No safe redrive point for this failure');
      }
      if (point.attempt) return String(point.attempt);
      const r = this.get(id)!;
      if (this.#prepare('SELECT 1 FROM compensations WHERE root=?').get(id))
        throw new Error('Compensation has started');
      if (!point.data) throw new Error('Redrive data expired or invalidated');
      if (r.state !== 'finished' || r.outcome !== 'error' || this.canceled(id))
        throw new Error('Only an uncanceled, failed run can be redriven');
      const node = this.publication(r.workflowId, r.revision).workflow.nodes.find(
        (n) => n.id === point.node,
      )!;
      if (node.type === 'draflow.pages' && pageConfig(node).scope && !this.syncScope(id))
        throw new Error('Sync scope was reset');
      const saved = JSON.parse(String(point.data)) as {
        point: string;
        wave?: {
          child: string;
          start: number;
          length: number;
          baseTotal: number;
          status: string;
          retryData: string | null;
        }[];
        page: { cursor: string | null; next: string | null; rows: string | null };
        cursors: { digest: string }[];
        payload?: string;
        effects?: { key: string; result: string }[];
      };
      const child = point.child;
      if (node.type === 'draflow.pages') {
        this.#prepare(
          `UPDATE pageRuns SET error=NULL,attempts=0,created=?,retryAt=NULL,cursor=?,next=?,rows=?
        WHERE runId=? AND node=? AND visit=?`,
        ).run(now, saved.page.cursor, saved.page.next, saved.page.rows, id, node.id, Number(point.visit));
        const seen = this.#prepare('INSERT OR IGNORE INTO seenCursors VALUES(?,?,?,?)');
        for (const row of saved.cursors) seen.run(id, node.id, Number(point.visit), row.digest);
      }
      const mode = node.type === 'draflow.pages' ? 'pages' : 'effect';
      this.#prepare("INSERT INTO continuations VALUES(?,?,'',?,0,NULL)").run(id, saved.point, mode);
      const reopen = this.#prepare(
        'UPDATE runs SET state=?,payload=?,startedAt=NULL,stoppedAt=NULL,outcome=NULL WHERE runId=?',
      );
      const wave = saved.wave ?? [];
      reopen.run(child || wave.length ? 'waiting' : 'queued', '[]', id);
      for (const part of wave) {
        const failed = part.status === 'failed';
        this.#prepare('INSERT INTO parallelWork VALUES(?,?,?,?,?,?,NULL,NULL)').run(
          part.child,
          id,
          part.start,
          part.length,
          part.baseTotal,
          failed ? 'pending' : 'success',
        );
        if (failed) {
          const retry = JSON.parse(part.retryData!) as {
            payload: string;
            effects: { key: string; result: string }[];
          };
          for (const e of retry.effects)
            this.#prepare('UPDATE effects SET result=? WHERE key=?').run(e.result, e.key);
          reopen.run('queued', retry.payload, part.child);
        }
      }
      for (const effect of saved.effects ?? [])
        this.#prepare('UPDATE effects SET result=? WHERE key=?').run(effect.result, effect.key);
      if (child) {
        // Re-enter only the validated input -> recorded HTTP -> return child. Keep its operation keys.
        reopen.run('queued', saved.payload!, child);
      }
      const attempt = randomUUID();
      this.#prepare('UPDATE recoveryPoints SET data=NULL,attempt=?,accepted=? WHERE failure=?').run(
        attempt,
        this.#now(),
        failure,
      );
      this.#prepare("INSERT INTO transitions VALUES(?,?,?,'redrive')").run(id, node.id, this.#now());
      return attempt;
    });
  }

  pageFailure(id: string, node: string, visit: number, error: string) {
    this.#transaction(() => {
      const parent = this.get(id)!;
      const target = this.publication(parent.workflowId, parent.revision).workflow.nodes.find(
        (n) => n.id === node,
      )!;
      if (pageConfig(target).scope && error === 'HTTP 410')
        error = 'HTTP 410: sync token expired; resetSync required';
      else this.#archivePage(parent, target, visit, error);
      this.#prepare(
        'UPDATE pageRuns SET error=?,cursor=NULL,next=NULL,rows=NULL,retryAt=NULL WHERE runId=? AND node=? AND visit=?',
      ).run(error, id, node, visit);
      this.#resume(id, { reason: 'result', data: {}, failure: error });
    });
  }

  savePage(parent: Receipt, node: WorkflowNode, visit: number, page: Awaited<ReturnType<typeof readPage>>) {
    const id = parent.runId,
      config = pageConfig(node);
    const state = this.pageState(id, node.id, visit);
    if (
      Number(state.items) + Number(state.skipped) + page.rows.length > config.maxItems ||
      Number(state.bytes) + page.bytes > config.maxBytes
    )
      return this.pageFailure(id, node.id, visit, 'Page item or byte limit exceeded');
    if (
      page.next !== null &&
      this.#prepare('SELECT 1 FROM seenCursors WHERE runId=? AND node=? AND visit=? AND digest=?').get(
        id,
        node.id,
        visit,
        createHash('sha256').update(page.next).digest('hex'),
      )
    )
      return this.pageFailure(id, node.id, visit, 'Repeated page cursor');
    const scope = config.scope ? this.syncScope(id) : undefined;
    let rows = page.rows;
    if (scope) {
      const versions = new Map<string, number>();
      const last = this.#prepare('SELECT version FROM syncVersions WHERE scope=? AND entity=?');
      rows = rows.filter((row) => {
        const entity = String(row.id);
        const previous = versions.get(entity) ?? Number(last.get(String(scope.scope), entity)?.version ?? -1);
        if (Number(row.version) <= previous) return false;
        versions.set(entity, Number(row.version));
        return true;
      });
    }
    if (
      config.sumField &&
      !Number.isFinite(rows.reduce((sum, row) => sum + Number(row[config.sumField]), Number(state.total)))
    )
      return this.pageFailure(id, node.id, visit, 'Page total exceeds numeric range');
    this.#transaction(() => {
      if (scope) this.#prepare('UPDATE syncScopes SET candidate=? WHERE owner=?').run(page.token, id);
      if (page.next !== null) {
        const digest = createHash('sha256').update(page.next).digest('hex');
        this.#prepare('INSERT INTO seenCursors VALUES(?,?,?,?)').run(id, node.id, visit, digest);
      }
      this.#prepare(
        'UPDATE pageRuns SET rows=?,next=?,offset=0,bytes=bytes+?,skipped=skipped+?,attempts=0,retryAt=NULL WHERE runId=? AND node=? AND visit=?',
      ).run(JSON.stringify(rows), page.next, page.bytes, page.rows.length - rows.length, id, node.id, visit);
    });
  }

  batch(parent: Receipt, node: WorkflowNode, visit: number) {
    const state = this.pageState(parent.runId, node.id, visit);
    const rows = JSON.parse(String(state.rows)) as JsonObject[];
    const offset = Number(state.offset);
    this.#transaction(() => {
      if (this.shared && this.canceled(parent.runId)) return this.#yieldPage(parent.runId);
      if (offset === rows.length) this.#advancePage(parent.runId, node, visit);
      else if (pageConfig(node).concurrency > 1) {
        const { concurrency, batchSize, orderKey } = pageConfig(node);
        const keys = new Set<unknown>();
        for (let i = 0; i < concurrency && offset + i * batchSize < rows.length; i++) {
          const start = offset + i * batchSize;
          const slice = rows.slice(start, start + batchSize);
          if (orderKey && slice.some((row) => keys.has(row[orderKey]))) break;
          if (orderKey) for (const row of slice) keys.add(row[orderKey]);
          const child = this.#spawn(
            parent,
            node,
            visit,
            Number(state.batches) + i,
            slice.map((json) => ({ json })),
          );
          this.#prepare("INSERT INTO parallelWork VALUES(?,?,?,?,?,'pending',NULL,NULL)").run(
            child,
            parent.runId,
            start,
            slice.length,
            Number(state.total),
          );
        }
      } else
        this.#spawn(
          parent,
          node,
          visit,
          Number(state.batches),
          rows.slice(offset, offset + pageConfig(node).batchSize).map((json) => ({ json })),
        );
    });
  }

  #advancePage(id: string, node: WorkflowNode, visit: number) {
    this.#prepare(
      `UPDATE pageRuns SET pages=pages+1,cursor=next,next=NULL,rows=NULL,offset=0
      WHERE runId=? AND node=? AND visit=?`,
    ).run(id, node.id, visit);
    const s = this.pageState(id, node.id, visit);
    if (this.canceled(id)) return;
    if (s.cursor === null && node.parameters.syncScope) {
      const scope = this.syncScope(id)!;
      this.#prepare('UPDATE syncScopes SET token=candidate,candidate=NULL,owner=NULL WHERE owner=?').run(id);
      this.#nextSync(String(scope.scope));
    }
    if (s.cursor === null)
      this.#resume(id, {
        reason: 'result',
        data: {},
        items: [
          {
            json: {
              pages: Number(s.pages),
              batches: Number(s.batches),
              items: Number(s.items),
              total: Number(s.total),
            },
          },
        ],
      });
    else this.#yieldPage(id);
  }

  #batchDone(id: string, node: WorkflowNode, visit: number, response: WaitResult) {
    if (response.failure) {
      this.#prepare(
        'UPDATE pageRuns SET error=?,rows=NULL,next=NULL,cursor=NULL WHERE runId=? AND node=? AND visit=?',
      ).run(response.failure, id, node.id, visit);
      this.#resume(id, response);
      return;
    }
    const state = this.pageState(id, node.id, visit);
    const rows = JSON.parse(String(state.rows)) as JsonObject[];
    const { batchSize, sumField } = pageConfig(node);
    const offset = Number(state.offset);
    const batch = rows.slice(offset, offset + batchSize);
    const prior = Number(state.total);
    const total = sumField ? batch.reduce((sum, row) => sum + Number(row[sumField]), prior) : prior;
    this.#prepare(
      'UPDATE pageRuns SET offset=offset+?,items=items+?,batches=batches+1,total=? WHERE runId=? AND node=? AND visit=?',
    ).run(batch.length, batch.length, total, id, node.id, visit);
    if (offset + batch.length === rows.length) this.#advancePage(id, node, visit);
    else if (!this.canceled(id)) this.#yieldPage(id);
  }

  inspect(id: string) {
    const uncertain = this.#prepare(
      `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT c.child
      FROM calls c JOIN tree t ON c.parent=t.id) SELECT e.runId,e.nodeId,e.visit,e.item,e.key
      FROM effects e JOIN tree t ON e.runId=t.id WHERE e.state='unknown'`,
    ).all(id);
    const waiting = this.#prepare(
      'SELECT s.owner FROM syncQueue q JOIN syncScopes s ON s.scope=q.scope WHERE q.runId=?',
    ).get(id);
    return {
      pages: this.progress(id),
      calls: this.relations(id),
      uncertain,
      canceled: this.canceled(id),
      ...(waiting && { waitingForSyncRun: waiting.owner }),
    };
  }

  progress(id: string) {
    return this.#prepare(
      `SELECT node,visit,pages,batches,items,total,bytes,offset,error,retryAt,attempts
      FROM pageRuns WHERE runId=? ORDER BY rowid`,
    ).all(id);
  }

  #resume(id: string, response: WaitResult) {
    this.#prepare("UPDATE continuations SET mode='dispatch',response=? WHERE runId=?").run(
      JSON.stringify(response),
      id,
    );
    this.#prepare("UPDATE runs SET state='queued' WHERE runId=?").run(id);
  }

  #eligibleRun(lane: 'business' | 'ordinary' | 'all') {
    return !this.#businessEnabled || lane === 'all'
      ? ''
      : `AND ${lane === 'ordinary' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM business_receipts b WHERE b.run=r.runId)`;
  }

  requiredPublications(lane: 'business' | 'ordinary' | 'all') {
    return this.#prepare(
      `${lane === 'business' ? '' : 'SELECT workflowId, revision FROM active UNION'}
       SELECT DISTINCT r.workflowId, r.revision FROM runs r
       WHERE r.state IN ('queued','waiting','review') ${this.#eligibleRun(lane)}`,
    ).all();
  }

  activate(
    id: string,
    revision: number,
    routes: { path: string; triggerNodeId: string }[],
    schedules: { triggerNodeId: string; spec: Schedule; nextAt: number }[],
    prepareTimer: () => void,
  ) {
    return this.#transaction(() => {
      if (this.#prepare('SELECT 1 FROM webhookTestDocuments WHERE workflowId=?').get(id))
        throw new Error('Cannot activate a test snapshot');
      if (this.#prepare('SELECT revision FROM active WHERE workflowId=?').get(id)?.revision === revision)
        return false;
      this.#prepare('DELETE FROM webhookRoutes WHERE workflowId=?').run(id);
      this.#prepare(
        'INSERT INTO active(workflowId,revision,registration) VALUES(?,?,?) ON CONFLICT(workflowId) DO UPDATE SET revision=excluded.revision,registration=excluded.registration',
      ).run(id, revision, randomUUID());
      this.#prepare('DELETE FROM schedules WHERE workflowId=?').run(id);
      for (const schedule of schedules) {
        this.#prepare('INSERT INTO schedules VALUES(?,?,?,?)').run(
          id,
          schedule.triggerNodeId,
          JSON.stringify(schedule.spec),
          schedule.nextAt,
        );
      }
      for (const route of routes) {
        if (this.#prepare('SELECT 1 FROM webhookRoutes WHERE path=?').get(route.path)) {
          throw new Error('Webhook route already registered: ' + route.path);
        }
        this.#prepare('INSERT INTO webhookRoutes VALUES(?,?,?)').run(route.path, id, route.triggerNodeId);
      }
      prepareTimer();
      return true;
    });
  }

  nextScheduleTime() {
    const value = this.#prepare(
      `SELECT MIN(t) AS time FROM (
      SELECT MIN(nextAt) t FROM schedules UNION ALL
      SELECT MIN(retryAt) FROM pageRuns UNION ALL
      SELECT MIN(dueAt) FROM continuations WHERE mode IN ('event','time') AND response IS NULL) AS times`,
    ).get()!.time;
    return value === null ? undefined : Number(value);
  }

  dueSchedules(now: number) {
    return this.#prepare('SELECT * FROM schedules WHERE nextAt<=? ORDER BY nextAt,workflowId,triggerNodeId')
      .all(now)
      .map((row) => ({
        workflowId: String(row.workflowId),
        triggerNodeId: String(row.triggerNodeId),
        spec: JSON.parse(String(row.spec)) as Schedule,
        nextAt: Number(row.nextAt),
      }));
  }

  acceptSchedule(
    id: string,
    trigger: string,
    scheduledAt: number,
    nextAt: number,
    capacity: number,
    expected?: { nextAt: number; spec: Schedule },
  ): string | undefined {
    if (this.shared && expected !== undefined)
      return this.shared.atomic(() => {
        if (
          this.#prepare(
            'SELECT 1 FROM schedules WHERE workflowId=? AND triggerNodeId=? AND nextAt=? AND spec=?',
          ).get(id, trigger, expected.nextAt, JSON.stringify(expected.spec)) === undefined
        )
          return;
        return this.acceptSchedule(id, trigger, scheduledAt, nextAt, capacity);
      });
    const stamp = new Date(scheduledAt).toISOString();
    return this.accept(
      id,
      trigger,
      { key: stamp, items: [{ json: { scheduledAt: stamp } }] },
      capacity,
      null,
      () => {
        // Moving the cursor and admitting its work either both commit or both roll back.
        this.#prepare('UPDATE schedules SET nextAt=? WHERE workflowId=? AND triggerNodeId=?').run(
          nextAt,
          id,
          trigger,
        );
      },
    );
  }

  registerTestWebhook(
    path: string,
    workflow: PublishedWorkflow['workflow'],
    triggerNodeId: string,
    expiresAt: number,
  ) {
    this.#transaction(() => {
      this.validateTargets(workflow);
      this.#prepare('DELETE FROM testWebhooks WHERE expiresAt<=?').run(this.#now());
      this.#prepare('INSERT INTO testWebhooks VALUES(?,?,1,?,?,?)').run(
        path,
        workflow.id,
        triggerNodeId,
        expiresAt,
        JSON.stringify(workflow),
      );
    });
  }

  webhook(path: string) {
    const row = this.#prepare(
      `SELECT workflowId,revision,triggerNodeId,registration FROM webhookRoutes JOIN active USING(workflowId) WHERE path=?
      UNION ALL SELECT workflowId,revision,triggerNodeId,workflowId FROM testWebhooks WHERE path=? AND expiresAt>?`,
    ).get(path, path, this.#now());
    return (
      row && {
        registration: String(row.registration),
        workflowId: String(row.workflowId),
        revision: Number(row.revision),
        triggerNodeId: String(row.triggerNodeId),
      }
    );
  }
  deactivate(id: string, prepareTimer: () => void) {
    return this.#transaction(() => {
      const deleted = this.#prepare('DELETE FROM active WHERE workflowId=?').run(id);
      if (!deleted.changes) return false;
      prepareTimer();
      return true;
    });
  }

  isBusinessRun(id: string) {
    return !!this.#prepare('SELECT 1 FROM business_receipts WHERE run=?').get(id);
  }

  acceptBusiness(
    d: BusinessDelivery,
    capacity: number,
    publish: (workflow: PublishedWorkflow['workflow']) => number,
  ) {
    const descriptor = describeDelivery(d);
    return this.#transaction(() => {
      const prior = this.#prepare('SELECT fingerprint,run FROM business_receipts WHERE delivery=?').get(
        descriptor.key,
      );
      if (prior) {
        if (prior.fingerprint !== descriptor.fingerprint) throw Error('Business delivery conflict');
        return String(prior.run);
      }
      const stored = this.#prepare('SELECT revision FROM business_publications WHERE workflow=?').get(
        descriptor.workflow,
      );
      const revision = stored ? Number(stored.revision) : publish(descriptor.document);
      if (!stored)
        this.#prepare('INSERT INTO business_publications VALUES(?,?)').run(descriptor.workflow, revision);
      const run = this.accept(
        descriptor.workflow,
        'event',
        {
          items: [
            {
              json: {
                organization: d.organization,
                event: d.event,
                rule: d.rule,
                project: d.project,
                revision: d.revision,
              },
            },
          ],
        },
        capacity,
        0,
        () => {},
        revision,
      );
      this.#prepare('INSERT INTO business_receipts VALUES(?,?,?)').run(
        descriptor.key,
        descriptor.fingerprint,
        run,
      );
      return run;
    });
  }

  accept(
    id: string,
    trigger: string,
    event: Omit<TriggerEvent, 'runId'>,
    capacity: number,
    ttl: number | null,
    validate: (revision: number) => void,
    pinnedRevision?: number,
  ): string {
    return this.#transaction(() => {
      const selected =
        pinnedRevision ?? this.#prepare('SELECT revision FROM active WHERE workflowId=?').get(id)?.revision;
      if (selected == null) throw new Error(`Inactive workflow: ${id}`);
      const revision = Number(selected);
      validate(revision);
      const now = this.#now();
      const source: DeliverySource =
        ttl === null ? 'schedule' : event.mode === 'webhook' ? 'webhook' : 'trigger';
      if (event.key !== undefined) {
        const existing = this.#prepare(
          `SELECT d.runId FROM deliveries d JOIN runs USING(runId)
          WHERE d.workflowId=? AND d.triggerNodeId=? AND d.eventKey=? AND d.source=?
          AND (d.expiresAt=? OR d.expiresAt>? OR runs.state IN ('queued','running','waiting','review','interrupted'))`,
        ).get(id, trigger, event.key, source, noExpiry, now);
        if (existing) return String(existing.runId);
      }
      if (Number(this.#prepare("SELECT COUNT(*) AS n FROM runs WHERE state='queued'").get()!.n) >= capacity) {
        throw new QueueFull();
      }
      const runId = randomUUID();
      // The queued ledger row is the work item. Neither record can exist alone.
      this.#prepare(
        `INSERT INTO runs(runId,workflowId,revision,triggerNodeId,eventKey,mode,payload,state,acceptedAt)
        VALUES(?,?,?,?,?,?,?,'queued',?)`,
      ).run(
        runId,
        id,
        revision,
        trigger,
        event.key ?? null,
        event.mode ?? 'trigger',
        JSON.stringify(event.items),
        now,
      );
      if (event.key !== undefined) {
        this.#prepare(
          'INSERT OR REPLACE INTO deliveries(workflowId,triggerNodeId,eventKey,source,expiresAt,runId) VALUES(?,?,?,?,?,?)',
        ).run(id, trigger, event.key, source, ttl === null ? noExpiry : now + ttl, runId);
      }
      return runId;
    });
  }

  get(run: string): Receipt | undefined {
    return this.#prepare(`SELECT ${fields} FROM runs WHERE runId=?`).get(run) as unknown as
      | Receipt
      | undefined;
  }

  byEvent(workflowId: string, triggerNodeId: string, eventKey: string, source?: DeliverySource) {
    const delivery = this.#prepare(
      `SELECT runId FROM deliveries WHERE workflowId=? AND triggerNodeId=? AND eventKey=?
        AND (? IS NULL OR source=?) ORDER BY rowid DESC LIMIT 1`,
    ).get(workflowId, triggerNodeId, eventKey, source ?? null, source ?? null);
    return delivery && this.get(String(delivery.runId));
  }

  /** Called inside the admission transaction, so rejected test requests leave no durable draft. */
  retainTestSnapshot(path: string, id: string) {
    if (this.#prepare('SELECT 1 FROM webhookTestDocuments WHERE workflowId=?').get(id)) return;
    this.#prepare(
      `INSERT INTO publications(workflowId,revision,document)
      SELECT workflowId,revision,document FROM testWebhooks WHERE path=? AND workflowId=?`,
    ).run(path, id);
    this.#prepare('INSERT INTO webhookTestDocuments VALUES(?)').run(id);
  }

  parallelChild(id: string) {
    return !!this.#prepare('SELECT 1 FROM parallelWork WHERE child=?').get(id);
  }

  latestCooldown() {
    return Number(this.#prepare('SELECT MAX(untilMs) AS latest FROM rateLimits').get()?.latest ?? 0);
  }

  rateLimit(target: string) {
    return Number(this.#prepare('SELECT untilMs FROM rateLimits WHERE target=?').get(target)?.untilMs ?? 0);
  }

  holdRate(target: string, until: number) {
    this.#prepare(
      'INSERT INTO rateLimits VALUES(?,?) ON CONFLICT(target) DO UPDATE SET untilMs=max(untilMs,excluded.untilMs)',
    ).run(target, until);
  }

  claim(allowParallel = true, batchLimit = 4, lane: 'business' | 'ordinary' | 'all' = 'all') {
    return this.#transaction(() => {
      if (this.shared) {
        const active = this.#prepare("SELECT count(*) AS n FROM runs WHERE state='running'").get()!;
        if (Number(active.n) >= (this.shared.options.maxActiveRuns ?? 32)) return;
        const batches = this.#prepare(
          `SELECT count(*) AS n FROM calls c JOIN runs r ON r.runId=c.child
          JOIN pageRuns p ON p.runId=c.parent AND p.node=c.node AND p.visit=c.visit WHERE r.state='running'`,
        ).get()!;
        allowParallel = allowParallel && Number(batches.n) < batchLimit;
      }
      const next = this.#prepare(
        `SELECT r.runId,r.payload FROM runs r LEFT JOIN readyAfter y ON r.runId=y.runId
         WHERE r.state='queued' ${this.#eligibleRun(lane)} AND (? OR NOT EXISTS(
           SELECT 1 FROM calls c JOIN pageRuns p ON p.runId=c.parent AND p.node=c.node AND p.visit=c.visit
           WHERE c.child=r.runId))
         AND NOT EXISTS(SELECT 1 FROM parallelWork w JOIN runs k ON k.runId=w.child
           WHERE w.parent=r.runId AND w.status='pending' AND k.state IN ('running','queued'))
         ORDER BY COALESCE(y.cutoff,r.rowid),y.cutoff IS NOT NULL,r.rowid LIMIT 1`,
      ).get(Number(allowParallel));
      if (!next) return;
      const id = String(next.runId);
      this.#prepare('DELETE FROM readyAfter WHERE runId=?').run(id);
      this.#prepare("UPDATE runs SET state='running',startedAt=COALESCE(startedAt,?) WHERE runId=?").run(
        this.#now(),
        id,
      );
      // Mark only new claims. Older running rows with a consumed wait could already
      // have entered an untracked node under the previous execution contract.
      this.#prepare(
        "UPDATE continuations SET mode='dispatch' WHERE runId=? AND mode IN ('event','time') AND response IS NOT NULL",
      ).run(id);
      return {
        generation: this.shared?.acquire(id),
        receipt: this.get(id)!,
        items: JSON.parse(String(next.payload)) as TriggerEvent['items'],
      };
    });
  }

  continuation(id: string) {
    const row = this.#prepare('SELECT checkpoint,response FROM continuations WHERE runId=?').get(id);
    if (!row) return;
    return {
      checkpoint: JSON.parse(String(row.checkpoint)) as Checkpoint,
      ...(row.response && { resume: JSON.parse(String(row.response)) as WaitResult }),
    };
  }

  beginJournal(state: Checkpoint, mode: 'keyed' | 'manual', spec?: CompensationSpec): JournalItem {
    const json = encodeCheckpoint(state);
    const { runId } = state;
    const { nodeId, runIndex, input } = state.stack[0]!;
    this.#transaction(() => {
      this.#prepare("INSERT OR REPLACE INTO continuations VALUES(?,?, '', 'effect',0,NULL)").run(runId, json);
      const reserve = this.#prepare("INSERT OR IGNORE INTO effects VALUES(?,?,?,?,?,'',?,'unsent',NULL)");
      const count = input.main?.[0]?.length ?? 0;
      for (let index = 0; index < count; index++) {
        reserve.run(runId, nodeId, runIndex, index, randomUUID(), mode);
        const item = input.main![0]![index]!.json;
        if (spec && (!spec.when || item[spec.when.field] === spec.when.equals)) {
          this.#prepare(
            `INSERT OR IGNORE INTO compensationSteps(source,root,priority,workflow,revision,auto,input)
            SELECT key,runId,?,?,?,?,? FROM effects WHERE runId=? AND nodeId=? AND visit=? AND item=?`,
          ).run(
            spec.order,
            spec.workflowId,
            spec.revision,
            Number(spec.onFailure === true),
            JSON.stringify(item),
            runId,
            nodeId,
            runIndex,
            index,
          );
        }
      }
    });
    return async (index, request, send) => {
      const operation = this.#prepare(
        'SELECT * FROM effects WHERE runId=? AND nodeId=? AND visit=? AND item=?',
      ).get(runId, nodeId, runIndex, index);
      if (!operation) throw new Error('Unknown recorded item');
      if (operation.state === 'success') return JSON.parse(String(operation.result)) as JsonObject;
      const fingerprint = createHash('sha256').update(request).digest('hex');
      if (operation.state === 'unknown' && (operation.fingerprint !== fingerprint || mode === 'manual'))
        throw new Error('External result requires reconciliation');
      const key = String(operation.key);
      this.#prepare("UPDATE effects SET state='unknown', fingerprint=? WHERE key=?").run(fingerprint, key);
      const change = this.#prepare('SELECT firstSend,lifetime FROM syncWork WHERE child=? AND item=?').get(
        runId,
        index,
      );
      let result: JsonObject;
      try {
        let deferred = false;
        let dispatched = false;
        result = await recordedTransport.run(
          {
            defer: () => {
              // A previous uncertain attempt must remain available for reconciliation.
              if (operation.state !== 'unsent' || deferred || dispatched) return;
              this.#prepare("UPDATE effects SET state='unsent' WHERE key=?").run(key);
              deferred = true;
            },
            dispatch: () => {
              const recordDispatch = () => {
                if (change) {
                  const now = this.#now();
                  if (change.firstSend != null && now >= Number(change.firstSend) + Number(change.lifetime))
                    throw new Error('Receiver key expired; reconcile before retry');
                  if (change.firstSend == null)
                    this.#prepare('UPDATE syncWork SET firstSend=? WHERE child=? AND item=?').run(
                      now,
                      runId,
                      index,
                    );
                }
                if (deferred) this.#prepare("UPDATE effects SET state='unknown' WHERE key=?").run(key);
              };
              if (deferred && change) this.#transaction(recordDispatch);
              else recordDispatch();
              dispatched = true;
            },
          },
          () => send(key),
        );
      } catch (error) {
        // An earlier attempt may have reached the receiver even if this attempt never left the host.
        if (
          operation.state === 'unsent' &&
          error instanceof UnsentCredentialError &&
          this.#canRetryUnsent(runId, nodeId)
        )
          this.#prepare("UPDATE effects SET state='unsent' WHERE key=?").run(key);
        throw error;
      }
      this.#prepare("UPDATE effects SET state='success',result=? WHERE key=? AND state='unknown'").run(
        JSON.stringify(result),
        key,
      );
      return result;
    };
  }

  endJournal(id: string) {
    if (this.#prepare("SELECT 1 FROM effects WHERE runId=? AND state='unknown'").get(id)) {
      this.#transaction(() => {
        this.#prepare("UPDATE runs SET state='review' WHERE runId=?").run(id);
        this.#recordPause(id);
      });
      return 'review' as const;
    }
    return 'complete' as const;
  }

  leaveCheckpoint(id: string) {
    this.#prepare('DELETE FROM continuations WHERE runId=?').run(id);
  }

  effects(id: string) {
    return this.#prepare(
      'SELECT nodeId,visit,item,key,mode,state FROM effects WHERE runId=? ORDER BY rowid',
    ).all(id);
  }

  reconcile(id: string, key: string, decision: Reconciliation, result: JsonObject) {
    if (!['applied', 'notApplied', 'retryKeyed'].includes(decision))
      throw new Error('Invalid reconciliation');
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > 1024 * 1024) throw new Error('Reconciliation data exceeds 1 MiB');
    return this.#transaction(() => {
      if (this.get(id)?.state !== 'review') return false;
      const op = this.#prepare(
        "SELECT mode,item FROM effects WHERE runId=? AND key=? AND state='unknown'",
      ).get(id, key);
      if (!op || (decision === 'retryKeyed' && (op.mode !== 'keyed' || this.canceled(id)))) return false;
      const change = this.#prepare('SELECT firstSend,lifetime FROM syncWork WHERE child=? AND item=?').get(
        id,
        Number(op.item),
      );
      if (
        decision === 'retryKeyed' &&
        change?.firstSend != null &&
        this.#now() >= Number(change.firstSend) + Number(change.lifetime)
      )
        return false;
      if (decision === 'notApplied' && change)
        this.#prepare('UPDATE syncWork SET firstSend=NULL WHERE child=? AND item=?').run(id, Number(op.item));
      // A keyed retry keeps the unknown state, original fingerprint and key.
      if (decision !== 'retryKeyed') {
        this.#prepare('UPDATE effects SET state=?,result=? WHERE key=?').run(
          decision === 'applied' ? 'success' : 'unsent',
          decision === 'applied' ? json : null,
          key,
        );
      }
      this.#prepare('INSERT INTO transitions SELECT runId,nodeId,?,? FROM effects WHERE key=?').run(
        this.#now(),
        'reconciled:' + decision,
        key,
      );
      this.#prepare("UPDATE runs SET state='queued' WHERE runId=?").run(id);
      return true;
    });
  }

  waitInfo(id: string) {
    return this.#prepare(
      "SELECT token,mode,dueAt FROM continuations WHERE runId=? AND mode IN ('event','time') AND response IS NULL",
    ).get(id);
  }

  transitions(id: string) {
    return this.#prepare('SELECT nodeId,at,reason FROM transitions WHERE runId=? ORDER BY rowid')
      .all(id)
      .map((row) => ({ nodeId: String(row.nodeId), at: Number(row.at), reason: String(row.reason) }));
  }

  #recordPause(id: string) {
    const r = this.get(id)!;
    const { workflow } = this.publication(r.workflowId, r.revision);
    if (workflow.settings.saveExecutionData && workflow.settings.saveExecutionData !== 'all') return;
    const wait = this.waitInfo(id);
    const tasks = executionTasks(this.continuation(id)!.checkpoint.runData);
    const summary: ExecutionSummary = {
      id,
      workflowId: r.workflowId,
      workflowName: workflow.name,
      mode: r.mode,
      startNodeId: r.triggerNodeId,
      startedAt: r.startedAt!,
      stoppedAt: this.#now(),
      status: 'waiting',
      reused: 0,
      executed: tasks.length,
      waitingFor: wait ? String(wait.mode) : String(this.pendingMode(id) ?? 'reconciliation'),
      ...(wait && { dueAt: Number(wait.dueAt) }),
    };
    this.#append(summary, { workflow, tasks, transitions: this.transitions(id) });
  }

  suspend(state: Checkpoint, request: SuspensionRequest, now: number) {
    const json = encodeCheckpoint(state);
    if (request.mode === 'child' || request.mode === 'return' || request.mode === 'pages') {
      this.#transaction(() => {
        if (this.shared && this.canceled(state.runId)) return this.#yieldPage(state.runId);
        this.#prepare('INSERT OR REPLACE INTO continuations VALUES(?,?,?, ?,0,NULL)').run(
          state.runId,
          json,
          '',
          request.mode,
        );
        if (request.mode === 'pages') {
          const entry = state.stack[0]!;
          const r = this.get(state.runId)!;
          const node = this.publication(r.workflowId, r.revision).workflow.nodes.find(
            (n) => n.id === entry.nodeId,
          )!;
          const { scope, url } = pageConfig(node);
          this.#prepare('INSERT INTO pageRuns(runId,node,visit,created) VALUES(?,?,?,?)').run(
            state.runId,
            entry.nodeId,
            entry.runIndex,
            now,
          );
          if (scope) {
            const key = JSON.stringify([r.workflowId, node.id, scope]);
            const contract = JSON.stringify([
              url.href,
              node.credentials ?? {},
              node.parameters.workflowId,
              node.parameters.revision,
            ]);
            this.#prepare('INSERT OR IGNORE INTO syncScopes(scope,contract) VALUES(?,?)').run(key, contract);
            if (
              !this.#prepare(
                'UPDATE syncScopes SET owner=?,candidate=NULL WHERE scope=? AND contract=? AND owner IS NULL',
              ).run(r.runId, key, contract).changes
            ) {
              const existing = this.#prepare('SELECT contract FROM syncScopes WHERE scope=?').get(key);
              if (existing?.contract !== contract) {
                this.#resume(r.runId, {
                  reason: 'result',
                  data: {},
                  failure: 'Sync definition changed; provision a new scope',
                });
              } else {
                this.#prepare('INSERT INTO syncQueue VALUES(?,?)').run(r.runId, key);
                this.#prepare("UPDATE runs SET state='waiting' WHERE runId=?").run(r.runId);
                this.#recordPause(r.runId);
              }
              return;
            }
          }
        }
        if (request.mode === 'return')
          this.#resume(state.runId, { reason: 'result', data: {}, returnPairing: request.pairing });
        else this.#prepare("UPDATE runs SET state='queued' WHERE runId=?").run(state.runId);
      });
      return;
    }
    if (
      !('dueAt' in request) ||
      !Number.isSafeInteger(request.dueAt) ||
      !['event', 'time'].includes(request.mode)
    )
      throw new Error('Invalid wait');
    this.#transaction(() => {
      if (this.shared && this.canceled(state.runId)) return this.#yieldPage(state.runId);
      if (
        !this.#prepare("UPDATE runs SET state='waiting' WHERE runId=? AND state='running'").run(state.runId)
          .changes
      )
        throw new Error('Run no longer owned');
      this.#prepare('INSERT OR REPLACE INTO continuations VALUES(?,?,?,?,?,NULL)').run(
        state.runId,
        json,
        randomUUID(),
        request.mode,
        request.dueAt,
      );
      this.#prepare('INSERT INTO transitions VALUES(?,?,?,?)').run(
        state.runId,
        state.stack[0]!.nodeId,
        now,
        'waiting:' + request.mode,
      );
      this.#recordPause(state.runId);
    });
  }

  resolveWait(
    id: string,
    token: string,
    reason: 'event' | 'canceled' | 'timer',
    data: JsonObject,
    now: number,
  ) {
    return this.#transaction(() => {
      const wait = this.waitInfo(id);
      if (!wait || this.canceled(id) || wait.token !== token) return false;
      const due = Number(wait.dueAt) <= now;
      if ((reason === 'timer' && !due) || (reason === 'event' && wait.mode !== 'event')) return false;
      const outcome = due ? (wait.mode === 'time' ? 'time' : 'expired') : reason;
      const json = JSON.stringify({ reason: outcome, data: outcome === 'event' ? data : {} });
      if (outcome === 'event' && Buffer.byteLength(JSON.stringify(data)) > 64 * 1024)
        throw new Error('Resume data exceeds 64 KiB');
      this.#prepare('UPDATE continuations SET response=? WHERE runId=?').run(json, id);
      this.#prepare("UPDATE runs SET state='queued' WHERE runId=? AND state='waiting'").run(id);
      this.#prepare(
        `INSERT INTO transitions SELECT runId,json_extract(checkpoint,'$.stack[0].nodeId'),?,?
        FROM continuations WHERE runId=?`,
      ).run(now, outcome, id);
      return reason === 'timer' || !due;
    });
  }

  dueWaits(now: number) {
    return this.#prepare(
      "SELECT runId,token FROM continuations WHERE mode IN ('event','time') AND response IS NULL AND dueAt<=?",
    ).all(now);
  }

  #append(summary: ExecutionSummary, detail: ExecutionDetail) {
    const json = JSON.stringify(detail);
    this.#prepare('INSERT OR REPLACE INTO history VALUES(?,?,?,?,?,?)').run(
      summary.workflowId,
      summary.id,
      summary.status,
      summary.startedAt,
      JSON.stringify(summary),
      Buffer.byteLength(json) <= this.maxDetailBytes ? json : null,
    );
  }

  compensationInfo(root: string) {
    const receipt = this.get(root);
    if (!receipt) throw new Error('Unknown run');
    const operation = this.#prepare('SELECT id,state FROM compensations WHERE root=?').get(root);
    const steps = this.#prepare(
      `SELECT s.source,s.priority,s.child,s.status,s.failure,s.reason,r.state AS childState
      FROM compensationSteps s LEFT JOIN runs r ON r.runId=s.child WHERE root=? AND s.result IS NOT NULL ORDER BY priority,s.rowid`,
    ).all(root);
    return {
      outcome: receipt.outcome,
      id: operation?.id ?? null,
      state: steps.some((s) => s.childState === 'review') ? 'review' : (operation?.state ?? 'idle'),
      steps,
    };
  }

  #compensationPayload(step: { input?: unknown; result?: unknown; source?: unknown }) {
    return JSON.stringify([
      {
        json: {
          input: JSON.parse(String(step.input)),
          result: JSON.parse(String(step.result)),
          sourceKey: step.source,
        },
      },
    ]);
  }

  #nextCompensation(root: string) {
    const step = this.#prepare(
      "SELECT * FROM compensationSteps WHERE root=? AND result IS NOT NULL AND status='pending' ORDER BY priority,rowid LIMIT 1",
    ).get(root);
    if (!step) {
      this.#prepare("UPDATE compensations SET state='compensated' WHERE root=?").run(root);
      return;
    }
    const child = this.#admitChild(
      String(step.workflow),
      Number(step.revision),
      this.#compensationPayload(step),
    );
    this.#prepare("UPDATE compensationSteps SET child=?,status='running' WHERE source=?").run(
      child,
      String(step.source),
    );
  }

  #beginCompensation(root: string) {
    const id = randomUUID();
    this.#prepare("INSERT INTO compensations VALUES(?,?,'compensating')").run(root, id);
    this.#nextCompensation(root);
    return id;
  }

  compensate(root: string) {
    return this.#transaction(() => {
      const existing = this.#prepare('SELECT id FROM compensations WHERE root=?').get(root);
      if (existing) return String(existing.id);
      if (this.get(root)?.state !== 'finished' || this.inspect(root).uncertain.length)
        throw new Error('Original execution must be settled before compensation');
      if (!this.#prepare('SELECT 1 FROM compensationSteps WHERE root=? AND result IS NOT NULL').get(root))
        throw new Error('No confirmed compensable operation');
      return this.#beginCompensation(root);
    });
  }

  retryCompensation(root: string, failure: string) {
    return this.#transaction(() => {
      const step = this.#prepare('SELECT * FROM compensationSteps WHERE root=? AND failure=?').get(
        root,
        failure,
      );
      const previous = this.#prepare(
        'SELECT attempt FROM compensationRetries WHERE failure=? AND root=?',
      ).get(failure, root);
      if (previous) return String(previous.attempt);
      if (!step || step.status !== 'failed') throw new Error('No retryable compensation for this failure');
      const attempt = randomUUID();
      const payload = this.#compensationPayload(step);
      this.#prepare(
        "UPDATE runs SET state='queued',startedAt=NULL,stoppedAt=NULL,outcome=NULL,payload=? WHERE runId=?",
      ).run(payload, String(step.child));
      this.#prepare("UPDATE compensationSteps SET status='running',reason=NULL WHERE source=?").run(
        String(step.source),
      );
      this.#prepare("UPDATE compensations SET state='compensating' WHERE root=?").run(root);
      this.#prepare('INSERT INTO compensationRetries VALUES(?,?,?)').run(failure, root, attempt);
      return attempt;
    });
  }

  #settleParallel(
    parent: Receipt,
    node: WorkflowNode,
    visit: number,
    child: string,
    status: string,
    error: string,
  ) {
    const id = parent.runId;
    const parts = this.#prepare('SELECT * FROM parallelWork WHERE parent=? ORDER BY start').all(id);
    const state = this.pageState(id, node.id, visit);
    const rows = JSON.parse(String(state.rows)) as JsonObject[];
    const { sumField } = pageConfig(node);
    let total = Number(parts[0]!.baseTotal);
    for (const part of parts) {
      if (part.status === 'success' && sumField) {
        for (const row of rows.slice(Number(part.start), Number(part.start) + Number(part.length)))
          total += Number(row[sumField]);
      }
    }
    const length = Number(parts.find((part) => part.child === child)!.length);
    if (status === 'success')
      this.#prepare(
        'UPDATE pageRuns SET batches=batches+1,items=items+?,total=? WHERE runId=? AND node=? AND visit=?',
      ).run(length, total, id, node.id, visit);
    if (parts.some((part) => part.status === 'pending') || this.canceled(id)) return;
    const failed = parts.find((part) => part.status === 'failed');
    if (failed) {
      const reason = String(failed.failure ?? error);
      if (!parts.some((part) => this.canceled(String(part.child))))
        this.#archivePage(parent, node, visit, reason);
      this.#batchDone(id, node, visit, { reason: 'result', data: {}, failure: reason });
    } else {
      const last = parts[parts.length - 1]!;
      const offset = Number(last.start) + Number(last.length);
      this.#prepare('UPDATE pageRuns SET offset=? WHERE runId=? AND node=? AND visit=?').run(
        offset,
        id,
        node.id,
        visit,
      );
      if (offset === rows.length) this.#advancePage(id, node, visit);
      else this.#yieldPage(id);
    }
    this.#prepare('DELETE FROM parallelWork WHERE parent=?').run(id);
  }

  finish(receipt: Receipt, summary: ExecutionSummary, detail: ExecutionDetail, interrupted = false) {
    this.#transaction(() => {
      // An engine error can also mean that committing the review transition failed.
      // Leave the claim and journal intact so startup can reconcile the external outcome.
      if (this.#prepare("SELECT 1 FROM effects WHERE runId=? AND state='unknown'").get(receipt.runId))
        throw new Error('Cannot finish a run with an uncertain external outcome');
      // A call reports its child's interruption to the engine as a node failure.
      // The durable receipts retain whether any external result is still uncertain.
      if (
        !interrupted &&
        receipt.mode !== 'subworkflow' &&
        detail.workflow.nodes.some((n) => !n.disabled && compensationSpec(n))
      ) {
        const uncertainChild = this.#prepare(
          `WITH RECURSIVE descendants(id) AS (
          SELECT child FROM calls WHERE parent=?
          UNION ALL SELECT c.child FROM calls c JOIN descendants d ON c.parent=d.id
        ) SELECT 1 FROM descendants d JOIN runs r ON r.runId=d.id WHERE r.state='interrupted' LIMIT 1`,
        ).get(receipt.runId);
        if (uncertainChild) {
          interrupted = true;
          summary.interrupted = true;
        }
      }
      const undo = this.#prepare('SELECT root FROM compensationSteps WHERE child=?').get(receipt.runId);
      if (undo) {
        if (summary.status === 'success') {
          this.#prepare("UPDATE compensationSteps SET status='done' WHERE child=?").run(receipt.runId);
          this.#nextCompensation(String(undo.root));
        } else {
          const retryable =
            summary.status === 'error' &&
            !this.canceled(receipt.runId) &&
            !this.#prepare("SELECT 1 FROM effects WHERE runId=? AND state!='unsent'").get(receipt.runId);
          this.#prepare('UPDATE compensationSteps SET status=?,failure=?,reason=? WHERE child=?').run(
            retryable ? 'failed' : 'manual',
            randomUUID(),
            detail.error?.message ?? summary.status,
            receipt.runId,
          );
          this.#prepare("UPDATE compensations SET state='manual' WHERE root=?").run(String(undo.root));
        }
      } else if (
        !interrupted &&
        summary.status === 'error' &&
        !this.canceled(receipt.runId) &&
        this.#prepare('SELECT 1 FROM compensationSteps WHERE root=? AND result IS NOT NULL AND auto=1').get(
          receipt.runId,
        )
      )
        this.#beginCompensation(receipt.runId);
      if (summary.status === 'error') this.#archiveHttp(receipt, detail);
      const parallel = receipt.mode === 'subworkflow' && this.parallelChild(receipt.runId);
      if (parallel) {
        const ok = summary.status === 'success';
        const retry = ok
          ? null
          : JSON.stringify({
              payload: this.#prepare('SELECT payload FROM runs WHERE runId=?').get(receipt.runId)!.payload,
              effects: this.#prepare("SELECT key,result FROM effects WHERE runId=? AND state='success'").all(
                receipt.runId,
              ),
            });
        this.#prepare('UPDATE parallelWork SET status=?,failure=?,retryData=? WHERE child=?').run(
          ok ? 'success' : 'failed',
          ok ? null : (detail.error?.message ?? 'Batch ' + summary.status),
          retry,
          receipt.runId,
        );
      }
      if (!parallel && receipt.mode === 'subworkflow' && summary.status === 'error') {
        const target = this.#recoverableParent(receipt.runId);
        if (target?.parent.state === 'waiting')
          this.#archivePage(
            target.parent,
            target.node,
            target.visit,
            detail.error?.message ?? 'Batch failed',
            receipt,
          );
      }
      const update = this.#prepare(
        `UPDATE runs SET state=?,stoppedAt=?,outcome=?,payload=NULL WHERE runId=? AND state='running'`,
      ).run(interrupted ? 'interrupted' : 'finished', this.#now(), summary.status, receipt.runId);
      if (!update.changes) throw new Error('Run no longer owned');
      this.#prepare(
        'UPDATE recoveryPoints SET outcome=? WHERE runId=? AND attempt IS NOT NULL AND outcome IS NULL',
      ).run(summary.status, receipt.runId);
      this.#prepare('DELETE FROM continuations WHERE runId=?').run(receipt.runId);
      this.#prepare('UPDATE pageRuns SET cursor=NULL,next=NULL,rows=NULL,retryAt=NULL WHERE runId=?').run(
        receipt.runId,
      );
      this.#prepare('DELETE FROM seenCursors WHERE runId=?').run(receipt.runId);
      const transitions = this.transitions(receipt.runId);
      if (transitions.length) detail.transitions = transitions;
      // Response bodies are required only while a recorded node can be replayed.
      this.#prepare('UPDATE effects SET result=NULL WHERE runId=?').run(receipt.runId);
      const link = this.#prepare('SELECT * FROM calls WHERE child=?').get(receipt.runId);
      const parent = link && this.get(String(link.parent));
      const settlingCanceledBatch =
        parent?.state === 'queued' && summary.status === 'success' && this.canceled(parent.runId);
      if (parent && parallel && (parent.state === 'waiting' || parent.state === 'queued')) {
        const node = this.publication(parent.workflowId, parent.revision).workflow.nodes.find(
          (n) => n.id === link.node,
        )!;
        this.#settleParallel(
          parent,
          node,
          Number(link.visit),
          receipt.runId,
          summary.status,
          detail.error?.message ?? 'Batch failed',
        );
      } else if (parent && !parallel && (parent.state === 'waiting' || settlingCanceledBatch)) {
        const returnId = detail.workflow.nodes.find((n) => n.type === 'draflow.return' && !n.disabled)?.id;
        const returned = detail.tasks.filter((t) => t.nodeId === returnId);
        const items = returned.flatMap(({ task }) =>
          (task?.output?.main?.[0] ?? []).map((item, i) => {
            const links = task?.returnPairing?.[i] ?? [];
            return { ...item, pairedItem: links.length === 1 ? links[0]! : links };
          }),
        );
        const response: WaitResult = { reason: 'result', data: {}, items };
        if (summary.status !== 'success')
          response.failure = detail.error?.message ?? 'Subworkflow ' + summary.status;
        const node = this.publication(parent.workflowId, parent.revision).workflow.nodes.find(
          (n) => n.id === link.node,
        )!;
        if (node.type === 'draflow.pages') this.#batchDone(parent.runId, node, Number(link.visit), response);
        else if (!settlingCanceledBatch) this.#resume(parent.runId, response);
      }
      this.#prepare('DELETE FROM parallelWork WHERE parent=?').run(receipt.runId);
      const policy = detail.workflow.settings.saveExecutionData;
      if (link && summary.status !== 'error')
        this.#prepare('DELETE FROM syncWork WHERE child=?').run(receipt.runId);
      if (policy !== 'none' && (policy !== 'error' || summary.status === 'error'))
        this.#append(summary, detail);
    });
  }

  recover() {
    if (this.shared) return this.shared.atomic(() => this.#recoverOwned());
    this.#recoverOwned();
  }

  #recoverOwned() {
    this.#purgeRecovery();
    for (const row of this.#prepare("SELECT runId FROM runs WHERE state='running'").all()) {
      if (this.shared && !this.shared.expired(String(row.runId))) continue;
      const r = this.get(String(row.runId))!;
      if (
        this.#prepare(
          "SELECT 1 FROM continuations WHERE runId=? AND mode IN ('effect','dispatch','child','pages')",
        ).get(r.runId)
      ) {
        const manual = this.#prepare(
          "SELECT 1 FROM effects WHERE runId=? AND (mode='manual' OR EXISTS(SELECT 1 FROM canceledRuns WHERE runId=effects.runId)) AND state='unknown'",
        ).get(r.runId);
        this.#prepare('UPDATE runs SET state=? WHERE runId=?').run(manual ? 'review' : 'queued', r.runId);
        if (manual) this.#recordPause(r.runId);
        continue;
      }
      // These validated direct children cannot send before creating their effect checkpoint.
      if (
        (this.#businessEnabled && r.workflowId.startsWith('business-') && this.isBusinessRun(r.runId)) ||
        this.parallelChild(r.runId) ||
        this.#prepare('SELECT 1 FROM compensationSteps WHERE child=?').get(r.runId)
      ) {
        this.#prepare("UPDATE runs SET state='queued' WHERE runId=?").run(r.runId);
        continue;
      }
      const { workflow } = this.publication(r.workflowId, r.revision);
      this.finish(
        r,
        {
          id: r.runId,
          workflowId: r.workflowId,
          workflowName: workflow.name,
          startNodeId: r.triggerNodeId,
          mode: r.mode,
          startedAt: r.startedAt!,
          stoppedAt: this.#now(),
          status: 'error',
          interrupted: true,
          executed: 0,
          reused: 0,
        },
        {
          workflow,
          tasks: [],
          error: {
            name: 'InterruptedExecution',
            message: 'Host stopped during execution. Check external effects before retrying.',
          },
        },
        true,
      );
    }
  }

  stats() {
    const row = this.#prepare(
      `SELECT COUNT(*) FILTER(WHERE state='queued') AS queued,
      MIN(acceptedAt) FILTER(WHERE state='queued') AS oldest,
      COUNT(*) FILTER(WHERE state='waiting') AS waiting,
      COUNT(*) FILTER(WHERE state='review') AS review,
      COUNT(*) FILTER(WHERE state='interrupted') AS interrupted,
      COUNT(*) FILTER(WHERE state='finished' AND outcome='error') AS failed FROM runs`,
    ).get()!;
    return {
      queued: Number(row.queued),
      waiting: Number(row.waiting),
      review: Number(row.review),
      oldestWaitMs: row.oldest === null ? 0 : this.#now() - Number(row.oldest),
      interrupted: Number(row.interrupted),
      failed: Number(row.failed),
    };
  }

  close() {
    this.#db.close();
  }
}

// Compatibility for existing embedders and Phase 4–6 recovery tools.
export { ExecutionLedger as SqliteLedger };
