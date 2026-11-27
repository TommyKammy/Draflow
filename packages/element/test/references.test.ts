import { expect, it } from 'vitest';
import { createNode, ExpressionEngine } from '@draflow/core';
import { remapReferences } from '../src/store/references.js';

it('remaps static node references inside nested parameters, preserving other text and scope', () => {
  const original = createNode({ type: 'transform', name: 'Consumer', parameters: { fields: [
    { value: '=Before {{ $items("Source", 0)[0].json.n }} after {{ $("Outside").item.json.n }}' },
    { value: '={{ ($node).Source.json.n + $node["Source"].json.n }}' },
    { value: '={{ $node.has("Source") && $node.keys() }}' },
    { value: '={{ ["Source"].map($ => $("Source")) }}' },
    { value: '={{ $($json.name).item.json.n }}' },
    { value: '={{ $json.Source + "Source" }}' },
    { value: '={{ $("Source"' },
    { value: '$("Source")' },
  ] } });
  const updated = remapReferences(original, new Map([['Source', 'New "source"']]));
  const literal = JSON.stringify('New "source"');
  expect(updated.parameters.fields).toEqual([
    { value: '=Before {{ $items(' + literal + ', 0)[0].json.n }} after {{ $("Outside").item.json.n }}' },
    { value: '={{ ($node)[' + literal + '].json.n + $node[' + literal + '].json.n }}' },
    { value: '={{ $node.has(' + literal + ') && $node.keys() }}' },
    ...(original.parameters.fields as { value: string }[]).slice(3),
  ]);
});

it('keeps node names that overlap with member methods addressable after rename', () => {
  const original = createNode({ type: 'transform', name: 'Consumer', parameters: {
    value: '={{ ($node).Source.item.json.amount }}',
  } });
  const updated = remapReferences(original, new Map([['Source', 'has']]));
  expect(updated.parameters.value).toBe('={{ ($)("has").item.json.amount }}');
});

it('preserves a locally bound $ when renaming to a NodeMap method', () => {
  const original = createNode({ type: 'transform', name: 'Consumer', parameters: {
    value: '={{ [1].map($ => $ + $node.Source.item.json.n) }}',
  } });
  const updated = remapReferences(original, new Map([['Source', 'has']]));
  const again = remapReferences(updated, new Map([['has', 'Another']]));
  const engine = new ExpressionEngine();
  expect(engine.resolve(again.parameters.value, {
    item: { json: {} }, itemIndex: 0, runIndex: 0, input: () => [],
    nodeOutput: name => name === 'Another' ? [{ json: { n: 2 } }] : [],
  })).toEqual([3]);
});
