import type { Item, JsonValue, ParamValue } from '../types.js';

export interface ExpressionContext {
  item: Item;
  itemIndex: number;
  runIndex: number;
  input: (port?: string, index?: number) => readonly Item[];
  nodeOutput: (nodeName: string, outputIndex?: number, runIndex?: number) => readonly Item[];
  /** Resolves the item in `nodeName` that corresponds to the current item's lineage. */
  resolveItem?: (nodeName: string, itemIndex?: number, port?: string, slot?: number) => Item | undefined;
  nodeNames?: readonly string[];
  vars?: Readonly<Record<string, JsonValue>>;
  timezone?: string;
  now?: Date;
  execution?: { id: string; mode: string };
  workflow?: { id: string; name: string };
  params?: Record<string, ParamValue>;
  env?: Record<string, string>;
}
