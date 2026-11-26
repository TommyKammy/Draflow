import { describe, expect, it } from 'vitest';
import { ExpressionEngine } from '@draflow/core';
import { insertMapping } from '../src/details/mapping.js';

describe('field mapping', () => {
  const expression = new ExpressionEngine();
  const item = { json: { amount: 42, "quoted ' key": [73] } };
  const context = { item, itemIndex: 0, runIndex: 0, input: () => [item], nodeOutput: () => [item] };
  it('keeps numeric values typed and inserts a template at the text selection', () => {
    const mapping = { path: ['amount'] };
    expect(insertMapping(mapping, '')).toBe('={{ $json.amount }}');
    expect(expression.resolveString(insertMapping(mapping, ''), context)).toBe(42);
    const text = insertMapping(mapping, '合計 ? 円', [3, 4]);
    expect(text).toBe('=合計 {{ $json.amount }} 円');
    expect(expression.resolveString(text, context)).toBe('合計 42 円');
  });
  it('quotes unusual property and ancestor names, including inside indexed arrays', () => {
    const ancestor = "Source's \\ \"name\"";
    const value = insertMapping({ ancestor, path: ["quoted ' key", 0] }, '');
    expect(expression.resolveString(value, { ...context, nodeOutput: name => name === ancestor ? [item] : [] })).toBe(73);
  });
  it('writes single paths and comma-separated paths without expression markers', () => {
    const mapping = { path: ['user', 'amount'] };
    expect(insertMapping(mapping, 'before', [0, 0], 'single')).toBe('user.amount');
    expect(insertMapping(mapping, 'before', [6, 6], 'multiple')).toBe('before, user.amount');
  });
  it('reads an explicitly selected secondary port in the runtime context', () => {
    const input = { port: 'main', slot: 1 };
    const other = { json: { amount: 99 } };
    const ctx = { ...context, input: (_port?: string, slot?: number) => slot === 1 ? [other] : [item],
      resolveItem: (_name: string, _index?: number, _port?: string, slot?: number) => slot === 1 ? other : item };
    expect(expression.resolveString(insertMapping({ path: ['amount'], input }, ''), ctx)).toBe(99);
    expect(expression.resolveString(insertMapping({ path: ['amount'], ancestor: 'Source', input }, ''), ctx)).toBe(99);
  });
});
