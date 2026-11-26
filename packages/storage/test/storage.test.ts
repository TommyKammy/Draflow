import { expect, it } from 'vitest';
import { createWorkflow } from '@draflow/core';
import { LocalStorageWorkflowStore, MemoryWorkflowStore } from '../src/index.js';

const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  key: index => [...values.keys()][index] ?? null,
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: key => { values.delete(key); },
  clear: () => values.clear(),
};

it.each([new MemoryWorkflowStore(), new LocalStorageWorkflowStore('demo', storage)])(
  'saves and loads isolated workflow snapshots', async store => {
    const workflow = createWorkflow({ id: 'one', name: 'Original' });
    expect(await store.load(workflow.id)).toBeNull();
    await store.save(workflow);
    workflow.name = 'Edited';
    const loaded = await store.load(workflow.id);
    expect(loaded?.name).toBe('Original');
    loaded!.name = 'Edited again';
    expect((await store.load(workflow.id))?.name).toBe('Original');
  },
);
