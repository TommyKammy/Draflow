import '@draflow/element/define';
import { LocalStorageWorkflowStore } from '@draflow/storage';
import { standardNodes } from '@draflow/nodes';

const editor = document.querySelector('draflow-editor')!;
const storage = new LocalStorageWorkflowStore('draflow-demo');
editor.nodeTypes = standardNodes;
editor.ports = { storage };

async function loadExample() {
  const saved = await storage.load('manual-set');
  if (saved) { editor.workflow = saved; return; }
  const response = await fetch('./workflow.json');
  if (!response.ok) throw new Error('HTTP ' + response.status);
  editor.workflow = await response.json();
}

void loadExample().catch((error: unknown) => {
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = 'ワークフローを読み込めませんでした。 ' + String(error);
  editor.after(message);
});
