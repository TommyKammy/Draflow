import { expect, it } from 'vitest';
import { complete, type CompletionData } from '../src/details/completion.js';

const data: CompletionData = { names: () => ['A'], json: () => ({ rows: [{ 'unit price': 3.2 }] }) };
function choices(marked: string, context = data) {
  const caret = marked.indexOf('|'), value = marked.replace('|', '');
  return complete(value, caret, context).map(c => [c.label, value.slice(0, c.start) + c.insert + value.slice(c.end)]);
}
it('replaces only the current token in a template, including quoted keys and ancestor names', () => {
  expect(choices("=x {{ $json.rows[0]['un|it price'] + 1 }} y")).toContainEqual(['unit price', "=x {{ $json.rows[0]['unit price'] + 1 }} y"]);
  expect(choices("={{ $('A|bc').item.json.rows }}")).toContainEqual(['A', "={{ $('A').item.json.rows }}"]);
  expect(choices("={{ $json.rows[0]['unit price'].ro|und() }}")).toContainEqual(['round()', "={{ $json.rows[0]['unit price'].round() }}"]);
});
it('completes selected secondary input and ancestor paths using runtime itemFrom references', () => {
  const other = { ...data, input: { port: 'main', slot: 1 } };
  expect(choices('={{ $json.ro| }}', other)).toContainEqual(['rows', "={{ $input.itemFrom('main', 1, $itemIndex).json.rows }}"]);
  expect(choices("={{ $('A').itemFrom('main', 1, $itemIndex).json.ro| }}", other)).toContainEqual(['rows', "={{ $('A').itemFrom('main', 1, $itemIndex).json.rows }}"]);
});
it('keeps missing inputs, unresolved lineage, comments and ordinary template text editable', () => {
  for (const source of ['={{ $json.missing.| }}', '=text $json.|', "={{ '$json.|' }}", '={{ 1 /* $json.| */ }}'])
    expect(choices(source)).toEqual([]);
  expect(choices("={{ $('A').item.json.| }}", { ...data, json: () => undefined })).toEqual([]);
  expect(choices('={{ $json.| }}', { ...data, json: () => undefined })).toEqual([]);
});

it('replaces the whole numeric subscript at the caret and preserves the surrounding expression', () => {
  const context = { ...data, json: () => ({ rows: Array.from({ length: 13 }, (_, value) => ({ value })) }) };
  expect(choices('=x {{ $json.rows[1|2].value + 1 }} y', context))
    .toContainEqual(['10', '=x {{ $json.rows[10].value + 1 }} y']);
});
