import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isPlainObject, type JsonObject, type JsonValue } from '@draflow/core';
import { NodeHost, WebhookGone } from './host.js';

interface WebhookOptions {
  signingKey: string | ((path: string) => string | undefined);
  maxBodyBytes?: number;
}

class Rejected extends Error {
  constructor(readonly status: number) {
    super();
  }
}

async function bodyBytes(request: IncomingMessage, limit: number) {
  if (Number(request.headers['content-length']) > limit) throw new Rejected(413);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) throw new Rejected(413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function singleHeader(request: IncomingMessage, name: string) {
  const values = request.headersDistinct[name];
  if (values && values.length !== 1) throw new Rejected(400);
  return values?.[0];
}

export function createWebhookServer(host: NodeHost, options: WebhookOptions) {
  const limit = options.maxBodyBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid Webhook body limit');
  if (!options.signingKey) throw new Error('Webhook signing key required');

  async function deliver(request: IncomingMessage) {
    if (request.method !== 'POST') throw new Rejected(405);
    const path = request.url ?? '';
    const resume = /^\/resume\/([a-f0-9-]{36})$/.exec(path);
    if (resume) {
      const id = resume[1]!;
      const token = singleHeader(request, 'authorization')?.match(/^Bearer ([a-f0-9-]{36})$/)?.[1];
      if (!token) throw new Rejected(401);
      const expected = host.waitInfo(id)?.token;
      if (typeof expected !== 'string' || !timingSafeEqual(Buffer.from(token), Buffer.from(expected)))
        throw new Rejected(404);
      const bytes = await bodyBytes(request, Math.min(limit, 64 * 1024));
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new Rejected(400);
      }
      if (!isPlainObject(payload)) throw new Rejected(400);
      if (!host.resolveWait(id, token, 'event', payload as JsonObject)) throw new Rejected(409);
      return id;
    }
    const target = host.webhook(path);
    if (!target) throw new Rejected(404);
    const signature = singleHeader(request, 'x-draflow-signature');
    if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) throw new Rejected(401);
    const delivery = singleHeader(request, 'x-draflow-delivery');
    if (delivery !== undefined && !/^[!-~]{1,256}$/.test(delivery)) throw new Rejected(400);
    const bytes = await bodyBytes(request, limit);
    const key = typeof options.signingKey === 'function' ? options.signingKey(path) : options.signingKey;
    if (!key) throw new Rejected(401);
    const digest = createHmac('sha256', key)
      .update(path + '\n' + (delivery ?? '') + '\n')
      .update(bytes)
      .digest();
    if (!timingSafeEqual(digest, Buffer.from(signature.slice(7), 'hex'))) throw new Rejected(401);
    let body: JsonValue;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Rejected(400);
    }
    return host.acceptWebhook(path, target, {
      items: [{ json: { body } }],
      ...(delivery !== undefined && { key: delivery }),
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    try {
      const runId = await deliver(request);
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ runId }));
    } catch (error) {
      const status = error instanceof Rejected ? error.status : error instanceof WebhookGone ? 404 : 503;
      response.writeHead(status, { connection: 'close', ...(status === 405 && { allow: 'POST' }) });
      response.end();
    }
  }
  return createServer((request, response) => {
    void handle(request, response);
  });
}
