import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
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

const deliverySchema = `CREATE TABLE IF NOT EXISTS deliveries (
  workflowId TEXT, triggerNodeId TEXT, eventKey TEXT, source TEXT NOT NULL, expiresAt INTEGER NOT NULL,
  runId TEXT NOT NULL REFERENCES runs(runId), PRIMARY KEY(workflowId, triggerNodeId, eventKey, source)
);`;

const fields =
  'runId, workflowId, revision, triggerNodeId, eventKey, mode, state, acceptedAt, startedAt, stoppedAt, outcome';

export function executionTasks(runData: RunData): ExecutionDetail['tasks'] {
  return Object.values(runData).flat()
    .sort((a, b) => a.executionIndex - b.executionIndex)
    .map(task => ({ nodeId: task.nodeId, runIndex: task.runIndex, reused: false, task }));
}

function encodeCheckpoint(state: Checkpoint) {
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error('Checkpoint exceeds 8 MiB');
  return json;
}

export class SqliteLedger {
  readonly #db: DatabaseSync;
  readonly history: ExecutionStore;

  constructor(
    path: string,
    private readonly maxDetailBytes: number,
    private readonly maxCallDepth = 8,
  ) {
    this.#db = new DatabaseSync(path);
    try {
      // Keep the writer lock until close. Only the owner may recover running jobs.
      this.#db.exec(`PRAGMA locking_mode=EXCLUSIVE;
        PRAGMA foreign_keys=ON;
        PRAGMA synchronous=FULL;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS publications (
          workflowId TEXT, revision INTEGER, document TEXT NOT NULL,
          PRIMARY KEY(workflowId, revision)
        );
        CREATE TABLE IF NOT EXISTS active (
          workflowId TEXT PRIMARY KEY, revision INTEGER NOT NULL,
          FOREIGN KEY(workflowId, revision) REFERENCES publications
        );
        CREATE TABLE IF NOT EXISTS schedules (
          workflowId TEXT NOT NULL REFERENCES active(workflowId) ON DELETE CASCADE,
          triggerNodeId TEXT NOT NULL, spec TEXT NOT NULL, nextAt INTEGER NOT NULL,
          PRIMARY KEY(workflowId,triggerNodeId)
        );
        CREATE INDEX IF NOT EXISTS scheduleDue ON schedules(nextAt);
        CREATE TABLE IF NOT EXISTS webhookRoutes (
          path TEXT PRIMARY KEY, workflowId TEXT NOT NULL REFERENCES active(workflowId) ON DELETE CASCADE,
          triggerNodeId TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS webhookTestDocuments (workflowId TEXT PRIMARY KEY);
        CREATE TEMP TABLE testWebhooks (
          path TEXT PRIMARY KEY, workflowId TEXT NOT NULL, revision INTEGER NOT NULL,
          triggerNodeId TEXT NOT NULL, expiresAt INTEGER NOT NULL, document TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
          runId TEXT NOT NULL UNIQUE, workflowId TEXT NOT NULL, revision INTEGER NOT NULL,
          triggerNodeId TEXT NOT NULL, eventKey TEXT, mode TEXT NOT NULL, payload TEXT,
          state TEXT NOT NULL, acceptedAt INTEGER NOT NULL, startedAt INTEGER, stoppedAt INTEGER, outcome TEXT,
          FOREIGN KEY(workflowId, revision) REFERENCES publications
        );
        CREATE INDEX IF NOT EXISTS queue ON runs(state);
        CREATE TABLE IF NOT EXISTS continuations (
          runId TEXT PRIMARY KEY REFERENCES runs(runId), checkpoint TEXT NOT NULL,
          token TEXT NOT NULL, mode TEXT NOT NULL, dueAt INTEGER NOT NULL, response TEXT
        );
        CREATE INDEX IF NOT EXISTS continuationDue ON continuations(dueAt) WHERE mode IN ('event','time') AND response IS NULL;
        CREATE TABLE IF NOT EXISTS effects (
          runId TEXT REFERENCES runs(runId), nodeId TEXT, visit INTEGER, item INTEGER, key TEXT UNIQUE NOT NULL,
          fingerprint TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
          PRIMARY KEY(runId,nodeId,visit,item)
        );
        CREATE TABLE IF NOT EXISTS calls (
          child TEXT PRIMARY KEY REFERENCES runs(runId), parent TEXT NOT NULL REFERENCES runs(runId),
          node TEXT NOT NULL, visit INTEGER NOT NULL, batch INTEGER NOT NULL,
          UNIQUE(parent,node,visit,batch)
        );
        CREATE TABLE IF NOT EXISTS pageRuns (
          runId TEXT REFERENCES runs(runId), node TEXT, visit INTEGER, cursor TEXT, next TEXT, rows TEXT,
          offset INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, batches INTEGER NOT NULL DEFAULT 0,
          items INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
          error TEXT, created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retryAt INTEGER,
          PRIMARY KEY(runId,node,visit)
        );
        CREATE TABLE IF NOT EXISTS canceledRuns (runId TEXT PRIMARY KEY REFERENCES runs(runId));
        CREATE TABLE IF NOT EXISTS readyAfter (runId TEXT PRIMARY KEY REFERENCES runs(runId), cutoff INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS pageRetry ON pageRuns(retryAt) WHERE retryAt IS NOT NULL;
        CREATE TABLE IF NOT EXISTS seenCursors (
          runId TEXT, node TEXT, visit INTEGER, digest TEXT, PRIMARY KEY(runId,node,visit,digest)
        );
        CREATE TABLE IF NOT EXISTS transitions (
          runId TEXT REFERENCES runs(runId), nodeId TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS transitionRun ON transitions(runId);
        ${deliverySchema}
        CREATE TABLE IF NOT EXISTS history (
          workflowId TEXT, id TEXT, status TEXT NOT NULL, startedAt INTEGER NOT NULL,
          summary TEXT NOT NULL, detail TEXT, PRIMARY KEY(workflowId, id)
        );`);
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
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.close();
      throw error;
    }
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
    return this.#db.prepare(sql) as Omit<StatementSync, 'all' | 'get'> & {
      all(...values: Bindings): Row[];
      get(...values: Bindings): Row | undefined;
    };
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
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
    const visit = (workflow: Workflow, ancestors: string[]) => {
      for (const node of workflow.nodes) {
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

  #spawn(parent: Receipt, node: WorkflowNode, visit: number, batch: number, items: Item[]) {
    const id = String(node.parameters.workflowId);
    const revision = Number(node.parameters.revision);
    const entry = this.publication(id, revision).workflow.nodes.find(
      (n) => !n.disabled && n.type === 'draflow.childInput',
    )!;
    const child = randomUUID();
    this.#prepare(
      `INSERT INTO runs(runId,workflowId,revision,triggerNodeId,mode,payload,state,acceptedAt)
      VALUES(?,?,?,?,'subworkflow',?,'queued',?)`,
    ).run(child, id, revision, entry.id, JSON.stringify(items), Date.now());
    this.#prepare('INSERT INTO calls VALUES(?,?,?,?,?)').run(child, parent.runId, node.id, visit, batch);
    this.#prepare("UPDATE runs SET state='waiting' WHERE runId=?").run(parent.runId);
    this.#recordPause(parent.runId);
  }

  pendingMode(id: string) {
    return this.#prepare('SELECT mode FROM continuations WHERE runId=? AND response IS NULL').get(id)?.mode;
  }

  dispatchChild(parent: Receipt, node: WorkflowNode) {
    const entry = this.continuation(parent.runId)!.checkpoint.stack[0]!;
    this.#transaction(() => this.#spawn(parent, node, entry.runIndex, 0, entry.input.main?.[0] ?? []));
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
        this.#prepare('UPDATE pageRuns SET retryAt=NULL WHERE runId=?').run(run);
        this.#prepare("INSERT INTO transitions VALUES(?, '', ?, 'cancelRequested')").run(run, Date.now());
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
        stoppedAt: Date.now(),
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
    this.#transaction(() => {
      this.#prepare('UPDATE pageRuns SET attempts=?,retryAt=? WHERE runId=? AND node=? AND visit=?').run(
        attempt,
        due,
        id,
        node.id,
        visit,
      );
      this.#prepare("UPDATE runs SET state='waiting' WHERE runId=?").run(id);
      this.#recordPause(id);
    });
  }

  wakeRetries(now: number) {
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

  pageState(id: string, node: string, visit: number) {
    return this.#prepare('SELECT * FROM pageRuns WHERE runId=? AND node=? AND visit=?').get(id, node, visit)!;
  }

  pageFailure(id: string, node: string, visit: number, error: string) {
    this.#transaction(() => {
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
      Number(state.items) + page.rows.length > config.maxItems ||
      Number(state.bytes) + page.bytes > config.maxBytes
    )
      return this.pageFailure(id, node.id, visit, 'Page item or byte limit exceeded');
    if (
      config.sumField &&
      !Number.isFinite(
        page.rows.reduce((sum, row) => sum + Number(row[config.sumField]), Number(state.total)),
      )
    )
      return this.pageFailure(id, node.id, visit, 'Page total exceeds numeric range');
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
    this.#transaction(() => {
      if (page.next !== null) {
        const digest = createHash('sha256').update(page.next).digest('hex');
        this.#prepare('INSERT INTO seenCursors VALUES(?,?,?,?)').run(id, node.id, visit, digest);
      }
      this.#prepare(
        'UPDATE pageRuns SET rows=?,next=?,offset=0,bytes=bytes+?,attempts=0,retryAt=NULL WHERE runId=? AND node=? AND visit=?',
      ).run(JSON.stringify(page.rows), page.next, page.bytes, id, node.id, visit);
    });
  }

  batch(parent: Receipt, node: WorkflowNode, visit: number) {
    const state = this.pageState(parent.runId, node.id, visit);
    const rows = JSON.parse(String(state.rows)) as JsonObject[];
    const offset = Number(state.offset);
    this.#transaction(() => {
      if (offset === rows.length) this.#advancePage(parent.runId, node, visit);
      else
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
    const sum = sumField ? batch.reduce((total, row) => total + Number(row[sumField]), 0) : 0;
    this.#prepare(
      'UPDATE pageRuns SET offset=offset+?,items=items+?,batches=batches+1,total=total+? WHERE runId=? AND node=? AND visit=?',
    ).run(batch.length, batch.length, sum, id, node.id, visit);
    if (offset + batch.length === rows.length) this.#advancePage(id, node, visit);
    else if (!this.canceled(id)) this.#yieldPage(id);
  }

  inspect(id: string) {
    const uncertain = this.#prepare(
      `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT c.child
      FROM calls c JOIN tree t ON c.parent=t.id) SELECT e.runId,e.nodeId,e.visit,e.item,e.key
      FROM effects e JOIN tree t ON e.runId=t.id WHERE e.state='unknown'`,
    ).all(id);
    return { pages: this.progress(id), calls: this.relations(id), uncertain, canceled: this.canceled(id) };
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

  requiredPublications() {
    return this.#prepare(
      `SELECT workflowId, revision FROM active UNION
      SELECT workflowId, revision FROM runs WHERE state IN ('queued','waiting','review')`,
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
        'INSERT INTO active VALUES(?,?) ON CONFLICT(workflowId) DO UPDATE SET revision=excluded.revision',
      ).run(id, revision);
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
      SELECT MIN(dueAt) FROM continuations WHERE mode IN ('event','time') AND response IS NULL)`,
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

  acceptSchedule(id: string, trigger: string, scheduledAt: number, nextAt: number, capacity: number) {
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
      this.#prepare('DELETE FROM testWebhooks WHERE expiresAt<=?').run(Date.now());
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
      `SELECT workflowId,revision,triggerNodeId FROM webhookRoutes JOIN active USING(workflowId) WHERE path=?
      UNION ALL SELECT workflowId,revision,triggerNodeId FROM testWebhooks WHERE path=? AND expiresAt>?`,
    ).get(path, path, Date.now());
    return (
      row && {
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
      const now = Date.now();
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

  claim() {
    return this.#transaction(() => {
      const next = this.#prepare(
        `SELECT r.runId,r.payload FROM runs r LEFT JOIN readyAfter y ON r.runId=y.runId
         WHERE r.state='queued' ORDER BY COALESCE(y.cutoff,r.rowid),y.cutoff IS NOT NULL,r.rowid LIMIT 1`,
      ).get();
      if (!next) return;
      const id = String(next.runId);
      this.#prepare('DELETE FROM readyAfter WHERE runId=?').run(id);
      this.#prepare("UPDATE runs SET state='running',startedAt=COALESCE(startedAt,?) WHERE runId=?").run(
        Date.now(),
        id,
      );
      // Mark only new claims. Older running rows with a consumed wait could already
      // have entered an untracked node under the previous execution contract.
      this.#prepare(
        "UPDATE continuations SET mode='dispatch' WHERE runId=? AND mode IN ('event','time') AND response IS NOT NULL",
      ).run(id);
      return { receipt: this.get(id)!, items: JSON.parse(String(next.payload)) as TriggerEvent['items'] };
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

  beginJournal(state: Checkpoint, mode: 'keyed' | 'manual'): JournalItem {
    const json = encodeCheckpoint(state);
    const { runId } = state;
    const { nodeId, runIndex, input } = state.stack[0]!;
    this.#transaction(() => {
      this.#prepare("INSERT OR REPLACE INTO continuations VALUES(?,?, '', 'effect',0,NULL)").run(runId, json);
      const reserve = this.#prepare("INSERT OR IGNORE INTO effects VALUES(?,?,?,?,?,'',?,'unsent',NULL)");
      const count = input.main?.[0]?.length ?? 0;
      for (let index = 0; index < count; index++) {
        reserve.run(runId, nodeId, runIndex, index, randomUUID(), mode);
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
      const result = await send(key);
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
      const op = this.#prepare("SELECT mode FROM effects WHERE runId=? AND key=? AND state='unknown'").get(
        id,
        key,
      );
      if (!op || (decision === 'retryKeyed' && (op.mode !== 'keyed' || this.canceled(id)))) return false;
      // A keyed retry keeps the unknown state, original fingerprint and key.
      if (decision !== 'retryKeyed') {
        this.#prepare('UPDATE effects SET state=?,result=? WHERE key=?').run(
          decision === 'applied' ? 'success' : 'unsent',
          decision === 'applied' ? json : null,
          key,
        );
      }
      this.#prepare('INSERT INTO transitions SELECT runId,nodeId,?,? FROM effects WHERE key=?').run(
        Date.now(),
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
      stoppedAt: Date.now(),
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
        this.#prepare('INSERT OR REPLACE INTO continuations VALUES(?,?,?, ?,0,NULL)').run(
          state.runId,
          json,
          '',
          request.mode,
        );
        if (request.mode === 'pages') {
          const entry = state.stack[0]!;
          this.#prepare('INSERT INTO pageRuns(runId,node,visit,created) VALUES(?,?,?,?)').run(
            state.runId,
            entry.nodeId,
            entry.runIndex,
            now,
          );
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

  finish(receipt: Receipt, summary: ExecutionSummary, detail: ExecutionDetail, interrupted = false) {
    this.#transaction(() => {
      // An engine error can also mean that committing the review transition failed.
      // Leave the claim and journal intact so startup can reconcile the external outcome.
      if (this.#prepare("SELECT 1 FROM effects WHERE runId=? AND state='unknown'").get(receipt.runId))
        throw new Error('Cannot finish a run with an uncertain external outcome');
      const update = this.#prepare(
        `UPDATE runs SET state=?,stoppedAt=?,outcome=?,payload=NULL WHERE runId=? AND state='running'`,
      ).run(interrupted ? 'interrupted' : 'finished', Date.now(), summary.status, receipt.runId);
      if (!update.changes) throw new Error('Run no longer owned');
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
      const settlingCanceledBatch = parent?.state === 'queued' && summary.status === 'success' && this.canceled(parent.runId);
      if (parent && (parent.state === 'waiting' || settlingCanceledBatch)) {
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
      const policy = detail.workflow.settings.saveExecutionData;
      if (policy !== 'none' && (policy !== 'error' || summary.status === 'error'))
        this.#append(summary, detail);
    });
  }

  recover() {
    for (const row of this.#prepare("SELECT runId FROM runs WHERE state='running'").all()) {
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
          stoppedAt: Date.now(),
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
      oldestWaitMs: row.oldest === null ? 0 : Date.now() - Number(row.oldest),
      interrupted: Number(row.interrupted),
      failed: Number(row.failed),
    };
  }

  close() {
    this.#db.close();
  }
}
