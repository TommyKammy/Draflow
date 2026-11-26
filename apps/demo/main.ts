import '@draflow/element/define';
import { standardNodes } from '@draflow/nodes';

const editor = document.querySelector('draflow-editor')!;
editor.nodeTypes = standardNodes;

async function loadExample() {
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
