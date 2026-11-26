import { expect, it } from 'vitest';
import { createWorkflow } from '@draflow/core';
import { MemoryExecutionStore, type ExecutionSummary } from '../src/index.js';

const detail = { workflow: createWorkflow({ id: 'A', name: '日本語' }), tasks: [] };
const size = new TextEncoder().encode(JSON.stringify(detail)).byteLength;
function summary(id: string, time: number, workflowId = 'A'): ExecutionSummary {
  return { id, workflowId, workflowName: '日本語', mode: 'manual', startedAt: time, stoppedAt: time + 1,
    status: 'success', executed: 0, reused: 0 };
}

it('counts UTF-8 detail bytes exactly and retains only a summary for oversized executions', async () => {
  const exact = new MemoryExecutionStore({ maxDetailBytes: size });
  await exact.append(summary('a', 1), detail);
  const copy = (await exact.get('A', 'a'))!;
  copy.workflow.name = 'changed';
  expect(await exact.get('A', 'a')).toEqual(detail);
  const small = new MemoryExecutionStore({ maxDetailBytes: size - 1 });
  await small.append(summary('a', 1), detail);
  expect(await small.list('A')).toEqual([{ ...summary('a', 1), hasDetail: false }]);
  expect(await small.get('A', 'a')).toBeNull();
});

it('evicts chronologically across workflows, including late writes, and frees capacity on deletion', async () => {
  const store = new MemoryExecutionStore({ maxDetailBytes: size * 2, maxRecords: 5 });
  await store.append(summary('x', 2), detail);
  await store.append(summary('x', 3, 'B'), detail);
  await store.append(summary('late', 1), detail);
  expect((await store.list('A')).map(x => x.id)).toEqual(['x']);
  await store.delete('A', 'x');
  await store.append(summary('new', 4), detail);
  expect(await store.get('B', 'x')).toEqual(detail);
  expect(await store.get('A', 'x')).toBeNull();
  await store.append({ ...summary('new', 4), status: 'error' }, detail);
  expect(await store.list('A', 'success')).toEqual([]);
  expect(await store.list('A', 'error')).toHaveLength(1);
});

it('retains the newest twenty summaries globally and lists newest first', async () => {
  const store = new MemoryExecutionStore();
  for (let i = 0; i <= 20; i++) await store.append(summary(String(i), i, i === 20 ? 'B' : 'A'), detail);
  const rows = await store.list('A');
  expect(rows).toHaveLength(19);
  expect(rows.map(r => r.id)).toEqual(Array.from({length: 19}, (_, i) => String(19 - i)));
  expect(rows[0]).not.toHaveProperty('tasks');
  expect(rows[0]).not.toHaveProperty('workflow');
});
