import { describe, expect, it } from 'vitest';
import { ExpressionEngine } from '../src/expression/index.js';
import type { ExpressionContext } from '../src/expression/context.js';
import type { Item } from '../src/types.js';

const primary: Item = {
  json: {
    name: 'Alice',
    age: 30,
    active: true,
    nested: { city: 'Tokyo' },
    items: [1, 2, 3],
    people: [
      { name: 'Alice', score: 10 },
      { name: 'Bob', score: 20 },
    ],
  },
};

const other: Item = { json: { value: 42, label: 'answer' } };

const context: ExpressionContext = {
  item: primary,
  itemIndex: 0,
  runIndex: 0,
  input: () => [primary],
  nodeOutput: (name) => (name === 'Other' ? [other] : []),
  nodeNames: ['Other'],
  vars: { greeting: 'hello' },
  timezone: 'UTC',
  now: new Date('2026-11-26T08:30:00.000Z'),
  execution: { id: 'run-1', mode: 'manual' },
  workflow: { id: 'wf-1', name: 'Test workflow' },
  params: { url: 'https://example.com' },
};

const engine = new ExpressionEngine({ timezone: 'UTC' });

function evaluate(source: string): unknown {
  return engine.resolve(source, context);
}

describe('ExpressionEngine', () => {
  it('returns plain strings unchanged', () => {
    expect(evaluate('hello')).toBe('hello');
    expect(evaluate('https://example.com')).toBe('https://example.com');
  });

  it('evaluates typed expressions', () => {
    expect(evaluate('={{ 1 + 2 }}')).toBe(3);
    expect(evaluate('={{ $json.age }}')).toBe(30);
    expect(evaluate('={{ $json.items }}')).toEqual([1, 2, 3]);
  });

  it('interpolates expressions in text', () => {
    expect(evaluate('=Hello {{ $json.name }}!')).toBe('Hello Alice!');
    expect(evaluate('={{ $json.name }} ({{ $json.age }})')).toBe('Alice (30)');
  });

  it('resolves arrows and array methods', () => {
    expect(evaluate('={{ $json.items.map(x => x * 2) }}')).toEqual([2, 4, 6]);
    expect(evaluate('={{ $json.items.filter(x => x > 1) }}')).toEqual([2, 3]);
    expect(evaluate('={{ $json.items.reduce((sum, x) => sum + x, 0) }}')).toBe(6);
    expect(evaluate('={{ $json.items.some(x => x === 2) }}')).toBe(true);
    expect(evaluate('={{ $json.items.every(x => x > 0) }}')).toBe(true);
    expect(evaluate('={{ $json.people.map(person => person.name) }}')).toEqual([
      'Alice',
      'Bob',
    ]);
  });

  it('supports string and object extensions', () => {
    expect(evaluate('={{ $json.name.toUpperCase() }}')).toBe('ALICE');
    expect(evaluate('={{ "a,b,c".split(",").length }}')).toBe(3);
    expect(evaluate('={{ $json.keys() }}')).toEqual(['name', 'age', 'active', 'nested', 'items', 'people']);
    expect(evaluate('={{ $json.hasField("age") }}')).toBe(true);
    expect(evaluate('={{ $json.items.sum() }}')).toBe(6);
    expect(evaluate('={{ $json.items.average() }}')).toBe(2);
  });

  it('supports nullish, comparisons, and ternary', () => {
    expect(evaluate('={{ $json.missing ?? "fallback" }}')).toBe('fallback');
    expect(evaluate('={{ $json.age > 18 ? "adult" : "minor" }}')).toBe('adult');
    expect(evaluate('={{ $json.age === 30 }}')).toBe(true);
    expect(evaluate('={{ $json.age !== 30 }}')).toBe(false);
    expect(evaluate('={{ "age" in $json }}')).toBe(true);
  });

  it('builds objects and arrays', () => {
    expect(evaluate('={{ { name: $json.name, age: $json.age } }}')).toEqual({
      name: 'Alice',
      age: 30,
    });
    expect(evaluate('={{ [1, 2, $json.age] }}')).toEqual([1, 2, 30]);
  });

  it('resolves node references', () => {
    expect(evaluate('={{ $("Other").first().json.value }}')).toBe(42);
    expect(evaluate('={{ $node.Other.first().json.label }}')).toBe('answer');
    expect(evaluate('={{ $items("Other")[0].json.value }}')).toBe(42);
  });

  it('supports dates', () => {
    expect(evaluate('={{ $now.format("yyyy-MM-dd HH:mm") }}')).toBe('2026-11-26 08:30');
    expect(evaluate('={{ $today.plus({ days: 1 }).format("yyyy-MM-dd") }}')).toBe('2026-11-27');
    expect(evaluate('={{ $now.toISO() }}')).toBe('2026-11-26T08:30:00.000Z');
  });

  it('resolves nested values', () => {
    expect(
      engine.resolve(
        {
          a: '={{ 1 + 1 }}',
          b: 'plain',
          c: ['={{ 2 + 2 }}', 'x'],
        },
        context,
      ),
    ).toEqual({ a: 2, b: 'plain', c: [4, 'x'] });
  });

  it('rejects dangerous identifiers and properties', () => {
    expect(() => evaluate('={{ globalThis }}')).toThrow(/not allowed/);
    expect(() => evaluate('={{ constructor }}')).toThrow(/Unknown variable/);
    expect(() => evaluate('={{ $json.__proto__ }}')).toThrow(/not allowed/);
    expect(() => evaluate('={{ $json["constructor"] }}')).toThrow(/not allowed/);
  });

  it('rejects unknown methods', () => {
    expect(() => evaluate('={{ $json.name.notARealMethod() }}')).toThrow(/Unknown string method/);
  });

  it('enforces the step budget', () => {
    const limited = new ExpressionEngine({ timezone: 'UTC', maxSteps: 5 });
    expect(() => limited.resolve('={{ $json.items.map(x => x * 2) }}', context)).toThrow(
      /exceeded/,
    );
  });

  it('validates syntax', () => {
    expect(engine.validate('={{ 1 + }}')[0]?.message).toBeTruthy();
    expect(engine.validate('plain text')).toEqual([]);
  });
});
