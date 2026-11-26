import type { NodePortRef } from '@draflow/core';
import type { CanvasScene } from './canvas/scene.js';
import { compatible } from './store/edit.js';
import { button } from './details/fields.js';
import type { Translate } from './locale.js';

export function connectionDialog(scene: CanvasScene, commit: (from: NodePortRef, to: NodePortRef) => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'node-creator';
  const title = document.createElement('h2');
  title.id = 'connect-title';
  dialog.setAttribute('aria-labelledby', title.id);
  function open(t: Translate) {
    title.textContent = t('Connect nodes');
    const outputs: NodePortRef[] = [], inputs: NodePortRef[] = [];
    const from = document.createElement('select'), to = document.createElement('select');
    from.autofocus = true;
    function picker(label: string, control: HTMLSelectElement) {
      const field = document.createElement('label');
      field.append(t(label), control);
      return field;
    }
    const connect = button(t('Connect'), () => {
      const output = outputs[from.selectedIndex], input = inputs[to.selectedIndex];
      if (!output || !input) return;
      dialog.close();
      commit(output, input);
    });
    function populate(side: 'inputs' | 'outputs', select: HTMLSelectElement, refs: NodePortRef[]) {
      refs.length = 0;
      select.replaceChildren();
      const source = outputs[from.selectedIndex];
      for (const { node, inputs, outputs } of scene.cards.values()) {
        const indices = new Map<string, number>();
        for (const port of side === 'inputs' ? inputs : outputs) {
          const index = indices.get(port.type) ?? 0;
          indices.set(port.type, index + 1);
          if (side === 'inputs' && (!source || !compatible(source.port, port.type))) continue;
          refs.push({ node: node.id, port: port.type, index });
          select.add(new Option(node.name + ' · ' + (port.label ? t(port.label) + ' · ' : '') + port.type + '[' + index + ']'));
        }
      }
    }
    function destinations() {
      populate('inputs', to, inputs);
      connect.disabled = !inputs.length;
      if (!inputs.length) to.add(new Option(t('No compatible input')));
    }
    from.onchange = destinations;
    populate('outputs', from, outputs);
    destinations();
    dialog.replaceChildren(title, picker('Output port', from), picker('Input port', to), connect, button(t('Cancel'), () => dialog.close()));
    dialog.showModal();
  }
  return { dialog, open };
}
