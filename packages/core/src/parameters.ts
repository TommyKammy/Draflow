import type {
  Condition,
  DisplayOptions,
  FixedCollectionParam,
  NodeType,
  ParamSchema,
} from './node.js';
import type { ParamValue, WorkflowNode } from './types.js';
import { cloneJson, isPlainObject } from './utils.js';

export function getParameter(node: WorkflowNode, name: string): ParamValue {
  if (name.startsWith('/')) {
    return readPath(node.parameters, name.slice(1));
  }
  return node.parameters[name];
}

export function unwrapParameterValue(value: ParamValue): ParamValue {
  if (isPlainObject(value) && value.__rl === true && 'value' in value) {
    return value.value as ParamValue;
  }
  return value;
}

export function isParameterVisible(
  parameter: ParamSchema,
  node: WorkflowNode,
  nodeType: NodeType,
): boolean {
  if (parameter.displayOptions === undefined) return true;
  return evaluateDisplayOptions(parameter.displayOptions, node, nodeType);
}

export function evaluateDisplayOptions(
  options: DisplayOptions,
  node: WorkflowNode,
  nodeType: NodeType,
): boolean {
  if (options.show !== undefined) {
    for (const [key, conditions] of Object.entries(options.show)) {
      const actual = displayValues(key, node, nodeType);
      if (!checkConditions(conditions, actual)) return false;
    }
  }

  if (options.hide !== undefined) {
    for (const [key, conditions] of Object.entries(options.hide)) {
      const actual = displayValues(key, node, nodeType);
      if (checkConditions(conditions, actual)) return false;
    }
  }

  return true;
}

export function getVisibleParameters(nodeType: NodeType, node: WorkflowNode): ParamSchema[] {
  return nodeType.parameters.filter((parameter) =>
    isParameterVisible(parameter, node, nodeType),
  );
}

export function applyParameterDefaults(
  nodeType: NodeType,
  parameters: Record<string, ParamValue>,
): Record<string, ParamValue> {
  const result: Record<string, ParamValue> = { ...parameters };
  applyDefaults(nodeType.parameters, result);
  return result;
}

function applyDefaults(fields: ParamSchema[], target: Record<string, ParamValue>): void {
  for (const field of fields) {
    if (field.type === 'notice' || field.type === 'callout') continue;

    if (target[field.name] === undefined && field.default !== undefined) {
      target[field.name] = cloneJson(field.default);
    }

    const value = target[field.name];
    if (field.type === 'collection' && isPlainObject(value)) {
      applyDefaults(field.fields, value as Record<string, ParamValue>);
    }

    if (field.type === 'fixedCollection' && field.multiple === true && Array.isArray(value)) {
      for (const entry of value) {
        if (isPlainObject(entry)) applyDefaults(field.fields, entry as Record<string, ParamValue>);
      }
    }
  }
}

function displayValues(key: string, node: WorkflowNode, nodeType: NodeType): unknown[] {
  if (key === '@version') return [node.typeVersion];
  if (key === '@tool') return [false];
  if (key === '@feature') return [];

  const value = key.startsWith('/')
    ? readPath(node.parameters, key.slice(1))
    : readPath(node.parameters, key);
  return toValues(unwrapParameterValue(value as ParamValue));
}

function toValues(value: ParamValue): unknown[] {
  if (Array.isArray(value)) return value;
  return [value];
}

function readPath(source: Record<string, ParamValue>, path: string): ParamValue {
  const parts = path.split('.').filter((part) => part !== '');
  let current: unknown = source;
  for (const part of parts) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current as ParamValue;
}

function checkConditions(conditions: Condition[], actualValues: unknown[]): boolean {
  return conditions.some((condition) => matchesCondition(condition, actualValues));
}

function matchesCondition(condition: Condition, actualValues: unknown[]): boolean {
  const entry = conditionEntry(condition);
  if (entry !== undefined) {
    const [key, target] = entry;

    if (actualValues.length === 0) {
      return key === 'not' ? true : key === 'exists' ? false : false;
    }

    return actualValues.every((value) => applyCondition(key, value, target));
  }

  return actualValues.includes(condition);
}

const DISPLAY_CONDITION_OPERATORS = new Set([
  'eq',
  'not',
  'gte',
  'lte',
  'gt',
  'lt',
  'between',
  'includes',
  'startsWith',
  'endsWith',
  'regex',
  'exists',
]);

function conditionEntry(condition: Condition): [string, unknown] | undefined {
  if (typeof condition !== 'object' || condition === null) return undefined;

  if ('_cnd' in condition) {
    const wrapped = (condition as { _cnd?: unknown })._cnd;
    if (!isPlainObject(wrapped)) return undefined;
    return Object.entries(wrapped)[0];
  }

  const entries = Object.entries(condition);
  if (entries.length !== 1) return undefined;

  const entry = entries[0];
  if (entry === undefined) return undefined;
  return DISPLAY_CONDITION_OPERATORS.has(entry[0]) ? entry : undefined;
}

function applyCondition(key: string, value: unknown, target: unknown): boolean {
  switch (key) {
    case 'eq':
      return strictEqual(value, target);
    case 'not':
      return !strictEqual(value, target);
    case 'gte':
      return Number(value) >= Number(target);
    case 'lte':
      return Number(value) <= Number(target);
    case 'gt':
      return Number(value) > Number(target);
    case 'lt':
      return Number(value) < Number(target);
    case 'between': {
      if (!isPlainObject(target)) return false;
      const from = target.from;
      const to = target.to;
      return Number(value) >= Number(from) && Number(value) <= Number(to);
    }
    case 'includes':
      return typeof value === 'string' && value.includes(String(target));
    case 'startsWith':
      return typeof value === 'string' && value.startsWith(String(target));
    case 'endsWith':
      return typeof value === 'string' && value.endsWith(String(target));
    case 'regex':
      try {
        return typeof value === 'string' && new RegExp(String(target)).test(value);
      } catch {
        return false;
      }
    case 'exists':
      return value !== null && value !== undefined && value !== '';
    default:
      return false;
  }
}

function strictEqual(a: unknown, b: unknown): boolean {
  return a === b;
}

/** Returns the fixed-collection items of a parameter, if it is one. */
export function fixedCollectionItems(
  parameter: FixedCollectionParam,
  value: ParamValue,
): Array<Record<string, ParamValue>> {
  if (!parameter.multiple) {
    return isPlainObject(value) ? [value as Record<string, ParamValue>] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject) as Array<Record<string, ParamValue>>;
}
