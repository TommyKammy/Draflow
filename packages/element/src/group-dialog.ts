import type { Group } from './store/groups.js';
import type { Translate } from './locale.js';
import { button } from './details/fields.js';

export function groupDialog(save: (id: string, value?: Group) => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'sticky-dialog';
  function open(group: Group, existing: boolean, t: Translate) {
    const title = document.createElement('h2');
    title.textContent = t(existing ? 'Edit group' : 'Group nodes');
    dialog.setAttribute('aria-label', title.textContent);
    const form = document.createElement('form');
    const label = document.createElement('label'), input = document.createElement('input');
    input.value = group.label;
    input.required = input.autofocus = true;
    label.append(t('Group name'), input);
    const controls = document.createElement('div');
    const submit = document.createElement('button');
    submit.textContent = t('Save');
    controls.append(submit);
    if (existing) controls.append(button(t('Ungroup'), () => { dialog.close(); save(group.id); }));
    controls.append(button(t('Cancel'), () => dialog.close()));
    form.onsubmit = e => {
      e.preventDefault();
      dialog.close();
      if (!existing || input.value !== group.label) save(group.id, { ...group, label: input.value });
    };
    form.append(label, controls);
    dialog.replaceChildren(title, form);
    dialog.showModal();
    input.select();
  }
  return { dialog, open };
}
