import {
  isPlainObject,
  toJsonValue,
  type Item,
  type JsonObject,
  type NodeType,
} from '@draflow/core';
import { pairing, toJsonObject } from './helpers.js';

export const httpRequestNode: NodeType = {
  type: 'draflow.httpRequest',
  version: 1,
  meta: {
    label: 'HTTP Request',
    category: 'network',
    description: 'Makes an HTTP request and returns the response data',
    icon: 'globe',
  },
  ports: {
    inputs: [{ type: 'main', required: true }],
    outputs: [{ type: 'main' }],
  },
  parameters: [
    {
      name: 'method',
      label: 'Method',
      type: 'select',
      default: 'GET',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((value) => ({
        label: value,
        value,
      })),
    },
    {
      name: 'url',
      label: 'URL',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://api.example.com/items',
    },
    {
      name: 'headers',
      label: 'Headers',
      type: 'json',
      default: {},
      description: 'JSON object of request headers',
    },
    {
      name: 'body',
      label: 'Body',
      type: 'json',
      default: {},
      description: 'JSON object or string sent as the request body',
    },
    {
      name: 'responseFormat',
      label: 'Response Format',
      type: 'select',
      default: 'json',
      options: [
        { label: 'JSON', value: 'json' },
        { label: 'Text', value: 'text' },
      ],
    },
    {
      name: 'timeout',
      label: 'Timeout (ms)',
      type: 'number',
      default: 30_000,
      min: 1,
      max: 300_000,
    },
  ],
  async execute(ctx) {
    const output: Item[] = [];

    await ctx.each(async (input, itemCtx, index) => {
      const method = itemCtx.param<string>('method', 'GET').toUpperCase();
      const url = itemCtx.param<string>('url', '');
      if (url === '') throw new Error('URL is required');

      const headers = normalizeHeaders(itemCtx.param<unknown>('headers', {}));
      const bodyValue = itemCtx.param<unknown>('body', {});
      const responseFormat = itemCtx.param<string>('responseFormat', 'json');
      const timeout = itemCtx.param<number>('timeout', 30_000);

      const init: RequestInit = {
        method,
        headers,
      };
      if (method !== 'GET' && method !== 'HEAD' && bodyValue !== undefined && bodyValue !== null) {
        if (typeof bodyValue === 'string') {
          init.body = bodyValue;
        } else {
          init.body = JSON.stringify(bodyValue);
          const hasContentType = Object.keys(headers).some(
            (key) => key.toLowerCase() === 'content-type',
          );
          if (!hasContentType) {
            headers['content-type'] = 'application/json';
          }
        }
      }

      const authentication = itemCtx.param<string>('authentication', 'none');
      if (authentication !== 'none' && authentication !== 'credential') {
        throw new Error('Unsupported HTTP authentication mode');
      }
      const required = authentication === 'credential';
      const scopedFetch = ctx.credentials.fetchForSlot?.('httpAuth', required);
      if (required && !scopedFetch) {
        throw new Error('HTTP credential unavailable');
      }
      const keyed = ctx.journalItem && ctx.param('delivery') === 'keyed';
      if (keyed && Object.keys(headers).some(name => name.toLowerCase() === 'idempotency-key'))
        throw new Error('Recorded delivery owns the Idempotency-Key header');
      ctx.signal.throwIfAborted();
      const send = (key?: string) => {
        if (key && keyed) {
          init.headers = { ...headers, 'Idempotency-Key': key };
        }
        return withTimeout(
          scopedFetch ?? ctx.helpers.fetch,
          url,
          init,
          timeout,
          ctx.signal,
          async (response) => {
            if (!response.ok) {
              const text = await response.text().catch(() => '');
              throw new Error(
                `HTTP ${response.status} ${response.statusText}${text === '' ? '' : `: ${text.slice(0, 500)}`}`,
              );
            }
            return readResponse(response, responseFormat);
          },
        );
      };
      const json = ctx.journalItem
        ? await ctx.journalItem(index, JSON.stringify([method, url, headers, init.body, responseFormat]), send)
        : await send();
      output.push({ json, pairedItem: pairing(input, index) });
    });

    return output;
  },
};

export const httpRequestNodeV2: NodeType = {
  ...httpRequestNode,
  version: 2,
  journalMode(node) {
    const mode = node.parameters.delivery;
    if (mode === undefined || mode === 'none') return;
    if (mode !== 'keyed' && mode !== 'manual') throw new Error('Invalid recorded delivery mode');
    return mode;
  },
  credentials: [{ name: 'httpAuth', label: 'HTTP authentication' }],
  parameters: [
    {
      name: 'delivery', label: 'Recorded delivery', type: 'select', default: 'none', noExpression: true,
      options: [{ label: 'Off', value: 'none' }, { label: 'Receiver supports idempotency keys', value: 'keyed' },
        { label: 'Manually reconcile uncertain sends', value: 'manual' }],
    },
    {
      name: 'authentication', label: 'Authentication', type: 'select', default: 'none',
      options: [{ label: 'None', value: 'none' }, { label: 'Server credential', value: 'credential' }],
      noExpression: true,
    },
    ...httpRequestNode.parameters,
  ],
};

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    headers[key] = String(entry);
  }
  return headers;
}

async function readResponse(response: Response, format: string): Promise<JsonObject> {
  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return {};
  }

  if (response.headers.get('content-length') === '0') {
    return {};
  }

  const text = await response.text();
  if (text === '' || (format !== 'text' && text.trim() === '')) {
    return {};
  }

  if (format === 'text') {
    return { data: text };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    try {
      return toJsonObject(JSON.parse(text));
    } catch {
      return { data: text };
    }
  }

  const parsed: unknown = JSON.parse(text);
  if (isPlainObject(parsed)) return toJsonValue(parsed) as JsonObject;
  return { data: toJsonValue(parsed) };
}

async function withTimeout<T>(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  timeout: number,
  signal: AbortSignal,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeout} ms`));
  }, Math.max(1, timeout));

  const onAbort = (): void => {
    controller.abort(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await raceWithAbort(
      fetchFn(url, { ...init, signal: controller.signal }),
      controller.signal,
    );
    return await raceWithAbort(consume(response), controller.signal);
  } catch (error) {
    if (timedOut) throw new Error(`Request timed out after ${timeout} ms`);
    if (signal.aborted) throw new Error('Request aborted');
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Request aborted');
}
