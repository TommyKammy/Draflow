import { createHash, randomUUID } from 'node:crypto';
import type { NodeHost } from './host.js';
import { parseWorkflow, type JsonObject, type Workflow } from '@draflow/core';

type Value = string | number | null;
type Row = Record<string, Value>;
type Statement = {
  get(...v: Value[]): Row | undefined;
  all(...v: Value[]): Row[];
  run(...v: Value[]): unknown;
};
export const roles = ['viewer', 'operator', 'publisher', 'admin', 'disabled'] as const;
type Role = (typeof roles)[number];
export const grants = ['reconcile', 'compensate', 'credentials'] as const;
type Grant = (typeof grants)[number];
export interface Policy {
  role: Role;
  grants?: Grant[];
}
export interface Identity extends Policy {
  actor: string;
  organization: string;
}
export class OperatorError extends Error {
  constructor(readonly status: number) {
    super(String(status));
  }
}
const deny = (s: number): never => {
  throw new OperatorError(s);
};
export function validPolicy(p: unknown): p is Policy {
  if (!p || typeof p !== 'object' || !('role' in p) || !roles.includes(p.role as Role)) return false;
  return (
    !('grants' in p) ||
    (Array.isArray(p.grants) &&
      p.grants.every((g) => grants.includes(g)) &&
      (p.grants.length === 0 || p.role === 'operator' || p.role === 'admin'))
  );
}
const permissions: Record<Role, string[]> = {
  disabled: [],
  viewer: ['read'],
  operator: ['read', 'resume', 'cancel', 'redrive', 'start'],
  publisher: ['read', 'publish', 'activate', 'release'],
  admin: ['read', 'resume', 'cancel', 'redrive', 'start', 'publish', 'activate', 'release', 'membership', ...grants],
};
const reasons = [
  'receiver-confirmed',
  'receiver-absent',
  'incident-recovery',
  'release',
  'access-change',
  'operator-request',
];
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function field(v: unknown, max = 256): string {
  if (typeof v !== 'string' || !v.length || v.length > max || /[\x00-\x1f]/.test(v)) return deny(400);
  return v;
}
const statusExpr = `CASE WHEN c.state='manual' THEN 'manual' WHEN c.state='compensating' THEN 'compensating'
 WHEN r.state='waiting' AND EXISTS(SELECT 1 FROM pageRuns p WHERE p.runId=r.runId AND p.retryAt IS NOT NULL) THEN 'throttled' ELSE r.state END`;
const runFields = 'r.runId,r.workflowId,r.revision,r.acceptedAt,r.startedAt,r.stoppedAt,r.state,r.outcome';
export class OperatorStore {
  constructor(
    private sql: (q: string) => Statement,
    private atomic: <T>(fn: () => T) => T,
    private now: () => number,
    private shared: boolean,
  ) {}
  credentialAccess(id: string) {
    return this.sql('SELECT enabled,version FROM credential_access WHERE credential=?').get(id);
  }
  heartbeat(worker: string) {
    this.sql(
      'INSERT INTO worker_health VALUES(?,?) ON CONFLICT(worker) DO UPDATE SET stamp=excluded.stamp',
    ).run(worker, this.now());
  }
  private list(q: Record<string, unknown>) {
    const where: string[] = [],
      args: Value[] = [];
    for (const [key, column] of [
      ['workflow', 'r.workflowId'],
      ['id', 'r.runId'],
      ['revision', 'r.revision'],
      ['status', statusExpr],
    ] as const) {
      if (q[key] !== undefined) {
        where.push(column + '=?');
        args.push(field(String(q[key])));
      }
    }
    for (const [key, op] of [
      ['from', '>='],
      ['to', '<='],
    ] as const) {
      if (q[key] !== undefined) {
        const time = Number(q[key]);
        if (!Number.isSafeInteger(time)) deny(400);
        where.push('r.acceptedAt' + op + '?');
        args.push(time);
      }
    }
    if (q.before !== undefined) {
      const stamp = Number(q.before);
      if (!Number.isSafeInteger(stamp)) deny(400);
      where.push('(r.acceptedAt<? OR (r.acceptedAt=? AND r.runId<?))');
      args.push(stamp, stamp, field(q.afterId));
    }
    return this.sql(
      'SELECT ' +
        runFields +
        ', ' +
        statusExpr +
        ' AS status FROM runs r LEFT JOIN compensations c ON c.root=r.runId ' +
        (where.length ? 'WHERE ' + where.join(' AND ') : '') +
        ' ORDER BY r.acceptedAt DESC,r.runId DESC LIMIT 50',
    ).all(...args);
  }
  private detail(host: NodeHost, id: string) {
    let run = this.list({ id })[0];
    if (!run) {
      const owner = this.sql(
        'SELECT runId FROM recoveryPoints WHERE attempt=? UNION ALL SELECT root FROM compensations WHERE id=? UNION ALL SELECT root FROM compensationRetries WHERE attempt=?',
      ).get(id, id, id);
      if (!owner) return deny(404);
      id = String(owner.runId);
      run = this.list({ id })[0];
    }
    if (!run) return deny(404);
    const effects = host.effects(id),
      calls = host
        .relations(id)
        .map(({ parent, child, node, batch, childState }) => ({ parent, child, node, batch, childState }));
    const recovery = this.sql(
      'SELECT failure,node,attempt,outcome,(data IS NOT NULL AND expires>?) AS retained FROM recoveryPoints WHERE runId=? OR attempt=? ORDER BY rowid',
    )
      .all(this.now(), id, id)
      .map(({ failure, node, attempt, outcome, retained }) => ({
        failure,
        node,
        attempt,
        outcome,
        retained,
      }));
    const comp = host.compensationInfo(id);
    const compensation = {
      id: comp.id,
      state: comp.state,
      retries: this.sql('SELECT failure,attempt FROM compensationRetries WHERE root=? ORDER BY failure').all(
        id,
      ),
      steps: comp.steps.map(({ child, status, priority, failure }) => ({ child, status, priority, failure })),
    };
    const transitions = host.transitions(id);
    const history = this.sql('SELECT status,startedAt FROM history WHERE id=? AND workflowId=?').get(
      id,
      String(run.workflowId),
    );
    const wait = host.waitInfo(id);
    const eventExpired = wait?.mode === 'event' && host.isWaitDue(Number(wait.dueAt));
    const mayRestore = run.state === 'finished' && !compensation.id &&
      (compensation.steps.length > 0 || recovery.some((point) => point.retained && !point.attempt));
    const publicationUnavailable = mayRestore && !host.canRestorePublication(String(run.workflowId), Number(run.revision));
    const version = digest(JSON.stringify([
      run, effects, recovery, compensation, transitions, wait?.token, eventExpired, publicationUnavailable,
    ]));
    return {
      run,
      effects,
      calls,
      recovery,
      compensation,
      transitions,
      history,
      version,
      waitingForEvent: wait?.mode === 'event',
      waitMode: wait?.mode,
      eventExpired,
      publicationUnavailable,
    };
  }
  private guidance(host: NodeHost, detail: ReturnType<OperatorStore['detail']>, allowed: string[]) {
    const { run, effects, compensation, recovery, transitions, waitMode } = detail;
    const id = String(run.runId);
    const canceled = transitions.some((entry) => entry.reason === 'cancelRequested');
    const actions: (
      | { op: 'resume' | 'cancel' | 'compensate' }
      | { op: 'reconcile'; key: string; node: string; decisions: string[] }
      | { op: 'redrive'; failure: string; node: string }
      | { op: 'retryCompensation'; failure: string }
    )[] = [];
    let reason = String(run.status);
    if (run.state === 'finished' && run.status === 'finished') reason = String(run.outcome ?? 'finished');
    if (run.state === 'waiting' && waitMode) reason = waitMode === 'event' ? 'awaitingEvent' : 'awaitingTime';
    const failed = run.state === 'finished' && run.outcome === 'error';
    const redrivePoints = failed && !canceled && !compensation.id
      ? recovery.filter((point) => point.retained && !point.attempt)
      : [];
    const compensable = run.state === 'finished' && compensation.steps.length > 0 && !compensation.id;
    if (detail.eventExpired) reason = 'eventExpired';
    if (redrivePoints.length) reason = 'recoverableFailure';
    if (detail.publicationUnavailable) reason = 'publicationUnavailable';
    if (canceled && run.state !== 'finished' && run.state !== 'review') reason = 'cancelRequested';

    if (run.state === 'waiting' && waitMode === 'event' && !detail.eventExpired && !canceled && allowed.includes('resume'))
      actions.push({ op: 'resume' });
    if (run.state === 'review' && allowed.includes('reconcile')) {
      for (const effect of effects) {
        if (effect.state !== 'unknown') continue;
        const decisions = ['applied', 'notApplied'];
        if (effect.mode === 'keyed' && !canceled && host.withinKeyedRetryWindow(id, Number(effect.item)))
          decisions.push('retryKeyed');
        actions.push({ op: 'reconcile', key: String(effect.key), node: String(effect.nodeId), decisions });
      }
    }
    if (!detail.publicationUnavailable && allowed.includes('redrive')) {
      for (const point of redrivePoints)
        actions.push({ op: 'redrive', failure: String(point.failure), node: String(point.node) });
    }
    if (allowed.includes('compensate')) {
      if (!detail.publicationUnavailable && compensable && !host.inspect(id).uncertain.length)
        actions.push({ op: 'compensate' });
      for (const step of compensation.steps) {
        if (step.status !== 'failed' || !step.failure) continue;
        if (!compensation.retries.some((retry) => retry.failure === step.failure))
          actions.push({ op: 'retryCompensation', failure: String(step.failure) });
      }
    }
    if (run.state !== 'finished' && run.state !== 'interrupted' && !canceled && allowed.includes('cancel'))
      actions.push({ op: 'cancel' });
    return { reason, actions };
  }
  recordAlerts(
    org: string,
    evaluate: (metrics: ReturnType<OperatorStore['metrics']>) => { kind: string; run: string | null }[],
  ) {
    return this.atomic(() => {
      const active = evaluate(this.metrics());
      const changes = [];
      for (const kind of ['queue', 'review', 'compensation', 'heartbeat']) {
        const next = active.find((a) => a.kind === kind);
        const old = this.sql('SELECT run,active FROM operator_alerts WHERE kind=?').get(kind);
        if (next ? old?.active === 1 && old.run === next.run : !old?.active) continue;
        const run = next ? next.run : old?.run == null ? null : String(old.run);
        this.sql(
          'INSERT INTO operator_alerts VALUES(?,?,?,?) ON CONFLICT(kind) DO UPDATE SET run=excluded.run,active=excluded.active,stamp=excluded.stamp',
        ).run(kind, run, Number(Boolean(next)), this.now());
        changes.push({ kind, run, active: Boolean(next), organization: org });
      }
      return changes;
    });
  }
  metrics() {
    const now = this.now();
    const oldest = (state: string) =>
      this.sql('SELECT runId,acceptedAt FROM runs WHERE state=? ORDER BY acceptedAt,runId LIMIT 1').get(
        state,
      );
    const queue = oldest('queued');
    const review = this.sql('SELECT runId,stamp FROM review_clock ORDER BY stamp,runId LIMIT 1').get();
    const beat = this.sql('SELECT MAX(stamp) AS stamp FROM worker_health').get()?.stamp ?? null;
    const oldestOwner = this.shared
      ? this.sql(
          "SELECT r.runId,COALESCE(w.stamp,r.startedAt) AS stamp FROM leases l JOIN runs r ON r.runId=l.id LEFT JOIN worker_health w ON w.worker=l.owner WHERE r.state='running' ORDER BY COALESCE(w.stamp,r.startedAt) LIMIT 1",
        ).get()
      : undefined;
    const failed = this.sql(
      "SELECT count(*) AS n FROM compensationSteps WHERE status IN ('failed','manual')",
    ).get()!;
    const sample = this.sql(
      "SELECT root FROM compensationSteps WHERE status IN ('failed','manual') LIMIT 1",
    ).get();
    return {
      now,
      recovered: this.sql(
        'SELECT kind,run,stamp FROM operator_alerts WHERE active=0 ORDER BY stamp DESC',
      ).all(),
      lastHeartbeat: beat,
      oldestOwnerRun: oldestOwner?.runId ?? null,
      oldestOwnerHeartbeat: oldestOwner?.stamp ?? null,
      queueAgeMs: queue ? Math.max(0, now - Number(queue.acceptedAt)) : 0,
      queuedRun: queue?.runId ?? null,
      activeRun: oldest('running')?.runId ?? queue?.runId ?? null,
      reviewAgeMs: review ? Math.max(0, now - Number(review.stamp)) : 0,
      reviewRun: review?.runId ?? null,
      compensationFailures: Number(failed.n),
      compensationRun: sample?.root ?? null,
    };
  }
  execute(host: NodeHost, principal: Identity, q: Record<string, unknown>): unknown {
    if (!host.organization || principal.organization !== host.organization || !validPolicy(principal))
      return deny(403);
    try {
      return this.authorized(host, principal, q);
    } catch (error) {
      const op = q.op;
      if (
        typeof op === 'string' &&
        [
          'resume',
          'cancel',
          'redrive',
          'compensate',
          'retryCompensation',
          'reconcile',
          'publish',
          'activate',
          'release',
          'start',
          'membership',
          'credentials',
        ].includes(op)
      ) {
        try {
          this.atomic(() => {
            const target = typeof q.target === 'string' ? q.target : '';
            const known = this.sql(
              'SELECT 1 FROM runs WHERE runId=? UNION ALL SELECT 1 FROM publications WHERE workflowId=? LIMIT 1',
            ).get(target, target);
            const status = error instanceof OperatorError ? error.status : 400;
            this.sql('INSERT INTO operator_audit VALUES(?,?,?,?,?,?,?,?,?,?)').run(
              'rejected:' + randomUUID(),
              field(principal.actor),
              principal.organization,
              op,
              known ? target : 'sha256:' + digest(target),
              reasons.includes(String(q.reason)) ? String(q.reason) : 'unspecified',
              this.now(),
              '',
              JSON.stringify({ status }),
              '{}',
            );
          });
        } catch {
          /* Never turn a failed mutation into a success if the audit store is unavailable. */
        }
      }
      throw error;
    }
  }
  private authorized(host: NodeHost, principal: Identity, q: Record<string, unknown>): unknown {
    return this.atomic(() => {
      const actor = field(principal.actor);
      const stored = this.sql('SELECT policy FROM memberships WHERE actor=?').get(actor);
      const policy: Policy = stored ? JSON.parse(String(stored.policy)) : principal;
      if (!validPolicy(policy) || policy.role === 'disabled') return deny(403);
      const allowed = [...permissions[policy.role], ...(policy.grants ?? [])];
      const op = field(q.op);
      if (op === 'preview' || op === 'checkHttpGrants') {
        if (!allowed.includes('publish')) return deny(403);
        if (op === 'checkHttpGrants') return host.checkHttpGrants(q.workflow);
        return q.compareActive === true ? host.comparePublication(q.workflow) : host.previewPublication(q.workflow);
      }
      if (['session', 'list', 'detail', 'metrics', 'audit', 'history'].includes(op)) {
        if (op === 'session')
          return { actor, organization: principal.organization, role: policy.role, allowed };
        if (op === 'list') return this.list(q);
        if (op === 'detail') {
          const detail = this.detail(host, field(q.id));
          return { ...detail, guidance: this.guidance(host, detail, allowed) };
        }
        if (op === 'metrics') return this.metrics();
        if (op === 'history')
          return this.sql(
            'SELECT id,workflowId,startedAt,status FROM history WHERE workflowId=? ORDER BY startedAt DESC,rowid DESC LIMIT 50',
          ).all(field(q.workflow));
        const filters: string[] = [],
          values: Value[] = [];
        if (q.target) {
          filters.push('target=?');
          values.push(field(q.target));
        }
        if (q.before !== undefined) {
          const stamp = Number(q.before);
          if (!Number.isSafeInteger(stamp)) return deny(400);
          filters.push('(stamp<? OR (stamp=? AND request<?))');
          values.push(stamp, stamp, field(q.afterRequest));
        }
        return this.sql(
          'SELECT request,actor,organization,action,target,reason,stamp,result,changeinfo FROM operator_audit ' +
            (filters.length ? 'WHERE ' + filters.join(' AND ') : '') +
            ' ORDER BY stamp DESC,request DESC LIMIT 100',
        ).all(...values);
      }
      const permission = op === 'retryCompensation' ? 'compensate' : op;
      if (!allowed.includes(permission) || permission === 'read') return deny(403);
      const target = field(q.target),
        request = field(q.request, 80),
        reason = field(q.reason);
      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(request) || !reasons.includes(reason)) return deny(400);
      const fingerprint = digest(JSON.stringify(q));
      const prior = this.sql('SELECT actor,fingerprint,result FROM operator_audit WHERE request=?').get(
        request,
      );
      if (prior) {
        if (prior.actor !== actor || prior.fingerprint !== fingerprint) return deny(409);
        return JSON.parse(String(prior.result));
      }
      let result: string | number | boolean = true;
      let change: Record<string, unknown> = {};
      if (['resume', 'cancel', 'redrive', 'compensate', 'retryCompensation', 'reconcile'].includes(op)) {
        const current = this.detail(host, target);
        if (current.run.runId !== target || current.version !== q.version) return deny(409);
      }
      switch (op) {
        case 'membership': {
          if (!validPolicy(q.policy)) return deny(400);
          change = { role: q.policy.role, grants: q.policy.grants ?? [] };
          this.sql(
            'INSERT INTO memberships VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET policy=excluded.policy',
          ).run(target, JSON.stringify(change));
          break;
        }
        case 'credentials': {
          if (typeof q.enabled !== 'boolean' || !host.credentialIds.includes(target)) return deny(400);
          const version =
            q.credentialVersion === undefined
              ? (this.credentialAccess(target)?.version ?? null)
              : q.credentialVersion;
          if (
            version !== null &&
            (typeof version !== 'string' || !host.credentialVersions(target).includes(version))
          )
            return deny(400);
          this.sql(
            'INSERT INTO credential_access VALUES(?,?,?) ON CONFLICT(credential) DO UPDATE SET enabled=excluded.enabled,version=excluded.version',
          ).run(target, Number(q.enabled), version);
          change = { enabled: q.enabled, version };
          break;
        }
        case 'release': {
          if (typeof q.review !== 'string' || !/^[a-f0-9]{64}$/.test(q.review)) return deny(400);
          const workflow = parseWorkflow(q.workflow);
          if (workflow.id !== target) return deny(400);
          const current = host.comparePublication(workflow);
          if (current.review !== q.review) return deny(409);
          result = host.publish(workflow);
          host.activate(target, result);
          change = { previousRevision: current.activeRevision, revision: result };
          break;
        }
        case 'publish': {
          const workflow = q.workflow as Workflow;
          if (workflow?.id !== target) return deny(400);
          result = host.publish(workflow);
          break;
        }
        case 'activate':
          host.activate(target, Number(q.revision));
          change = { revision: Number(q.revision) };
          break;
        case 'start':
          // The audit transaction deduplicates operator commands independently of incoming events.
          result = host.accept(target, field(q.trigger), { items: [{ json: {} }] });
          break;
        case 'cancel':
          result = host.cancel(target);
          break;
        case 'resume': {
          const wait = host.waitInfo(target);
          if (wait?.mode !== 'event') return deny(409);
          result = host.resolveWait(target, String(wait.token), 'event', {});
          break;
        }
        case 'redrive':
          result = host.redrive(target, field(q.failure));
          change = { failure: q.failure };
          break;
        case 'compensate':
          result = host.compensate(target);
          break;
        case 'retryCompensation':
          result = host.retryCompensation(target, field(q.failure));
          change = { failure: q.failure };
          break;
        case 'reconcile': {
          if (q.decision !== 'applied' && q.decision !== 'notApplied' && q.decision !== 'retryKeyed')
            return deny(400);
          result = host.reconcile(target, field(q.key), q.decision, (q.result ?? {}) as JsonObject);
          change = { decision: q.decision, key: q.key };
          break;
        }
        default:
          return deny(400);
      }
      if (result === false) return deny(409);
      this.sql('INSERT INTO operator_audit VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        request,
        actor,
        principal.organization,
        op,
        target,
        reason,
        this.now(),
        fingerprint,
        JSON.stringify(result),
        JSON.stringify(change),
      );
      return result;
    });
  }
}
