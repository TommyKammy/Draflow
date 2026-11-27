import { expect, it, vi } from 'vitest';
import { createWorkflow, type Workflow } from '@draflow/core';
import { Autosave } from '../src/store/autosave.js';
import { History } from '../src/store/edit.js';

it('bounds undo to 100 edits and drops the redo branch after another edit', () => {
  const history = new History();
  let current = createWorkflow();
  for (let i = 0; i <= 100; i++) {
    history.record(current);
    current = { ...current, name: String(i) };
  }
  for (let i = 0; i < 100; i++) current = history.undo(current);
  expect(current.name).toBe('0');
  expect(history.canUndo).toBe(false);
  expect(history.canRedo).toBe(true);
  history.record(current);
  expect(history.canRedo).toBe(false);
});

it('serializes the last pending snapshot before writes from a reconnected editor', async () => {
  const original = createWorkflow({ name: 'Initial' });
  const log: string[] = [];
  let release!: () => void;
  const store = {
    async load() { return null; },
    async save(w: Workflow) {
      log.push(w.name);
      if (log.length === 1) await new Promise<void>(resolve => { release = resolve; });
    },
  };
  const first = new Autosave(store, () => {});
  first.open(original);
  first.changed({ ...original, name: 'In flight' });
  first.flush();
  const last = { ...original, name: 'At disconnect' };
  first.changed(last);
  first.flush();
  const second = new Autosave(store, () => {});
  second.open(last);
  second.changed({ ...original, name: 'After reconnect' });
  second.flush();
  expect(log).toEqual(['In flight']);
  release();
  await vi.waitFor(() => expect(second.pending).toBe(false));
  expect(log).toEqual(['In flight', 'At disconnect', 'After reconnect']);
});

it('receives the outcome of a save that was pending at reconnect without enqueueing it twice', async () => {
  const original = createWorkflow();
  let finish!: () => void;
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const firstNotify = vi.fn(), nextNotify = vi.fn();
  const saves = new Autosave({ load: async () => null, save }, firstNotify);
  saves.open(original);
  const edited = { ...original, name: 'Edited' };
  saves.changed(edited);
  saves.disconnect();
  saves.reconnect(structuredClone(edited), nextNotify, vi.fn());
  expect(saves.activePending).toBe(true);
  finish();
  await vi.waitFor(() => expect(saves.activePending).toBe(false));
  expect(save).toHaveBeenCalledTimes(1);
  expect(nextNotify).toHaveBeenCalled();
  expect(firstNotify).not.toHaveBeenCalled();
});
