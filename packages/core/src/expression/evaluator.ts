import type {
  ArrayExpr,
  ArrowExpr,
  BinaryExpr,
  CallExpr,
  ConditionalExpr,
  Expr,
  IdentifierExpr,
  LiteralExpr,
  LogicalExpr,
  MemberExpr,
  ObjectExpr,
  UnaryExpr,
} from './ast.js';
import { DraflowDateTime } from './date.js';
import {
  ExpressionError,
  ExpressionLimitError,
  ExpressionSecurityError,
} from '../errors.js';
import { callExtension } from './functions.js';
import { HostFunction, InputProxy, NodeMap, NodeProxy } from './proxy.js';
import { isPlainObject } from '../utils.js';

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BLOCKED_IDENTIFIERS = new Set([
  'globalThis',
  'window',
  'document',
  'process',
  'require',
  'import',
  'eval',
  'Function',
  'Reflect',
  'Proxy',
]);

export class ArrowClosure {
  readonly node: ArrowExpr;
  readonly scope: Scope;

  constructor(node: ArrowExpr, scope: Scope) {
    this.node = node;
    this.scope = scope;
  }
}

export class Scope {
  readonly #values: Map<string, unknown>;
  readonly #parent: Scope | undefined;

  constructor(parent?: Scope, values?: Map<string, unknown>) {
    this.#parent = parent;
    this.#values = values ?? new Map();
  }

  get(name: string): { found: boolean; value: unknown } {
    if (this.#values.has(name)) {
      return { found: true, value: this.#values.get(name) };
    }
    if (this.#parent !== undefined) return this.#parent.get(name);
    return { found: false, value: undefined };
  }

  child(values: Map<string, unknown>): Scope {
    return new Scope(this, values);
  }
}

export interface EvaluatorOptions {
  source: string;
  data: Record<string, unknown>;
  maxSteps?: number;
  maxDepth?: number;
}

export class Evaluator {
  readonly #source: string;
  readonly #data: Record<string, unknown>;
  readonly #maxSteps: number;
  readonly #maxDepth: number;
  #steps = 0;
  #depth = 0;

  constructor(options: EvaluatorOptions) {
    this.#source = options.source;
    this.#data = options.data;
    this.#maxSteps = options.maxSteps ?? 100_000;
    this.#maxDepth = options.maxDepth ?? 64;
  }

  evaluate(expression: Expr, scope = new Scope()): unknown {
    this.#steps += 1;
    if (this.#steps > this.#maxSteps) {
      throw new ExpressionLimitError(
        `Expression exceeded ${this.#maxSteps} evaluation steps`,
        this.#source,
      );
    }
    if (this.#depth > this.#maxDepth) {
      throw new ExpressionLimitError(
        `Expression exceeded maximum depth ${this.#maxDepth}`,
        this.#source,
      );
    }

    this.#depth += 1;
    try {
      return this.#evaluate(expression, scope);
    } finally {
      this.#depth -= 1;
    }
  }

  #evaluate(expression: Expr, scope: Scope): unknown {
    switch (expression.type) {
      case 'Literal':
        return (expression as LiteralExpr).value;
      case 'Identifier':
        return this.#resolveIdentifier(expression as IdentifierExpr, scope);
      case 'Array':
        return (expression as ArrayExpr).elements.map((element) => this.evaluate(element, scope));
      case 'Object':
        return this.#evaluateObject(expression as ObjectExpr, scope);
      case 'Member':
        return this.#evaluateMember(expression as MemberExpr, scope);
      case 'Call':
        return this.#evaluateCall(expression as CallExpr, scope);
      case 'Unary':
        return this.#evaluateUnary(expression as UnaryExpr, scope);
      case 'Binary':
        return this.#evaluateBinary(expression as BinaryExpr, scope);
      case 'Logical':
        return this.#evaluateLogical(expression as LogicalExpr, scope);
      case 'Conditional':
        return this.#evaluateConditional(expression as ConditionalExpr, scope);
      case 'Arrow':
        return new ArrowClosure(expression as ArrowExpr, scope);
      default:
        throw new ExpressionError('Unsupported expression', { expression: this.#source });
    }
  }

  #resolveIdentifier(expression: IdentifierExpr, scope: Scope): unknown {
    if (BLOCKED_IDENTIFIERS.has(expression.name)) {
      throw new ExpressionSecurityError(
        `Access to "${expression.name}" is not allowed`,
        this.#source,
      );
    }

    const local = scope.get(expression.name);
    if (local.found) return local.value;

    if (Object.prototype.hasOwnProperty.call(this.#data, expression.name)) {
      return this.#data[expression.name];
    }

    throw new ExpressionError(`Unknown variable "${expression.name}"`, {
      expression: this.#source,
      position: expression.start,
    });
  }

  #evaluateObject(expression: ObjectExpr, scope: Scope): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const property of expression.properties) {
      if (BLOCKED_KEYS.has(property.key)) {
        throw new ExpressionSecurityError(
          `Object key "${property.key}" is not allowed`,
          this.#source,
        );
      }
      result[property.key] = this.evaluate(property.value, scope);
    }
    return result;
  }

  #evaluateMember(expression: MemberExpr, scope: Scope): unknown {
    const object = this.evaluate(expression.object, scope);
    if (object === null || object === undefined) {
      if (expression.optional) return undefined;
      throw new ExpressionError('Cannot read a property of null or undefined', {
        expression: this.#source,
        position: expression.start,
      });
    }

    const key = expression.computed
      ? this.evaluate(expression.property, scope)
      : (expression.property as IdentifierExpr).name;

    return this.getMember(object, String(key));
  }

  #evaluateCall(expression: CallExpr, scope: Scope): unknown {
    const args = expression.args.map((argument) => this.evaluate(argument, scope));

    if (expression.callee.type === 'Member') {
      const member = expression.callee as MemberExpr;
      const receiver = this.evaluate(member.object, scope);
      if (receiver === null || receiver === undefined) {
        if (expression.optional || member.optional) return undefined;
        throw new ExpressionError('Cannot call a method of null or undefined', {
          expression: this.#source,
          position: expression.start,
        });
      }
      const key = member.computed
        ? this.evaluate(member.property, scope)
        : (member.property as IdentifierExpr).name;
      return this.callMethod(receiver, String(key), args);
    }

    const fn = this.evaluate(expression.callee, scope);
    if (fn === null || fn === undefined) {
      if (expression.optional) return undefined;
      throw new ExpressionError('Cannot call a value that is not a function', {
        expression: this.#source,
        position: expression.start,
      });
    }
    return this.invoke(fn, args);
  }

  #evaluateUnary(expression: UnaryExpr, scope: Scope): unknown {
    const value = this.evaluate(expression.argument, scope);
    switch (expression.operator) {
      case '!':
        return !value;
      case '-':
        return -Number(value);
      case '+':
        return Number(value);
      default:
        return undefined;
    }
  }

  #evaluateBinary(expression: BinaryExpr, scope: Scope): unknown {
    if (expression.operator === '&&') {
      const left = this.evaluate(expression.left, scope);
      return left ? this.evaluate(expression.right, scope) : left;
    }
    if (expression.operator === '||') {
      const left = this.evaluate(expression.left, scope);
      return left ? left : this.evaluate(expression.right, scope);
    }
    if (expression.operator === '??') {
      const left = this.evaluate(expression.left, scope);
      return left === null || left === undefined
        ? this.evaluate(expression.right, scope)
        : left;
    }

    const left = this.evaluate(expression.left, scope);
    const right = this.evaluate(expression.right, scope);

    switch (expression.operator) {
      case '+':
        return add(left, right);
      case '-':
        return Number(left) - Number(right);
      case '*':
        return Number(left) * Number(right);
      case '/':
        return Number(left) / Number(right);
      case '%':
        return Number(left) % Number(right);
      case '==':
        return looseEqual(left, right);
      case '!=':
        return !looseEqual(left, right);
      case '===':
        return left === right;
      case '!==':
        return left !== right;
      case '<':
        return lessThan(left, right);
      case '<=':
        return lessThan(left, right) || left === right;
      case '>':
        return lessThan(right, left);
      case '>=':
        return lessThan(right, left) || left === right;
      case 'in':
        return isIn(left, right);
      default:
        throw new ExpressionError(`Unsupported operator "${expression.operator}"`, {
          expression: this.#source,
          position: expression.start,
        });
    }
  }

  #evaluateLogical(expression: LogicalExpr, scope: Scope): unknown {
    if (expression.operator === '&&') {
      const left = this.evaluate(expression.left, scope);
      return left ? this.evaluate(expression.right, scope) : left;
    }
    if (expression.operator === '||') {
      const left = this.evaluate(expression.left, scope);
      return left ? left : this.evaluate(expression.right, scope);
    }
    const left = this.evaluate(expression.left, scope);
    return left === null || left === undefined ? this.evaluate(expression.right, scope) : left;
  }

  #evaluateConditional(expression: ConditionalExpr, scope: Scope): unknown {
    return this.evaluate(expression.test, scope)
      ? this.evaluate(expression.consequent, scope)
      : this.evaluate(expression.alternate, scope);
  }

  getMember(object: unknown, key: string): unknown {
    if (BLOCKED_KEYS.has(key)) {
      throw new ExpressionSecurityError(`Access to "${key}" is not allowed`, this.#source);
    }

    if (object instanceof NodeProxy) {
      if (key === 'json') return object.json;
      if (key === 'binary') return object.binary;
      if (key === 'item') return object.item;
      if (key === 'all' || key === 'first' || key === 'last' || key === 'itemMatching') {
        return this.#boundMethod(object, key);
      }
      return undefined;
    }

    if (object instanceof InputProxy) {
      if (key === 'item') return object.item;
      if (key === 'all' || key === 'first' || key === 'last') {
        return this.#boundMethod(object, key);
      }
      return undefined;
    }

    if (object instanceof NodeMap) {
      if (key === 'keys') {
        return new HostFunction('$node.keys', () => object.keys());
      }
      if (key === 'has') {
        return new HostFunction('$node.has', (name) => object.has(String(name)));
      }
      return object.get(key);
    }

    if (object instanceof DraflowDateTime) {
      switch (key) {
        case 'year':
        case 'month':
        case 'day':
        case 'hour':
        case 'minute':
        case 'second':
        case 'millisecond':
        case 'weekday':
        case 'offset':
        case 'zoneName':
          return (object as unknown as Record<string, unknown>)[key];
        case 'format':
        case 'toFormat':
        case 'toISO':
        case 'toMillis':
        case 'toNumber':
        case 'plus':
        case 'minus':
        case 'diffTo':
        case 'diffToNow':
        case 'beginningOf':
        case 'endOfMonth':
        case 'isWeekend':
        case 'isDst':
        case 'isBetween':
        case 'toString':
        case 'isEmpty':
          return this.#boundMethod(object, key);
        default:
          return undefined;
      }
    }

    if (Array.isArray(object)) {
      if (key === 'length') return object.length;
      const index = toIndex(key);
      if (index !== undefined) return object[index];
      return undefined;
    }

    if (typeof object === 'string') {
      if (key === 'length') return object.length;
      const index = toIndex(key);
      if (index !== undefined) return object[index];
      return undefined;
    }

    if (isPlainObject(object) || typeof object === 'object') {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        return (object as Record<string, unknown>)[key];
      }
      return undefined;
    }

    return undefined;
  }

  callMethod(receiver: unknown, name: string, args: unknown[]): unknown {
    if (BLOCKED_KEYS.has(name)) {
      throw new ExpressionSecurityError(`Access to "${name}" is not allowed`, this.#source);
    }

    if (receiver instanceof NodeProxy) {
      switch (name) {
        case 'all':
          return receiver.all();
        case 'first':
          return receiver.first();
        case 'last':
          return receiver.last();
        case 'itemMatching':
          return receiver.itemMatching(args[0]);
        default:
          throw new ExpressionError(`Unknown node method "${name}"`, {
            expression: this.#source,
          });
      }
    }

    if (receiver instanceof InputProxy) {
      switch (name) {
        case 'all':
          return receiver.all();
        case 'first':
          return receiver.first();
        case 'last':
          return receiver.last();
        default:
          throw new ExpressionError(`Unknown input method "${name}"`, {
            expression: this.#source,
          });
      }
    }

    if (receiver instanceof NodeMap) {
      switch (name) {
        case 'keys':
          return receiver.keys();
        case 'has':
          return receiver.has(String(args[0] ?? ''));
        default:
          return receiver.get(name);
      }
    }

    if (receiver instanceof DraflowDateTime) {
      return callExtension(receiver, name, args, {
        source: this.#source,
        timezone: receiver.timeZone,
        invoke: (fn, values) => this.invoke(fn, values),
      });
    }

    if (isPlainObject(receiver) && Object.prototype.hasOwnProperty.call(receiver, name)) {
      const candidate = receiver[name];
      if (candidate instanceof HostFunction) return candidate.call(args);
    }

    return callExtension(receiver, name, args, {
      source: this.#source,
      timezone: 'UTC',
      invoke: (fn, values) => this.invoke(fn, values),
    });
  }

  invoke(fn: unknown, args: unknown[]): unknown {
    if (fn instanceof HostFunction) return fn.call(args);
    if (fn instanceof ArrowClosure) {
      const values = new Map<string, unknown>();
      fn.node.params.forEach((param, index) => {
        values.set(param, args[index]);
      });
      return this.evaluate(fn.node.body, fn.scope.child(values));
    }
    throw new ExpressionError('Expected a function', { expression: this.#source });
  }

  #boundMethod(receiver: unknown, name: string): unknown {
    return new HostFunction(name, (...args) => this.callMethod(receiver, name, args));
  }
}

function toIndex(key: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
  return Number(key);
}

function add(left: unknown, right: unknown): unknown {
  if (typeof left === 'string' || typeof right === 'string') {
    return toPrimitiveString(left) + toPrimitiveString(right);
  }
  return Number(left) + Number(right);
}

function toPrimitiveString(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => toPrimitiveString(entry)).join(',');
  return '[object Object]';
}

function looseEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null && right === undefined) return true;
  if (left === undefined && right === null) return true;
  if (typeof left === 'number' && typeof right === 'string') return left === Number(right);
  if (typeof left === 'string' && typeof right === 'number') return Number(left) === right;
  if (typeof left === 'boolean') return looseEqual(Number(left), right);
  if (typeof right === 'boolean') return looseEqual(left, Number(right));
  return false;
}

function lessThan(left: unknown, right: unknown): boolean {
  if (typeof left === 'string' && typeof right === 'string') return left < right;
  return Number(left) < Number(right);
}

function isIn(left: unknown, right: unknown): boolean {
  if (Array.isArray(right)) return right.some((entry) => entry === left);
  if (isPlainObject(right)) return Object.prototype.hasOwnProperty.call(right, String(left));
  return false;
}
