import type { CredentialBinding, CredentialFetch, FetchLike } from '@draflow/core';

export type HttpGrant = {
  id: string;
  workflowId: string;
  nodeId: string;
  origin: string;
} & ({ kind: 'bearer' } | { kind: 'apiKey'; header: string });

export interface HttpAuth {
  grants: readonly HttpGrant[];
  resolve(id: string): Promise<string | undefined> | string | undefined;
}

class ResponseLimit extends Error {
  constructor() {
    super('HTTP response exceeds host byte limit');
  }
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new ResponseLimit();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ResponseLimit();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function reflectsSecret(bytes: Uint8Array, secret: string) {
  const text = new TextDecoder().decode(bytes);
  if (text.includes(secret)) return true;
  // A JSON string or property name can spell the value using Unicode escapes.
  if (!text.includes('\\')) return false;
  let found = false;
  try {
    JSON.parse(text, (key, value: unknown) => {
      if (key.includes(secret) || (typeof value === 'string' && value.includes(secret))) found = true;
      return value;
    });
  } catch {
    /* The HTTP node also supports plain text. */
  }
  return found;
}

function grantFor(binding: CredentialBinding, url: string, auth?: HttpAuth) {
  const target = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (
    target.username ||
    target.password ||
    !(target.protocol === 'https:' || (local && target.protocol === 'http:'))
  ) {
    throw new Error('HTTP credential destination denied');
  }
  const grant = auth?.grants.find(
    (rule) =>
      rule.id === binding.id &&
      rule.origin === target.origin &&
      rule.workflowId === binding.workflowId &&
      rule.nodeId === binding.nodeId,
  );
  if (
    !grant ||
    binding.type !== 'draflow.httpRequest' ||
    binding.typeVersion !== 2 ||
    binding.slot !== 'httpAuth'
  ) {
    throw new Error('HTTP credential not authorized');
  }
  return grant;
}

export function serverHttp(fetchFn: FetchLike, limit: number, auth?: HttpAuth): CredentialFetch {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid HTTP response byte limit');
  return async (binding, url, init) => {
    let secret: string | undefined;
    if (binding.id !== undefined) {
      const grant = grantFor(binding, url, auth);
      try {
        secret = await auth!.resolve(grant.id);
        if (!secret || secret !== secret.trim()) throw new Error();
        const headers = new Headers(init?.headers);
        const header = grant.kind === 'bearer' ? 'Authorization' : grant.header;
        if (headers.has('host') || headers.has(header)) throw new Error();
        headers.set(header, grant.kind === 'bearer' ? 'Bearer ' + secret : secret);
        init = { ...init, headers, redirect: 'error' };
      } catch {
        throw new Error('HTTP credential unavailable or invalid');
      }
    }
    let response: Response;
    let bytes: Uint8Array<ArrayBuffer> | null;
    try {
      init?.signal?.throwIfAborted();
      response = await fetchFn(url, init);
      bytes = await readBounded(response, limit);
    } catch (error) {
      if (error instanceof ResponseLimit) throw error;
      // Provider, transport and stream errors can contain request headers.
      throw new Error('HTTP request failed');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (secret && bytes && reflectsSecret(bytes, secret))
      throw new Error('HTTP response contained credential material');
    // Forward only the media-type distinction consumed by the standard HTTP node.
    const json = response.headers.get('content-type')?.includes('json');
    return new Response(bytes, {
      status: response.status,
      headers: { 'content-type': json ? 'application/json' : 'text/plain' },
    });
  };
}
