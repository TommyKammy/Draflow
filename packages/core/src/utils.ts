import type { JsonObject, JsonValue } from './types.js';

export function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPlainObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

export function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry)) as T;
  }
  if (isPlainObject(value)) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = cloneJson(entry);
    }
    return result as T;
  }
  return value;
}

/**
 * Converts an arbitrary value to JSON-safe data. Undefined becomes null,
 * class instances become their JSON representation when possible.
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value as string | boolean;
  if (type === 'number') return Number.isFinite(value as number) ? (value as number) : null;
  if (type === 'bigint') return (value as bigint).toString();
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry));
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = toJsonValue(entry);
    }
    return result;
  }
  return String(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

export function createId(prefix = 'id'): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random !== undefined) return `${prefix}_${random}`;
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function stringifyUnknown(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
