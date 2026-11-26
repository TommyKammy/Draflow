import {
  isPlainObject,
  toJsonValue,
  type FilterCondition,
  type FilterOperator,
  type FilterValue,
  type Item,
  type JsonObject,
  type JsonValue,
  type PairedItem,
} from '@draflow/core';

export function pairing(item: Item, index: number, input = 0): PairedItem | PairedItem[] {
  return item.pairedItem ?? { item: index, input };
}

export function item(json: unknown, pairedItem?: PairedItem | PairedItem[]): Item {
  const result: Item = { json: toJsonObject(json) };
  if (pairedItem !== undefined) result.pairedItem = pairedItem;
  return result;
}

export function toJsonObject(value: unknown): JsonObject {
  if (isPlainObject(value)) return toJsonValue(value) as JsonObject;
  return { data: toJsonValue(value) };
}

export function toJson(value: unknown): JsonValue {
  return toJsonValue(value);
}

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function getPath(value: unknown, path: string): unknown {
  const parts = path.split('.').filter((part) => part !== '');
  let current: unknown = value;
  for (const part of parts) {
    if (UNSAFE_PATH_SEGMENTS.has(part)) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

export function setPath(target: JsonObject, path: string, value: JsonValue): void {
  const parts = path.split('.').filter((part) => part !== '');
  if (parts.length === 0) return;

  for (const part of parts) {
    if (UNSAFE_PATH_SEGMENTS.has(part)) {
      throw new Error(`Unsafe field path segment "${part}"`);
    }
  }

  let current: JsonObject = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (part === undefined) return;
    const existing = Object.prototype.hasOwnProperty.call(current, part)
      ? current[part]
      : undefined;
    if (!isPlainObject(existing)) {
      const next: JsonObject = {};
      current[part] = next;
      current = next;
    } else {
      current = existing;
    }
  }

  const last = parts[parts.length - 1];
  if (last !== undefined) current[last] = value;
}

export function fixedValues(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((entry) => isPlainObject(entry)) as Array<Record<string, unknown>>;
  }
  if (isPlainObject(value) && Array.isArray(value.values)) {
    return value.values.filter((entry) => isPlainObject(entry)) as Array<Record<string, unknown>>;
  }
  if (isPlainObject(value)) return [value as Record<string, unknown>];
  return [];
}

export function evaluateFilter(
  filter: FilterValue | undefined,
  loose: boolean,
  resolve: (value: unknown) => unknown = (value) => value,
): boolean {
  if (filter === undefined) return true;
  const conditions = filter.conditions ?? [];
  if (conditions.length === 0) return true;

  const results = conditions.map((condition) => {
    const left = resolve(condition.left);
    const right = resolve(condition.right ?? '');
    return matchCondition(condition, left, right, loose);
  });

  return filter.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
}

function matchCondition(
  condition: FilterCondition,
  rawLeft: unknown,
  rawRight: unknown,
  loose: boolean,
): boolean {
  const [left, right] = loose ? coercePair(rawLeft, rawRight) : [rawLeft, rawRight];

  switch (condition.operator) {
    case 'equals':
      return equals(left, right, loose);
    case 'notEquals':
      return !equals(left, right, loose);
    case 'contains':
      return contains(left, right);
    case 'notContains':
      return !contains(left, right);
    case 'startsWith':
      return String(left).startsWith(String(right));
    case 'endsWith':
      return String(left).endsWith(String(right));
    case 'regex':
      try {
        return new RegExp(String(right)).test(String(left));
      } catch {
        return false;
      }
    case 'gt':
      return compare(left, right) > 0;
    case 'gte':
      return compare(left, right) >= 0;
    case 'lt':
      return compare(left, right) < 0;
    case 'lte':
      return compare(left, right) <= 0;
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'isTrue':
      return isTrue(left);
    case 'isFalse':
      return !isTrue(left);
    case 'exists':
      return left !== null && left !== undefined;
    case 'notExists':
      return left === null || left === undefined;
    default:
      return false;
  }
}

const OPERATORS: FilterOperator[] = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'regex',
  'gt',
  'gte',
  'lt',
  'lte',
  'isEmpty',
  'isNotEmpty',
  'isTrue',
  'isFalse',
  'exists',
  'notExists',
];

export function isFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === 'string' && (OPERATORS as string[]).includes(value);
}

function equals(left: unknown, right: unknown, loose: boolean): boolean {
  if (loose) return String(left) === String(right);
  return left === right;
}

function contains(left: unknown, right: unknown): boolean {
  if (Array.isArray(left)) return left.some((entry) => entry === right);
  if (typeof left === 'string') return left.includes(String(right));
  if (isPlainObject(left)) return Object.prototype.hasOwnProperty.call(left, String(right));
  return false;
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function coercePair(left: unknown, right: unknown): [unknown, unknown] {
  if (typeof left === 'number' && typeof right === 'string' && right.trim() !== '') {
    const number = Number(right);
    if (Number.isFinite(number)) return [left, number];
  }
  if (typeof left === 'string' && typeof right === 'number' && left.trim() !== '') {
    const number = Number(left);
    if (Number.isFinite(number)) return [number, right];
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return [Boolean(left), Boolean(right)];
  }
  return [left, right];
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function isTrue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}
