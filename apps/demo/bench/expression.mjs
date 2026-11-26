import assert from 'node:assert/strict';
import { ExpressionEngine } from '@draflow/core';

const item = { json: { amount: 42 } };
const context = { item, itemIndex: 0, runIndex: 0, input: () => [item], nodeOutput: () => [] };
const iterations = 10000;
for (const [source, expected] of [['={{ $json.amount }}', 42], ['=Total {{ $json.amount }}', 'Total 42']]) {
  const engine = new ExpressionEngine();
  const start = performance.now();
  const issues = engine.validate(source); // Populates the same compile cache used by resolveString.
  const compileMs = performance.now() - start;
  assert.deepEqual(issues, []);
  for (let i = 0; i < 1000; i++) assert.equal(engine.resolveString(source, context), expected);
  const warm = performance.now();
  let last;
  for (let i = 0; i < iterations; i++) last = engine.resolveString(source, context);
  const meanMs = (performance.now() - warm) / iterations;
  assert.equal(last, expected);
  console.log(JSON.stringify({ source, compileMs, iterations, meanMs }));
  assert.ok(meanMs < 0.1, 'Cached evaluation must average under 0.1 ms');
}
