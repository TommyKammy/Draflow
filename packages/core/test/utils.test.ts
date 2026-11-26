import { describe, expect, it } from 'vitest';
import { DraflowDateTime } from '../src/expression/date.js';
import { toJsonValue } from '../src/utils.js';

describe('toJsonValue', () => {
  it('honors the JSON representation of Date and DraflowDateTime', () => {
    expect(toJsonValue(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
    expect(
      toJsonValue(DraflowDateTime.fromISO('2026-01-02T03:04:05.000Z', 'UTC')),
    ).toBe('2026-01-02T03:04:05.000Z');
  });

  it('keeps ordinary objects recursive', () => {
    expect(toJsonValue({ a: 1, nested: { b: true } })).toEqual({ a: 1, nested: { b: true } });
  });
});
