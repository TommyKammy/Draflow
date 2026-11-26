import { serializeError, type EngineEvents, type RunHandle, type RunOptions, type SerializedError, type Workflow } from '@draflow/core';
import type { ExecutionDetail, ExecutionStore, ExecutionSummary } from '@draflow/storage';

export function recordExecution(store: ExecutionStore, handle: RunHandle, workflow: Workflow, options: RunOptions,
  saved: () => void, failed: (error: unknown) => void) {
  const tasks: ExecutionDetail['tasks'] = [];
  let snapshot: Workflow;
  try { snapshot = structuredClone(workflow); } catch (error) { failed(error); return; }
  const summary: ExecutionSummary = {
    id: handle.id, workflowId: snapshot.id, workflowName: snapshot.name, mode: options.mode ?? 'manual',
    ...(options.startNodeId !== undefined && { startNodeId: options.startNodeId }),
    ...(options.destinationNodeId !== undefined && {
      destinationNodeId: options.destinationNodeId, destinationMode: options.destinationMode ?? 'inclusive',
    }),
    startedAt: Date.now(), stoppedAt: 0, status: 'error', executed: 0, reused: 0,
  };
  let captureError: { cause: unknown } | undefined;
  // A run may settle after the editor switches documents or is destroyed.
  let pending: EngineEvents['node:start'] | undefined;
  let runError: SerializedError | undefined;
  const off = [
    handle.on('run:start', event => { summary.startedAt = event.startedAt; }),
    handle.on('node:start', event => {
      if (captureError) return;
      pending = event;
      tasks.push({ nodeId: event.nodeId, runIndex: event.runIndex, reused: event.reused });
      if (event.reused) summary.reused++; else summary.executed++;
    }),
    handle.on('node:finish', event => {
      if (captureError) return;
      const entry = tasks.at(-1)!; // The engine visits one task at a time.
      try { entry.task = structuredClone(event.task); pending = undefined; }
      catch (cause) { captureError = { cause }; }
    }),
    handle.on('run:finish', ({ result }) => {
      summary.startedAt = result.startedAt;
      summary.stoppedAt = result.stoppedAt;
      summary.status = result.status;
      try { if (result.error) runError = structuredClone(result.error); }
      catch (cause) { captureError = { cause }; }
    }),
  ];
  async function append() {
    for (const unsubscribe of off) unsubscribe();
    if (snapshot.settings.saveExecutionData === 'error' && summary.status !== 'error') return;
    if (captureError) throw captureError.cause;
    if (pending) tasks.at(-1)!.input = pending.input;
    await store.append(summary, { workflow: snapshot, tasks, ...(runError && { error: runError }) });
    saved();
  }
  void handle.done.then(append, error => {
    summary.stoppedAt = Date.now();
    runError = serializeError(error);
    return append();
  }).catch(failed);
}
