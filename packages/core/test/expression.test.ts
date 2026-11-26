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
    tags: ['a', 'b'],
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
  it.each([
    ['={{ [1, "]",] }}', [1, ']']],
    ['={{ "a(b".replace("(", ")",) }}', 'a)b'],
    ['={{ {a: 1, "}": 2,} }}', { a: 1, '}': 2 }],
  ])('parses punctuation-looking literals in %s', (source, expected) => {
    expect(evaluate(String(source))).toEqual(expected);
  });

  it.each(['0099-01-01', '0000-02-29'])('preserves the ISO year in %s', date => {
    expect(evaluate(`={{ DateTime.fromISO("${date}").toISO() }}`)).toBe(date + 'T00:00:00.000Z');
  });

  it.each([
    ['0099-01-01Z', '0099-01-01T00:00:00.000Z'],
    ['0000-02-29Z', '0000-02-29T00:00:00.000Z'],
    ['-000001-01-01', '-000001-01-01T00:00:00.000Z'],
    ['+010000-01-01', '+010000-01-01T00:00:00.000Z'],
    ['2026-01-01T24:00:00+09:00', '2026-01-01T15:00:00.000Z'],
  ])('round-trips the ISO instant %s', (input, expected) => {
    expect(evaluate(`={{ DateTime.fromISO("${input}").toISO() }}`)).toBe(expected);
  });

  it.each(['-000000-01-01', '+999999-01-01', '2025-02-30', '2026-00-01', '2025-02-29T12:00:00Z', '2026-01-01T25:00'])
    ('rejects invalid ISO date %s', date => {
      expect(() => evaluate(`={{ DateTime.fromISO("${date}") }}`)).toThrow(/Invalid ISO date/);
    });

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
    expect(evaluate('={{ $json.keys() }}')).toEqual(['name', 'age', 'active', 'nested', 'items', 'people', 'tags']);
    expect(evaluate('={{ $json.hasField("age") }}')).toBe(true);
    expect(evaluate('={{ $json.items.sum() }}')).toBe(6);
    expect(evaluate('={{ $json.items.average() }}')).toBe(2);
  });

  it('treats delimiters inside string literals as data', () => {
    expect(evaluate('={{ "a)b".split(")") }}')).toEqual(['a', 'b']);
    expect(evaluate('={{ ["]"] }}')).toEqual([']']);
    expect(evaluate('={{ ")" + "(" }}')).toBe(')(');
  });

  it('preserves split separator and limit semantics', () => {
    expect(evaluate('={{ "abc".split() }}')).toEqual(['abc']);
    expect(evaluate('={{ "a,b,c".split(",", 2) }}')).toEqual(['a', 'b']);
  });

  it('ignores template delimiters inside expression comments', () => {
    expect(evaluate('={{ 1 /* }} */ + 2 }}')).toBe(3);
    expect(evaluate('=before {{ 1 // }}\n + 2 }} after')).toBe('before 3 after');
  });

  it('checks array properties by key with in', () => {
    expect(evaluate('={{ 0 in [10, 20] }}')).toBe(true);
    expect(evaluate('={{ 10 in [10, 20] }}')).toBe(false);
    expect(evaluate('={{ "1" in [10, undefined] }}')).toBe(true);
    expect(evaluate('={{ "length" in [] }}')).toBe(true);
  });

  it.each(['<=', '>='])('coerces null and preserves unordered operands for %s', operator => {
    for (const [left, right] of [['0', 'null'], ['null', '0'], ['null', 'null']]) {
      expect(evaluate(`={{ ${left} ${operator} ${right} }}`)).toBe(true);
    }
    for (const operand of ['undefined', '(0 / 0)']) {
      expect(evaluate(`={{ ${operand} ${operator} ${operand} }}`)).toBe(false);
      expect(evaluate(`={{ null ${operator} ${operand} }}`)).toBe(false);
    }
  });

  it('supports nullish, comparisons, and ternary', () => {
    expect(evaluate('={{ $json.missing ?? "fallback" }}')).toBe('fallback');
    expect(evaluate('={{ $json.age > 18 ? "adult" : "minor" }}')).toBe('adult');
    expect(evaluate('={{ $json.age === 30 }}')).toBe(true);
    expect(evaluate('={{ $json.age !== 30 }}')).toBe(false);
    expect(evaluate('={{ "age" in $json }}')).toBe(true);
    expect(evaluate('={{ "2" <= 2 }}')).toBe(true);
    expect(evaluate('={{ "2" >= 2 }}')).toBe(true);
    expect(evaluate('={{ "10" <= 2 }}')).toBe(false);
  });

  it.each([
    ['={{ "ab".replaceAll("", "-") }}', '-a-b-'],
    ['={{ "hello".replaceAll("l", "$&$&") }}', 'hellllo'],
  ])('applies string replacement semantics in %s', (source, expected) => {
    expect(evaluate(source)).toBe(expected);
  });

  it.each(['null', '$json.missing'])('distinguishes an optional call from an optional receiver on %s', receiver => {
    expect(() => evaluate(`={{ ${receiver}.trim?.() }}`)).toThrow(/null or undefined/);
    expect(evaluate(`={{ ${receiver}?.trim() }}`)).toBeUndefined();
  });

  it('short-circuits optional chains through the whole chain', () => {
    expect(evaluate('={{ $json.missing?.nested.name ?? "fallback" }}')).toBe('fallback');
    expect(evaluate('={{ $json.nested?.missing?.deep ?? "fallback" }}')).toBe('fallback');
    expect(evaluate('={{ $json.maybe?.() ?? "none" }}')).toBe('none');
    expect(() => evaluate('={{ $json.nested?.missing.deep }}')).toThrow();
    expect(evaluate('={{ $json.tags?.map?.(x => x.toUpperCase()) }}')).toEqual(['A', 'B']);
    expect(evaluate('={{ " a ".trim?.() }}')).toBe('a');
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
    expect(
      evaluate(
        '={{ DateTime.fromISO("2026-01-15T00:00:00Z").plus({ months: 1, days: 2, hours: 3 }).toISO() }}',
      ),
    ).toBe('2026-02-17T03:00:00.000Z');
  });

  it('uses the workflow timezone for date extensions', () => {
    const tokyo = new ExpressionEngine({ timezone: 'Asia/Tokyo' });
    const tokyoContext = { ...context, timezone: 'Asia/Tokyo' };
    expect(
      tokyo.resolve('={{ DateTime.fromISO("2026-01-15T00:00:00Z").hour }}', tokyoContext),
    ).toBe(9);
    expect(tokyo.resolve('={{ "2026-01-15T00:00:00Z".toDateTime().hour }}', tokyoContext)).toBe(9);
    expect(
      tokyo.resolve('={{ DateTime.fromISO("2026-01-15T00:00:00").toISO() }}', tokyoContext),
    ).toBe('2026-01-15T00:00:00.000+09:00');
    expect(
      tokyo.resolve('={{ DateTime.fromISO("2026-01-15T00:00:00Z").toISO() }}', tokyoContext),
    ).toBe('2026-01-15T09:00:00.000+09:00');
  });

  it('starts local weeks on Monday across DST transitions', () => {
    const newYork = new ExpressionEngine({ timezone: 'America/New_York' });
    const newYorkContext = { ...context, timezone: 'America/New_York' };
    expect(
      newYork.resolve(
        '={{ DateTime.fromISO("2026-11-01T23:30:00-05:00").beginningOf("week").format("yyyy-MM-dd") }}',
        newYorkContext,
      ),
    ).toBe('2026-10-26');
    expect(
      newYork.resolve(
        '={{ DateTime.fromISO("2026-03-07T12:00:00-05:00").plus({ days: 1 }).toISO() }}',
        newYorkContext,
      ),
    ).toBe('2026-03-08T12:00:00.000-04:00');
    expect(
      newYork.resolve(
        '={{ DateTime.fromISO("2026-03-08T12:00:00-04:00").minus({ days: 1 }).toISO() }}',
        newYorkContext,
      ),
    ).toBe('2026-03-07T12:00:00.000-05:00');
  });

  it('uses the injected expression clock for current-date operations', () => {
    expect(evaluate('={{ DateTime.now().toISO() }}')).toBe('2026-11-26T08:30:00.000Z');
    expect(evaluate('={{ $now.diffToNow("days") }}')).toBe(0);
    expect(evaluate('={{ DateTime.now().diffToNow("days") }}')).toBe(0);
  });

  it('counts member and call chains against the evaluation budget', () => {
    const depthLimited = new ExpressionEngine({ timezone: 'UTC', maxDepth: 3 });
    expect(() => depthLimited.resolve('={{ "a".trim().trim().trim() }}', context)).toThrow(
      /depth/,
    );

    const stepLimited = new ExpressionEngine({ timezone: 'UTC', maxSteps: 3 });
    expect(() => stepLimited.resolve('={{ "a".trim().trim() }}', context)).toThrow(/steps/);
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
