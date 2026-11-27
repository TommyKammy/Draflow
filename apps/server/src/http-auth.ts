import { AsyncLocalStorage } from 'node:async_hooks';
import type { CredentialBinding, CredentialFetch, FetchLike } from '@draflow/core';

export type HttpGrant = {
  id: string;
  workflowId: string;
  nodeId: string;
  origin: string;
} & ({ kind: 'bearer' } | { kind: 'apiKey'; header: string });

export interface HttpAuth {
  organization?: string;
  grants: readonly HttpGrant[];
  resolve(id: string): Promise<string | undefined> | string | undefined;
}

export const recordedTransport = new AsyncLocalStorage<{
  defer(): void;
  dispatch(): void;
}>();

export interface RateGate {
  reserve?(target: string): { delay: number; release?: () => void };
  remaining(target: string): number;
  wait(ms: number, signal?: AbortSignal | null): Promise<void>;
  hold(target: string, header: string | null): void;
}
export const sharedRateLimit = new AsyncLocalStorage<RateGate>();

export class UnsentCredentialError extends Error {}

export class ReadDeferred extends Error {
  constructor(readonly delayMs: number) {
    super('Page read deferred by shared cooldown');
  }
}

export class ReadThrottled extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super('HTTP ' + status);
  }
}

class ResponseLimit extends Error {
  constructor() {
    super('HTTP response exceeds host byte limit');
  }
}

async function readBounded(
  response: Response,
  limit: number,
  signal?: AbortSignal | null,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal?.throwIfAborted();
    if (Number(response.headers.get('content-length')) > limit) throw new ResponseLimit();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ResponseLimit();
      chunks.push(value);
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
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
  // The HTTP node attempts JSON decoding even when the upstream returns plain text.
  // Check the values as they would appear in execution output, including normalized numbers.
  const pending: unknown[] = [];
  try {
    pending.push(JSON.parse(text));
  } catch {
    return false;
  }
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const entry of value) pending.push(entry);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (key.includes(secret)) return true;
        pending.push(entry);
      }
    } else if (String(value).includes(secret)) {
      return true;
    }
  }
  return false;
}

function grantFor(binding: CredentialBinding, url: string, auth?: HttpAuth) {
  const target = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (
    target.username ||
    target.password ||
    !(target.protocol === 'https:' || (local && target.protocol === 'http:'))
  ) {
    throw new UnsentCredentialError('HTTP credential destination denied');
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
    !(
      (binding.type === 'draflow.httpRequest' && binding.typeVersion === 2) ||
      (binding.type === 'draflow.pages' && binding.typeVersion === 1)
    ) ||
    binding.slot !== 'httpAuth'
  ) {
    throw new UnsentCredentialError('HTTP credential not authorized');
  }
  return grant;
}

export function serverHttp(
  fetchFn: FetchLike,
  limit: number,
  auth?: HttpAuth,
  activeGate?: () => RateGate | undefined,
): CredentialFetch {
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
        throw new UnsentCredentialError('HTTP credential unavailable or invalid');
      }
    }
    let response: Response;
    let bytes: Uint8Array<ArrayBuffer> | null;
    const publisher = sharedRateLimit.getStore();
    const gate = publisher ?? activeGate?.();
    const target = gate ? JSON.stringify([new URL(url).origin, binding.id ?? null]) : '';
    let release: (() => void) | undefined;
    try {
      if (gate) {
        for (;;) {
          const permit = gate.reserve?.(target);
          const remaining = permit?.delay ?? gate.remaining(target);
          if (remaining <= 0) {
            release = permit?.release;
            break;
          }
          if (binding.type === 'draflow.pages') throw new ReadDeferred(remaining);
          recordedTransport.getStore()?.defer();
          await gate.wait(remaining, init?.signal);
        }
      }
      init?.signal?.throwIfAborted();
      recordedTransport.getStore()?.dispatch();
      try {
        init?.signal?.throwIfAborted();
        response = await fetchFn(url, init);
        if (response.status === 429 || response.status === 503)
          (publisher ?? (gate?.reserve ? gate : undefined))?.hold(
            target,
            response.headers.get('retry-after'),
          );
        if (binding.type === 'draflow.pages' && (response.status === 429 || response.status === 503)) {
          void response.body?.cancel().catch(() => {});
          throw new ReadThrottled(response.status, response.headers.get('retry-after'));
        }
        if (binding.type === 'draflow.pages' && response.status === 410) {
          void response.body?.cancel().catch(() => {});
          bytes = null;
        } else bytes = await readBounded(response, limit, init?.signal);
      } catch (error) {
        if (error instanceof ResponseLimit || error instanceof ReadThrottled) throw error;
        // Provider, transport and stream errors can contain request headers.
        throw new Error('HTTP request failed');
      }
    } finally {
      release?.();
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
