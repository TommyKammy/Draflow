import { colors, type Note } from './store/notes.js';
import { button } from './details/fields.js';
import type { Translate } from './locale.js';

export function noteDialog(commit: (id: string, value?: Note) => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'sticky-dialog';
  const heading = document.createElement('h2');
  heading.id = 'sticky-heading';
  dialog.setAttribute('aria-labelledby', heading.id);
  function open(note: Note, existing: boolean, editable: boolean, t: Translate) {
    heading.textContent = t(existing ? 'Sticky note' : 'Add sticky note');
    const form = document.createElement('form');
    function field(name: string, control: HTMLElement) {
      const label = document.createElement('label');
      label.append(t(name), control);
      form.append(label);
    }
    const text = document.createElement('textarea');
    text.value = note.text;
    text.readOnly = !editable;
    text.autofocus = true;
    field('Note text', text);
    const color = document.createElement('select');
    for (const c of colors) color.add(new Option(t(c), c));
    color.value = note.color;
    color.disabled = !editable;
    field('Color', color);
    function number(name: string, value: number, min?: number) {
      const control = document.createElement('input');
      control.type = 'number';
      control.required = true;
      control.step = 'any';
      control.valueAsNumber = value;
      control.readOnly = !editable;
      if (min !== undefined) control.min = String(min);
      field(name, control);
      return control;
    }
    const x = number('X', note.x), y = number('Y', note.y);
    const width = number('Width', note.width, 96), height = number('Height', note.height, 64);
    const controls = document.createElement('div');
    if (editable) {
      const save = document.createElement('button');
      save.type = 'submit';
      save.textContent = t('Save');
      controls.append(save);
      if (existing) controls.append(button(t('Delete'), () => { dialog.close(); commit(note.id); }));
    }
    controls.append(button(t(editable ? 'Cancel' : 'Close'), () => dialog.close()));
    form.append(controls);
    form.onsubmit = event => {
      event.preventDefault();
      if (!editable) return;
      dialog.close();
      commit(note.id, { ...note, text: text.value, color: colors[color.selectedIndex]!,
        x: x.valueAsNumber, y: y.valueAsNumber, width: width.valueAsNumber, height: height.valueAsNumber });
    };
    dialog.replaceChildren(heading, form);
    dialog.showModal();
  }
  return { dialog, open };
}
