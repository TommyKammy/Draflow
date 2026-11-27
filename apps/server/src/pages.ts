import { isPlainObject, type CredentialFetch, type JsonObject, type WorkflowNode } from '@draflow/core';

export function pageConfig(node: WorkflowNode) {
  const integer = (key: string, fallback: number) => {
    const n = node.parameters[key] ?? fallback;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) throw new Error('Invalid ' + key);
    return n;
  };
  const url = new URL(String(node.parameters.url));
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.has('cursor')
  )
    throw new Error('Invalid fixed page endpoint');
  return {
    url,
    pageSize: integer('pageSize', 100),
    batchSize: integer('batchSize', 25),
    maxPages: integer('maxPages', 10000),
    maxItems: integer('maxItems', 1000000),
    maxBytes: integer('maxBytes', 268435456),
    sumField: String(node.parameters.sumField ?? ''),
    maxAttempts: integer('maxAttempts', 5),
    deadlineMs: integer('deadlineMs', 86400000),
  };
}

export async function readPage(
  fetchPage: CredentialFetch,
  workflowId: string,
  node: WorkflowNode,
  cursor: string | null,
  signal: AbortSignal,
) {
  const { url, pageSize, sumField } = pageConfig(node);
  url.searchParams.set('limit', String(pageSize));
  if (cursor !== null) url.searchParams.set('cursor', cursor);
  const credential = node.credentials?.httpAuth;
  if (credential !== undefined && !credential) throw new Error('Page credential unavailable');
  const response = await fetchPage(
    {
      workflowId,
      nodeId: node.id,
      type: node.type,
      typeVersion: node.typeVersion,
      slot: 'httpAuth',
      ...(credential && { id: credential }),
    },
    url.href,
    { method: 'GET', redirect: 'error', signal },
  );
  const bytes = await response.arrayBuffer();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Invalid page JSON');
  }
  if (
    !isPlainObject(body) ||
    !Array.isArray(body.items) ||
    !body.items.every(isPlainObject) ||
    body.items.length > pageSize ||
    !(body.nextCursor === null || (typeof body.nextCursor === 'string' && body.nextCursor.length > 0))
  )
    throw new Error('Expected bounded items and nextCursor (string or null)');
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Page exceeds recovery byte limit');
  const rows = body.items as JsonObject[];
  if (sumField && rows.some((row) => typeof row[sumField] !== 'number' || !Number.isFinite(row[sumField])))
    throw new Error('Invalid page sum field');
  return { rows, next: body.nextCursor as string | null, bytes: bytes.byteLength };
}

export function retryTime(header: string | null, now: number, attempt: number) {
  const value = header?.trim();
  if (value && /^\d+$/.test(value)) return now + Number(value) * 1000;
  if (value && /GMT$/i.test(value)) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return Math.max(now, time);
  }
  return now + Math.min(60000, 1000 * 2 ** Math.min(attempt - 1, 6));
}
