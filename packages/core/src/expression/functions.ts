import { ExpressionError } from '../errors.js';
import { isPlainObject } from '../utils.js';
import { DraflowDateTime } from './date.js';

export interface ExtensionContext {
  source: string;
  timezone: string;
  nowMillis: number;
  invoke(fn: unknown, args: unknown[]): unknown;
}

export function callExtension(
  receiver: unknown,
  name: string,
  args: unknown[],
  ctx: ExtensionContext,
): unknown {
  if (typeof receiver === 'string') return callString(receiver, name, args, ctx);
  if (typeof receiver === 'number') return callNumber(receiver, name, args, ctx);
  if (typeof receiver === 'boolean') return callBoolean(receiver, name, args, ctx);
  if (Array.isArray(receiver)) return callArray(receiver, name, args, ctx);
  if (receiver instanceof DraflowDateTime) return callDateTime(receiver, name, args, ctx);
  if (isPlainObject(receiver)) return callObject(receiver, name, args, ctx);

  throw new ExpressionError(`Cannot call method "${name}" on ${describe(receiver)}`, {
    expression: ctx.source,
  });
}

function callString(
  value: string,
  name: string,
  args: unknown[],
  ctx: ExtensionContext,
): unknown {
  switch (name) {
    case 'toUpperCase':
      return value.toUpperCase();
    case 'toLowerCase':
      return value.toLowerCase();
    case 'trim':
      return value.trim();
    case 'trimStart':
      return value.trimStart();
    case 'trimEnd':
      return value.trimEnd();
    case 'split': {
      const separator = args[0] === undefined ? undefined : String(args[0]);
      const limit = typeof args[1] === 'number' ? args[1] : undefined;
      return value.split(separator as string, limit);
    }
    case 'replace':
      return value.replace(String(args[0] ?? ''), String(args[1] ?? ''));
    case 'replaceAll':
      return value.split(String(args[0] ?? '')).join(String(args[1] ?? ''));
    case 'includes':
      return value.includes(String(args[0] ?? ''));
    case 'startsWith':
      return value.startsWith(String(args[0] ?? ''));
    case 'endsWith':
      return value.endsWith(String(args[0] ?? ''));
    case 'slice':
      return value.slice(numberArg(args, 0, 0), args[1] === undefined ? undefined : numberArg(args, 1, 0));
    case 'substring':
      return value.substring(numberArg(args, 0, 0), args[1] === undefined ? undefined : numberArg(args, 1, 0));
    case 'padStart':
      return value.padStart(numberArg(args, 0, 0), String(args[1] ?? ' '));
    case 'padEnd':
      return value.padEnd(numberArg(args, 0, 0), String(args[1] ?? ' '));
    case 'repeat':
      return value.repeat(numberArg(args, 0, 0));
    case 'indexOf':
      return value.indexOf(String(args[0] ?? ''));
    case 'lastIndexOf':
      return value.lastIndexOf(String(args[0] ?? ''));
    case 'charAt':
      return value.charAt(numberArg(args, 0, 0));
    case 'length':
      return value.length;
    case 'isEmpty':
      return value.length === 0;
    case 'isNotEmpty':
      return value.length > 0;
    case 'toNumber':
    case 'toFloat':
      return Number(value);
    case 'toInt':
      return Number.parseInt(value, 10);
    case 'toBoolean':
      return toBoolean(value);
    case 'toJsonString':
      return JSON.stringify(value);
    case 'parseJson':
      return JSON.parse(value);
    case 'toDateTime':
    case 'toDate':
      return DraflowDateTime.fromISO(value, ctx.timezone);
    case 'base64Encode':
      return base64Encode(value);
    case 'base64Decode':
      return base64Decode(value);
    case 'urlEncode':
      return encodeURIComponent(value);
    case 'urlDecode':
      return decodeURIComponent(value);
    case 'isEmail':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'isUrl':
      return isUrl(value);
    case 'isNumeric':
      return value.trim() !== '' && Number.isFinite(Number(value));
    case 'isDomain':
      return /^(?!-)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value);
    case 'toSentenceCase':
      return toSentenceCase(value);
    case 'toSnakeCase':
      return toSnakeCase(value);
    case 'toTitleCase':
      return toTitleCase(value);
    case 'removeTags':
      return value.replace(/<[^>]*>/g, '');
    case 'removeMarkdown':
      return removeMarkdown(value);
    case 'replaceSpecialChars':
      return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    case 'extractEmail':
      return value.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0];
    case 'extractDomain':
      return extractDomain(value);
    case 'extractUrl':
      return value.match(/https?:\/\/[^\s]+/)?.[0];
    case 'extractUrlPath':
      return extractUrlPath(value);
    case 'quote':
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    case 'toString':
      return value;
    default:
      throw unknownMethod(name, 'string', ctx);
  }
}

function callNumber(
  value: number,
  name: string,
  args: unknown[],
  ctx: ExtensionContext,
): unknown {
  switch (name) {
    case 'ceil':
      return Math.ceil(value);
    case 'floor':
      return Math.floor(value);
    case 'round':
      return round(value, numberArg(args, 0, 0));
    case 'abs':
      return Math.abs(value);
    case 'isInteger':
      return Number.isInteger(value);
    case 'isEven':
      return Number.isInteger(value) && value % 2 === 0;
    case 'isOdd':
      return Number.isInteger(value) && Math.abs(value % 2) === 1;
    case 'toBoolean':
      return toBoolean(value);
    case 'toDateTime':
    case 'toDate':
      return DraflowDateTime.fromMillis(value, ctx.timezone);
    case 'toNumber':
      return value;
    case 'toInt':
      return Math.trunc(value);
    case 'format':
      return formatNumber(value, args);
    case 'toString':
      return String(value);
    case 'isEmpty':
      return false;
    default:
      throw unknownMethod(name, 'number', ctx);
  }
}

function callBoolean(
  value: boolean,
  name: string,
  _args: unknown[],
  ctx: ExtensionContext,
): unknown {
  switch (name) {
    case 'toNumber':
      return value ? 1 : 0;
    case 'toString':
      return String(value);
    case 'toBoolean':
      return value;
    case 'isEmpty':
      return false;
    default:
      throw unknownMethod(name, 'boolean', ctx);
  }
}

function callArray(
  value: unknown[],
  name: string,
  args: unknown[],
  ctx: ExtensionContext,
): unknown {
  switch (name) {
    case 'length':
      return value.length;
    case 'first':
      return value[0];
    case 'last':
      return value[value.length - 1];
    case 'isEmpty':
      return value.length === 0;
    case 'isNotEmpty':
      return value.length > 0;
    case 'join':
      return value.join(String(args[0] ?? ','));
    case 'slice':
      return value.slice(numberArg(args, 0, 0), args[1] === undefined ? undefined : numberArg(args, 1, 0));
    case 'concat':
      return value.concat(...args.map((entry) => (Array.isArray(entry) ? entry : [entry])));
    case 'includes':
      return value.some((entry) => strictEqual(entry, args[0]));
    case 'indexOf':
      return value.findIndex((entry) => strictEqual(entry, args[0]));
    case 'reverse':
      return [...value].reverse();
    case 'map':
      return value.map((entry, index) => ctx.invoke(args[0], [entry, index, value]));
    case 'flatMap':
      return value.flatMap((entry, index) => {
        const mapped = ctx.invoke(args[0], [entry, index, value]);
        return Array.isArray(mapped) ? mapped : [mapped];
      });
    case 'filter':
      return value.filter((entry, index) => Boolean(ctx.invoke(args[0], [entry, index, value])));
    case 'find':
      return value.find((entry, index) => Boolean(ctx.invoke(args[0], [entry, index, value])));
    case 'findIndex':
      return value.findIndex((entry, index) => Boolean(ctx.invoke(args[0], [entry, index, value])));
    case 'some':
      return value.some((entry, index) => Boolean(ctx.invoke(args[0], [entry, index, value])));
    case 'every':
      return value.every((entry, index) => Boolean(ctx.invoke(args[0], [entry, index, value])));
    case 'forEach':
      value.forEach((entry, index) => {
        ctx.invoke(args[0], [entry, index, value]);
      });
      return value;
    case 'reduce': {
      const reducer = args[0];
      if (value.length === 0 && args.length < 2) {
        throw new ExpressionError('reduce() of empty array with no initial value', {
          expression: ctx.source,
        });
      }
      let accumulator: unknown = args.length >= 2 ? args[1] : value[0];
      const start = args.length >= 2 ? 0 : 1;
      for (let index = start; index < value.length; index += 1) {
        accumulator = ctx.invoke(reducer, [accumulator, value[index], index, value]);
      }
      return accumulator;
    }
    case 'flat':
      return value.flat(numberArg(args, 0, 1));
    case 'sort':
      return [...value].sort((a, b) =>
        args[0] === undefined
          ? compareValues(a, b)
          : Number(ctx.invoke(args[0], [a, b])),
      );
    case 'unique':
      return uniqueValues(value);
    case 'compact':
      return value.filter((entry) => entry !== null && entry !== undefined && entry !== '');
    case 'sum':
      return value.reduce((total: number, entry) => total + Number(entry), 0);
    case 'min':
      return value.length === 0 ? undefined : Math.min(...value.map(Number));
    case 'max':
      return value.length === 0 ? undefined : Math.max(...value.map(Number));
    case 'average':
      return value.length === 0 ? 0 : value.reduce((total: number, entry) => total + Number(entry), 0) / value.length;
    case 'chunk': {
      const size = Math.max(1, Math.trunc(numberArg(args, 0, 1)));
      const chunks: unknown[][] = [];
      for (let index = 0; index < value.length; index += size) {
        chunks.push(value.slice(index, index + size));
      }
      return chunks;
    }
    case 'difference':
      return difference(value, Array.isArray(args[0]) ? args[0] : []);
    case 'intersection':
      return intersection(value, Array.isArray(args[0]) ? args[0] : []);
    case 'union':
      return uniqueValues([...value, ...(Array.isArray(args[0]) ? args[0] : [])]);
    case 'append':
      return [...value, ...args];
    case 'pluck':
      return value.map((entry) => getPath(entry, String(args[0] ?? '')));
    case 'fieldNames': {
      const names = new Set<string>();
      for (const entry of value) {
        if (isPlainObject(entry)) {
          for (const key of Object.keys(entry)) names.add(key);
        }
      }
      return [...names];
    }
    case 'merge': {
      if (value.every((entry) => isPlainObject(entry))) {
        return Object.assign({}, ...value);
      }
      return value;
    }
    case 'toJsonString':
      return JSON.stringify(value);
    case 'toString':
      return value.join(',');
    default:
      throw unknownMethod(name, 'array', ctx);
  }
}

function callObject(
  value: Record<string, unknown>,
  name: string,
  _args: unknown[],
  ctx: ExtensionContext,
): unknown {
  switch (name) {
    case 'keys':
      return Object.keys(value);
    case 'values':
      return Object.values(value);
    case 'hasField':
      return Object.prototype.hasOwnProperty.call(value, String(_args[0] ?? ''));
    case 'removeField': {
      const result = { ...value };
      delete result[String(_args[0] ?? '')];
      return result;
    }
    case 'removeFieldsContaining': {
      const needle = String(_args[0] ?? '');
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (!key.includes(needle)) result[key] = entry;
      }
      return result;
    }
    case 'keepFieldsContaining': {
      const needle = String(_args[0] ?? '');
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (key.includes(needle)) result[key] = entry;
      }
      return result;
    }
    case 'isEmpty':
      return Object.keys(value).length === 0;
    case 'isNotEmpty':
      return Object.keys(value).length > 0;
    case 'compact': {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== null && entry !== undefined && entry !== '') result[key] = entry;
      }
      return result;
    }
    case 'toJsonString':
      return JSON.stringify(value);
    case 'toString':
      return JSON.stringify(value);
    default:
      throw unknownMethod(name, 'object', ctx);
  }
}

function callDateTime(
  value: DraflowDateTime,
  name: string,
  args: unknown[],
  ctx: ExtensionContext,
): unknown {
  switch (name) {
    case 'format':
    case 'toFormat':
      return value.format(String(args[0] ?? "yyyy-MM-dd'T'HH:mm:ss.SSSZZ"));
    case 'toISO':
      return value.toISO();
    case 'toMillis':
    case 'toNumber':
      return value.toMillis();
    case 'plus':
      return value.plus(durationArg(args[0]));
    case 'minus':
      return value.minus(durationArg(args[0]));
    case 'diffTo':
      return value.diffTo(asDateTime(args[0], ctx), unitArg(args[1]));
    case 'diffToNow':
      return value.diffTo(
        DraflowDateTime.fromMillis(ctx.nowMillis, value.timeZone),
        unitArg(args[0]),
      );
    case 'beginningOf':
      return value.beginningOf(beginningArg(args[0]));
    case 'endOfMonth':
      return value.endOfMonth();
    case 'isWeekend':
      return value.isWeekend();
    case 'isDst':
      return value.isDst();
    case 'isBetween':
      return value.isBetween(asDateTime(args[0], ctx), asDateTime(args[1], ctx));
    case 'toString':
      return value.toString();
    case 'isEmpty':
      return false;
    default:
      throw unknownMethod(name, 'DateTime', ctx);
  }
}

function asDateTime(value: unknown, ctx: ExtensionContext): DraflowDateTime {
  if (value instanceof DraflowDateTime) return value;
  if (typeof value === 'string') return DraflowDateTime.fromISO(value, ctx.timezone);
  if (typeof value === 'number') return DraflowDateTime.fromMillis(value, ctx.timezone);
  throw new ExpressionError('Expected a date value', { expression: ctx.source });
}

function durationArg(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) return {};
  const result: Record<string, number> = {};
  for (const key of [
    'years',
    'months',
    'weeks',
    'days',
    'hours',
    'minutes',
    'seconds',
    'milliseconds',
  ]) {
    const entry = value[key];
    if (typeof entry === 'number') result[key] = entry;
  }
  return result;
}

function unitArg(value: unknown): 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds' | 'milliseconds' {
  switch (value) {
    case 'years':
    case 'months':
    case 'weeks':
    case 'days':
    case 'hours':
    case 'minutes':
    case 'seconds':
    case 'milliseconds':
      return value;
    default:
      return 'milliseconds';
  }
}

function beginningArg(value: unknown): 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second' {
  switch (value) {
    case 'year':
    case 'month':
    case 'week':
    case 'day':
    case 'hour':
    case 'minute':
    case 'second':
      return value;
    default:
      return 'day';
  }
}

function numberArg(args: unknown[], index: number, fallback: number): number {
  const value = args[index];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'false' || normalized === '0' || normalized === '') return false;
    if (normalized === 'true' || normalized === '1') return true;
    return Boolean(value);
  }
  return Boolean(value);
}

function strictEqual(a: unknown, b: unknown): boolean {
  return a === b;
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueValues(value: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const entry of value) {
    if (!result.some((existing) => strictEqual(existing, entry))) result.push(entry);
  }
  return result;
}

function difference(left: unknown[], right: unknown[]): unknown[] {
  return left.filter((entry) => !right.some((other) => strictEqual(other, entry)));
}

function intersection(left: unknown[], right: unknown[]): unknown[] {
  return left.filter((entry) => right.some((other) => strictEqual(other, entry)));
}

function getPath(value: unknown, path: string): unknown {
  const parts = path.split('.').filter((part) => part !== '');
  let current: unknown = value;
  for (const part of parts) {
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function round(value: number, precision: number): number {
  const factor = 10 ** Math.trunc(precision);
  return Math.round(value * factor) / factor;
}

function formatNumber(value: number, args: unknown[]): string {
  const locale = typeof args[0] === 'string' ? args[0] : 'en-US';
  const options = isPlainObject(args[1]) ? (args[1] as Intl.NumberFormatOptions) : {};
  return new Intl.NumberFormat(locale, options).format(value);
}

function toSentenceCase(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function toTitleCase(value: string): string {
  return value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function removeMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractDomain(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function extractUrlPath(value: string): string | undefined {
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

const STRING_METHODS = new Set([
  'toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd', 'split', 'replace',
  'replaceAll', 'includes', 'startsWith', 'endsWith', 'slice', 'substring', 'padStart',
  'padEnd', 'repeat', 'indexOf', 'lastIndexOf', 'charAt', 'length', 'isEmpty', 'isNotEmpty',
  'toNumber', 'toFloat', 'toInt', 'toBoolean', 'toJsonString', 'parseJson', 'toDateTime',
  'toDate', 'base64Encode', 'base64Decode', 'urlEncode', 'urlDecode', 'isEmail', 'isUrl',
  'isNumeric', 'isDomain', 'toSentenceCase', 'toSnakeCase', 'toTitleCase', 'removeTags',
  'removeMarkdown', 'replaceSpecialChars', 'extractEmail', 'extractDomain', 'extractUrl',
  'extractUrlPath', 'quote', 'toString',
]);

const ARRAY_METHODS = new Set([
  'length', 'first', 'last', 'isEmpty', 'isNotEmpty', 'join', 'slice', 'concat', 'includes',
  'indexOf', 'reverse', 'map', 'flatMap', 'filter', 'find', 'findIndex', 'some', 'every',
  'forEach', 'reduce', 'flat', 'sort', 'unique', 'compact', 'sum', 'min', 'max', 'average',
  'chunk', 'difference', 'intersection', 'union', 'append', 'pluck', 'fieldNames', 'merge',
  'toJsonString', 'toString',
]);

const NUMBER_METHODS = new Set([
  'ceil', 'floor', 'round', 'abs', 'isInteger', 'isEven', 'isOdd', 'toBoolean', 'toDateTime',
  'toDate', 'toNumber', 'toInt', 'format', 'toString', 'isEmpty',
]);

const BOOLEAN_METHODS = new Set(['toNumber', 'toString', 'toBoolean', 'isEmpty']);

const OBJECT_METHODS = new Set([
  'keys', 'values', 'hasField', 'removeField', 'removeFieldsContaining', 'keepFieldsContaining',
  'isEmpty', 'isNotEmpty', 'compact', 'toJsonString', 'toString',
]);

const DATE_METHODS = new Set([
  'format', 'toFormat', 'toISO', 'toMillis', 'toNumber', 'plus', 'minus', 'diffTo',
  'diffToNow', 'beginningOf', 'endOfMonth', 'isWeekend', 'isDst', 'isBetween', 'toString',
  'isEmpty',
]);

export function hasExtensionMethod(receiver: unknown, name: string): boolean {
  if (typeof receiver === 'string') return STRING_METHODS.has(name);
  if (typeof receiver === 'number') return NUMBER_METHODS.has(name);
  if (typeof receiver === 'boolean') return BOOLEAN_METHODS.has(name);
  if (Array.isArray(receiver)) return ARRAY_METHODS.has(name);
  if (receiver instanceof DraflowDateTime) return DATE_METHODS.has(name);
  if (isPlainObject(receiver)) return OBJECT_METHODS.has(name);
  return false;
}

function unknownMethod(name: string, type: string, ctx: ExtensionContext): ExpressionError {
  return new ExpressionError(`Unknown ${type} method "${name}"`, { expression: ctx.source });
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
