import {
  cloneJson,
  isPlainObject,
  toJsonValue,
  type Item,
  type JsonObject,
  type NodeType,
} from '@draflow/core';
import { fixedValues, pairing, setPath, toJsonObject } from './helpers.js';

export const setNode: NodeType = {
  type: 'draflow.set',
  version: 1,
  meta: {
    label: 'Edit Fields (Set)',
    category: 'transform',
    description: 'Add, change, or remove item fields',
    icon: 'edit',
  },
  ports: {
    inputs: [{ type: 'main', required: true }],
    outputs: [{ type: 'main' }],
  },
  parameters: [
    {
      name: 'mode',
      label: 'Mode',
      type: 'select',
      default: 'manual',
      options: [
        { label: 'Manual Mapping', value: 'manual' },
        { label: 'JSON', value: 'json' },
      ],
    },
    {
      name: 'assignments',
      label: 'Fields to Set',
      type: 'fixedCollection',
      multiple: true,
      default: [],
      displayOptions: { show: { mode: ['manual'] } },
      fields: [
        { name: 'name', label: 'Name', type: 'string', default: '', required: true },
        {
          name: 'value',
          label: 'Value',
          type: 'string',
          default: '',
        },
        {
          name: 'type',
          label: 'Type',
          type: 'select',
          default: 'auto',
          options: [
            { label: 'Auto', value: 'auto' },
            { label: 'String', value: 'string' },
            { label: 'Number', value: 'number' },
            { label: 'Boolean', value: 'boolean' },
            { label: 'JSON', value: 'json' },
          ],
        },
      ],
    },
    {
      name: 'jsonOutput',
      label: 'JSON',
      type: 'json',
      default: {},
      displayOptions: { show: { mode: ['json'] } },
    },
    {
      name: 'includeOtherFields',
      label: 'Include Other Input Fields',
      type: 'boolean',
      default: true,
    },
  ],
  async execute(ctx) {
    const output: Item[] = [];

    await ctx.each((input, itemCtx, index) => {
      const mode = itemCtx.param<string>('mode', 'manual');
      if (mode === 'json') {
        const raw = itemCtx.param<unknown>('jsonOutput', {});
        output.push({
          json: parseJsonObject(raw),
          pairedItem: pairing(input, index),
        });
        return;
      }

      const includeOtherFields = itemCtx.param<boolean>('includeOtherFields', true);
      const base: JsonObject = includeOtherFields ? cloneJson(input.json) : {};
      const assignments = fixedValues(itemCtx.param<unknown>('assignments', []));

      for (const assignment of assignments) {
        const name = String(assignment.name ?? '');
        if (name === '') continue;

        const type = String(assignment.type ?? 'auto');
        const value = castValue(itemCtx.resolve(assignment.value), type);
        setPath(base, name, toJsonValue(value));
      }

      output.push({ json: base, pairedItem: pairing(input, index) });
    });

    return output;
  },
};

function parseJsonObject(value: unknown): JsonObject {
  if (isPlainObject(value)) return toJsonValue(value) as JsonObject;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return toJsonObject(parsed);
    } catch {
      return { data: value };
    }
  }
  return toJsonObject(value);
}

function castValue(value: unknown, type: string): unknown {
  switch (type) {
    case 'string':
      return value === null || value === undefined ? '' : String(value);
    case 'number': {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    case 'auto':
    default:
      return value;
  }
}
