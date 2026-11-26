import { DraflowDateTime } from './date.js';
import type { ExpressionContext } from './context.js';
import type { Item } from '../types.js';

export class HostFunction {
  readonly name: string;
  readonly #fn: (...args: unknown[]) => unknown;

  constructor(name: string, fn: (...args: unknown[]) => unknown) {
    this.name = name;
    this.#fn = fn;
  }

  call(args: unknown[]): unknown {
    return this.#fn(...args);
  }
}

export class NodeProxy {
  readonly name: string;
  readonly #getItems: (name: string, outputIndex?: number, runIndex?: number) => readonly Item[];
  readonly #getCurrentItem: () => Item | undefined;
  readonly #resolveItem: ((name: string) => Item | undefined) | undefined;

  constructor(
    name: string,
    getItems: (name: string, outputIndex?: number, runIndex?: number) => readonly Item[],
    getCurrentItem: () => Item | undefined,
    resolveItem?: (name: string) => Item | undefined,
  ) {
    this.name = name;
    this.#getItems = getItems;
    this.#getCurrentItem = getCurrentItem;
    this.#resolveItem = resolveItem;
  }

  all(): readonly Item[] {
    return this.#getItems(this.name);
  }

  first(): Item | undefined {
    return this.all()[0];
  }

  last(): Item | undefined {
    const items = this.all();
    return items[items.length - 1];
  }

  itemMatching(index: unknown): Item | undefined {
    if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
    return this.all()[index];
  }

  get item(): Item | undefined {
    if (this.#resolveItem !== undefined) {
      return this.#resolveItem(this.name) ?? this.first();
    }

    const current = this.#getCurrentItem();
    const paired = current?.pairedItem;
    const reference = Array.isArray(paired) ? paired[0] : paired;
    if (reference !== undefined && typeof reference.item === 'number') {
      const candidate = this.all()[reference.item];
      if (candidate !== undefined) return candidate;
    }
    return this.first();
  }

  get json(): Record<string, unknown> {
    return (this.first()?.json ?? {}) as Record<string, unknown>;
  }

  get binary(): Record<string, unknown> {
    return (this.first()?.binary ?? {}) as Record<string, unknown>;
  }
}

export class NodeMap {
  readonly #getItems: (name: string, outputIndex?: number, runIndex?: number) => readonly Item[];
  readonly #getCurrentItem: () => Item | undefined;
  readonly #names: () => readonly string[];
  readonly #resolveItem: ((name: string) => Item | undefined) | undefined;

  constructor(
    getItems: (name: string, outputIndex?: number, runIndex?: number) => readonly Item[],
    getCurrentItem: () => Item | undefined,
    names: () => readonly string[],
    resolveItem?: (name: string) => Item | undefined,
  ) {
    this.#getItems = getItems;
    this.#getCurrentItem = getCurrentItem;
    this.#names = names;
    this.#resolveItem = resolveItem;
  }

  get(name: string): NodeProxy {
    return new NodeProxy(name, this.#getItems, this.#getCurrentItem, this.#resolveItem);
  }

  has(name: string): boolean {
    return this.#names().includes(name);
  }

  keys(): readonly string[] {
    return this.#names();
  }
}

export class InputProxy {
  readonly #getInput: () => readonly Item[];
  readonly #getCurrentItem: () => Item | undefined;

  constructor(getInput: () => readonly Item[], getCurrentItem: () => Item | undefined) {
    this.#getInput = getInput;
    this.#getCurrentItem = getCurrentItem;
  }

  all(): readonly Item[] {
    return this.#getInput();
  }

  first(): Item | undefined {
    return this.all()[0];
  }

  last(): Item | undefined {
    const items = this.all();
    return items[items.length - 1];
  }

  get item(): Item | undefined {
    return this.#getCurrentItem();
  }
}

export function createDataProxy(ctx: ExpressionContext): Record<string, unknown> {
  const timezone = ctx.timezone ?? 'UTC';
  const currentItem = (): Item | undefined => ctx.item;
  const nodeOutput = (name: string, outputIndex?: number, runIndex?: number): readonly Item[] =>
    ctx.nodeOutput(name, outputIndex, runIndex);
  const inputItems = (): readonly Item[] => ctx.input('main', 0);
  const nodeNames = (): readonly string[] => ctx.nodeNames ?? [];

  const nowMillis = ctx.now?.getTime() ?? Date.now();
  const now = new DraflowDateTime(nowMillis, timezone);
  const today = now.beginningOf('day');

  return {
    $json: ctx.item.json,
    $binary: ctx.item.binary ?? {},
    $item: ctx.item,
    $input: new InputProxy(inputItems, currentItem),
    $items: new HostFunction('$items', (nodeName, outputIndex, runIndex) => {
      if (typeof nodeName !== 'string') {
        return inputItems();
      }
      return nodeOutput(
        nodeName,
        typeof outputIndex === 'number' ? outputIndex : undefined,
        typeof runIndex === 'number' ? runIndex : undefined,
      );
    }),
    $node: new NodeMap(nodeOutput, currentItem, nodeNames, ctx.resolveItem),
    $: new HostFunction('$', (nodeName) => {
      if (typeof nodeName !== 'string') return undefined;
      return new NodeProxy(nodeName, nodeOutput, currentItem, ctx.resolveItem);
    }),
    $now: now,
    $today: today,
    $vars: ctx.vars ?? {},
    $execution: ctx.execution ?? { id: '', mode: 'manual' },
    $workflow: ctx.workflow ?? { id: '', name: '' },
    $parameter: ctx.params ?? {},
    $env: ctx.env ?? {},
    $runIndex: ctx.runIndex,
    $itemIndex: ctx.itemIndex,
    Math: mathNamespace(),
    JSON: jsonNamespace(),
    Number: new HostFunction('Number', (value) => Number(value)),
    String: new HostFunction('String', (value) => String(value)),
    Boolean: new HostFunction('Boolean', (value) => Boolean(value)),
    Array: {
      isArray: new HostFunction('Array.isArray', (value) => Array.isArray(value)),
    },
    DateTime: {
      now: new HostFunction('DateTime.now', () => new DraflowDateTime(nowMillis, timezone)),
      fromISO: new HostFunction('DateTime.fromISO', (value) =>
        DraflowDateTime.fromISO(String(value), timezone),
      ),
      fromMillis: new HostFunction('DateTime.fromMillis', (value) =>
        DraflowDateTime.fromMillis(Number(value), timezone),
      ),
    },
    parseInt: new HostFunction('parseInt', (value, radix) =>
      Number.parseInt(String(value), typeof radix === 'number' ? radix : undefined),
    ),
    parseFloat: new HostFunction('parseFloat', (value) => Number.parseFloat(String(value))),
    isNaN: new HostFunction('isNaN', (value) => Number.isNaN(Number(value))),
    isFinite: new HostFunction('isFinite', (value) => Number.isFinite(Number(value))),
    encodeURIComponent: new HostFunction('encodeURIComponent', (value) =>
      encodeURIComponent(String(value)),
    ),
    decodeURIComponent: new HostFunction('decodeURIComponent', (value) =>
      decodeURIComponent(String(value)),
    ),
  };
}

function mathNamespace(): Record<string, unknown> {
  return {
    PI: Math.PI,
    E: Math.E,
    abs: new HostFunction('Math.abs', (value) => Math.abs(Number(value))),
    ceil: new HostFunction('Math.ceil', (value) => Math.ceil(Number(value))),
    floor: new HostFunction('Math.floor', (value) => Math.floor(Number(value))),
    round: new HostFunction('Math.round', (value) => Math.round(Number(value))),
    trunc: new HostFunction('Math.trunc', (value) => Math.trunc(Number(value))),
    sign: new HostFunction('Math.sign', (value) => Math.sign(Number(value))),
    min: new HostFunction('Math.min', (...values) => Math.min(...values.map(Number))),
    max: new HostFunction('Math.max', (...values) => Math.max(...values.map(Number))),
    pow: new HostFunction('Math.pow', (base, exponent) => Math.pow(Number(base), Number(exponent))),
    sqrt: new HostFunction('Math.sqrt', (value) => Math.sqrt(Number(value))),
    log: new HostFunction('Math.log', (value) => Math.log(Number(value))),
    exp: new HostFunction('Math.exp', (value) => Math.exp(Number(value))),
  };
}

function jsonNamespace(): Record<string, unknown> {
  return {
    parse: new HostFunction('JSON.parse', (value) => JSON.parse(String(value))),
    stringify: new HostFunction('JSON.stringify', (value, replacer, space) =>
      JSON.stringify(value, replacer as never, space as never),
    ),
  };
}
