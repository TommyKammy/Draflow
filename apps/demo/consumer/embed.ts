// Standalone consumer of built declaration files, without source aliases.
import type { RunHandle, RunResult, Workflow } from '@draflow/core';
import { createWorkflowEditor, type EditorOptions } from '@draflow/element';
import '@draflow/element/define';
import { standardNodes } from '@draflow/nodes';
import { MemoryWorkflowStore, type WorkflowStore } from '@draflow/storage';

export async function embed(host: HTMLElement, workflow: Workflow): Promise<RunResult> {
  const storage: WorkflowStore = new MemoryWorkflowStore();
  const options: EditorOptions = { nodeTypes: standardNodes, workflow, ports: { storage } };
  const editor = createWorkflowEditor(host, options);
  try {
    const run: RunHandle = editor.run();
    return await run.done;
  } finally {
    editor.destroy();
  }
}

export function component(workflow: Workflow, finish: (result: RunResult) => void) {
  const editor = document.createElement('draflow-editor');
  editor.nodeTypes = standardNodes;
  editor.workflow = workflow;
  editor.addEventListener('draflow-run-finish', e => finish(e.detail.result));
  return editor;
}
