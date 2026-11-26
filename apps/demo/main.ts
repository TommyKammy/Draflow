import '@draflow/element/define';
import { createNode, createConnection, createWorkflow, parseWorkflow } from '@draflow/core';
import { MemoryExecutionStore, LocalStorageWorkflowStore } from '@draflow/storage';
import { standardNodes } from '@draflow/nodes';

const editor = document.querySelector('draflow-editor')!;
const picker = document.querySelector<HTMLSelectElement>('#example')!;
const requested = new URLSearchParams(location.search).get('example');
const id = requested === 'workspace' || requested === 'mock-http' ? requested : 'manual-set';
picker.value = id;

const mockUrl = 'https://example.test/items';

async function initialWorkflow() {
  if (id === 'workspace') return createWorkflow({ id, name: '作業用キャンバス' });
  if (id === 'mock-http') {
    const manual = createNode({ id: 'manual', type: 'draflow.manualTrigger', name: 'Manual' });
    const http = createNode({ id: 'http', type: 'draflow.httpRequest', name: 'HTTP',
      position: { x: 240, y: 0 }, parameters: { url: mockUrl } });
    return createWorkflow({ id, name: 'Manual → HTTP', nodes: [manual, http], connections: [
      createConnection({ node: manual.id, port: 'main', index: 0 }, { node: http.id, port: 'main', index: 0 }),
    ] });
  }
  const response = await fetch('./workflow.json');
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return parseWorkflow(await response.json());
}

async function loadExample() {
  const storage = new LocalStorageWorkflowStore('draflow-demo');
  editor.nodeTypes = standardNodes;
  editor.ports = { storage, executions: new MemoryExecutionStore(), ...(id === 'mock-http' && {
    fetch: async (url: string) => url === mockUrl ? Response.json({ amount: 42 }) : new Response(null, { status: 404 }),
  }) };
  editor.workflow = await storage.load(id) ?? await initialWorkflow();
  editor.hidden = false;
}

void loadExample().catch((error: unknown) => {
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = 'ワークフローを読み込めませんでした。 ' + String(error);
  editor.after(message);
});
