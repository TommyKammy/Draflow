import { randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ExecutionDetail, ExecutionStore, ExecutionSummary } from '@draflow/storage';
import type { PublishedWorkflow, TriggerEvent } from '@draflow/runtime';

import type { Schedule } from './schedule.js';

export class QueueFull extends Error {
  constructor() {
    super('Queue full');
  }
}

export type RunState = 'queued' | 'running' | 'finished' | 'interrupted';
export interface Receipt {
  runId: string;
  workflowId: string;
  revision: number;
  triggerNodeId: string;
  eventKey: string | null;
  mode: 'trigger' | 'webhook';
  state: RunState;
  acceptedAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  outcome: ExecutionSummary['status'] | null;
}

const fields =
  'runId, workflowId, revision, triggerNodeId, eventKey, mode, state, acceptedAt, startedAt, stoppedAt, outcome';

export class SqliteLedger {
  readonly #db: DatabaseSync;
  readonly history: ExecutionStore;

  constructor(
    path: string,
    private readonly maxDetailBytes: number,
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
        CREATE TABLE IF NOT EXISTS deliveries (
          workflowId TEXT, triggerNodeId TEXT, eventKey TEXT, expiresAt INTEGER NOT NULL,
          runId TEXT NOT NULL REFERENCES runs(runId), PRIMARY KEY(workflowId, triggerNodeId, eventKey)
        );
        CREATE TABLE IF NOT EXISTS history (
          workflowId TEXT, id TEXT, status TEXT NOT NULL, startedAt INTEGER NOT NULL,
          summary TEXT NOT NULL, detail TEXT, PRIMARY KEY(workflowId, id)
        );
        COMMIT;`);
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
        return row?.detail ? (JSON.parse(String(row.detail)) as ExecutionDetail) : null;
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

  requiredPublications() {
    return this.#prepare(
      `SELECT workflowId, revision FROM active UNION
      SELECT workflowId, revision FROM runs WHERE state='queued'`,
    ).all();
  }

  activate(
    id: string,
    revision: number,
    routes: { path: string; triggerNodeId: string }[],
    schedules: { triggerNodeId: string; spec: Schedule; nextAt: number }[],
  ) {
    this.#transaction(() => {
      if (this.#prepare('SELECT 1 FROM webhookTestDocuments WHERE workflowId=?').get(id))
        throw new Error('Cannot activate a test snapshot');
      if (this.#prepare('SELECT revision FROM active WHERE workflowId=?').get(id)?.revision === revision)
        return;
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
    });
  }

  nextScheduleTime() {
    const value = this.#prepare('SELECT MIN(nextAt) AS time FROM schedules').get()!.time;
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
    ttl: number,
  ) {
    const stamp = new Date(scheduledAt).toISOString();
    return this.accept(
      id,
      trigger,
      { key: stamp, items: [{ json: { scheduledAt: stamp } }] },
      capacity,
      ttl,
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
  deactivate(id: string) {
    this.#prepare('DELETE FROM active WHERE workflowId=?').run(id);
  }

  accept(
    id: string,
    trigger: string,
    event: Omit<TriggerEvent, 'runId'>,
    capacity: number,
    ttl: number,
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
      if (event.key !== undefined) {
        const existing = this.#prepare(
          `SELECT d.runId FROM deliveries d JOIN runs USING(runId)
          WHERE d.workflowId=? AND d.triggerNodeId=? AND d.eventKey=?
          AND (d.expiresAt>? OR runs.state IN ('queued','running','interrupted'))`,
        ).get(id, trigger, event.key, now);
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
        this.#prepare('INSERT OR REPLACE INTO deliveries VALUES(?,?,?,?,?)').run(
          id,
          trigger,
          event.key,
          now + ttl,
          runId,
        );
      }
      return runId;
    });
  }

  get(run: string): Receipt | undefined {
    return this.#prepare(`SELECT ${fields} FROM runs WHERE runId=?`).get(run) as unknown as
      | Receipt
      | undefined;
  }

  byEvent(workflowId: string, triggerNodeId: string, eventKey: string) {
    const delivery = this.#prepare(
      'SELECT runId FROM deliveries WHERE workflowId=? AND triggerNodeId=? AND eventKey=?',
    ).get(workflowId, triggerNodeId, eventKey);
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
        "SELECT runId,payload FROM runs WHERE state='queued' ORDER BY rowid LIMIT 1",
      ).get();
      if (!next) return;
      const id = String(next.runId);
      this.#prepare("UPDATE runs SET state='running',startedAt=? WHERE runId=?").run(Date.now(), id);
      return { receipt: this.get(id)!, items: JSON.parse(String(next.payload)) as TriggerEvent['items'] };
    });
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
      const update = this.#prepare(
        `UPDATE runs SET state=?,stoppedAt=?,outcome=?,payload=NULL WHERE runId=? AND state='running'`,
      ).run(interrupted ? 'interrupted' : 'finished', Date.now(), summary.status, receipt.runId);
      if (!update.changes) throw new Error('Run no longer owned');
      const policy = detail.workflow.settings.saveExecutionData;
      if (policy !== 'none' && (policy !== 'error' || summary.status === 'error'))
        this.#append(summary, detail);
    });
  }

  recover() {
    for (const row of this.#prepare("SELECT runId FROM runs WHERE state='running'").all()) {
      const r = this.get(String(row.runId))!;
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
      COUNT(*) FILTER(WHERE state='interrupted') AS interrupted,
      COUNT(*) FILTER(WHERE state='finished' AND outcome='error') AS failed FROM runs`,
    ).get()!;
    return {
      queued: Number(row.queued),
      oldestWaitMs: row.oldest === null ? 0 : Date.now() - Number(row.oldest),
      interrupted: Number(row.interrupted),
      failed: Number(row.failed),
    };
  }

  close() {
    this.#db.close();
  }
}
