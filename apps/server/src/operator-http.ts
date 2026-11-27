import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { NodeHost } from './host.js';
import { validPolicy, OperatorError, type Identity } from './operator-store.js';

export interface OperatorAccount extends Identity {
  sha256: string;
}
const reads = ['session', 'list', 'detail', 'metrics', 'audit', 'history'];
export function createOperatorServer(
  hosts: NodeHost[],
  accounts: () => readonly OperatorAccount[],
  thresholdMs = 30000,
  onAlert?: (event: OperatorAlert) => void,
) {
  const tenants = new Map(hosts.map((h) => [h.organization, h]));
  if (tenants.has(undefined) || tenants.size !== hosts.length)
    throw Error('Expected unique organization-bound hosts');
  if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 1000) throw Error('Invalid monitor threshold');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const asset = (
        {
          '/operator/': 'index.html',
          '/operator/console.js': 'console.js',
          '/operator/console.css': 'console.css',
        } as Record<string, string>
      )[url.pathname];
      if (req.method === 'GET' && typeof asset === 'string') {
        const mime = asset.endsWith('.js')
          ? 'text/javascript'
          : asset.endsWith('.css')
            ? 'text/css'
            : 'text/html';
        res.setHeader('Content-Type', mime + '; charset=utf-8');
        res.end(readFileSync(new URL('../operator/' + asset, import.meta.url)));
        return;
      }
      const path = /^\/operator\/([^/]+)\/api$/.exec(url.pathname);
      if (!path) throw new OperatorError(404);
      const org = decodeURIComponent(path[1]!);
      const token = /^Bearer ([\x21-\x7e]{24,512})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new OperatorError(401);
      const hash = createHash('sha256').update(token).digest();
      const host = tenants.get(org);
      const authenticate = () => {
        let credentials: readonly OperatorAccount[];
        try {
          credentials = accounts();
          if (!Array.isArray(credentials)) throw Error();
        } catch {
          throw new OperatorError(503);
        }
        const matches: OperatorAccount[] = credentials.filter(
          (a) => a && /^[a-f0-9]{64}$/.test(a.sha256) && timingSafeEqual(Buffer.from(a.sha256, 'hex'), hash),
        );
        if (matches.length !== 1) throw new OperatorError(401);
        const principal = matches[0]!;
        if (principal.organization !== org || !validPolicy(principal)) throw new OperatorError(403);
        return principal;
      };
      let principal = authenticate();
      if (!host) throw new OperatorError(403);
      let command: Record<string, unknown>;
      if (req.method === 'GET') {
        command = Object.fromEntries(url.searchParams);
        if (!reads.includes(String(command.op))) throw new OperatorError(405);
      } else if (req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new OperatorError(415);
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) throw new OperatorError(413);
          chunks.push(chunk);
        }
        try {
          command = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new OperatorError(400);
        }
        if (!command || typeof command !== 'object' || Array.isArray(command)) throw new OperatorError(400);
        // Recheck the credential after a potentially slow upload as well as the ledger role at commit.
        principal = authenticate();
      } else throw new OperatorError(405);
      const result = host.operate(principal, command);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          command.op === 'metrics'
            ? {
                ...(result as object),
                thresholdMs,
                alerts: operatorAlerts(result as ReturnType<NodeHost['operatorMetrics']>, thresholdMs),
              }
            : result,
        ),
      );
    } catch (e) {
      res.statusCode = e instanceof OperatorError ? e.status : 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: res.statusCode }));
    }
  });
  if (onAlert) {
    let timer: ReturnType<typeof setInterval>;
    server.on('listening', () => {
      timer = setInterval(
        () => {
          for (const host of hosts) {
            try {
              for (const event of host.recordOperatorAlerts((metrics) =>
                operatorAlerts(metrics, thresholdMs),
              ))
                onAlert(event);
            } catch {
              /* A lost DB session is handled by the host supervisor. */
            }
          }
        },
        Math.max(250, Math.min(1000, thresholdMs / 4)),
      );
      timer.unref();
    });
    server.on('close', () => clearInterval(timer));
  }
  return server;
}
export interface OperatorAlert {
  organization: string;
  kind: string;
  run: string | null;
  active: boolean;
}
function operatorAlerts(m: ReturnType<NodeHost['operatorMetrics']>, threshold: number) {
  const alerts: { kind: string; run: string | null }[] = [];
  const add = (kind: string, id: unknown) => alerts.push({ kind, run: typeof id === 'string' ? id : null });
  if (
    m.oldestOwnerRun &&
    m.oldestOwnerHeartbeat !== null &&
    m.now - Number(m.oldestOwnerHeartbeat) >= threshold
  )
    add('heartbeat', m.oldestOwnerRun);
  else if (m.lastHeartbeat === null || m.now - Number(m.lastHeartbeat) >= threshold)
    add('heartbeat', m.activeRun);
  if (m.queueAgeMs >= threshold) add('queue', m.queuedRun);
  if (m.reviewAgeMs >= threshold) add('review', m.reviewRun);
  if (m.compensationFailures > 0) add('compensation', m.compensationRun);
  return alerts;
}
