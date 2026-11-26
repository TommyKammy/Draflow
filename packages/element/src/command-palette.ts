import { translator, type Locale } from './locale.js';

type Command = { id: string; label: string | (() => string); control: HTMLButtonElement };

export function commandPalette(commands: Command[], locale: () => Locale) {
  const dialog = document.createElement('dialog');
  dialog.className = 'command-palette';
  const input = document.createElement('input');
  input.type = 'text';
  input.autofocus = true;
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', 'palette-results');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'true');
  const list = document.createElement('div');
  list.id = 'palette-results'; // Each editor has its own shadow root.
  list.setAttribute('role', 'listbox');
  const empty = document.createElement('p');
  empty.setAttribute('role', 'status');
  const close = document.createElement('button');
  close.type = 'button';
  close.onclick = () => dialog.close();
  dialog.append(input, list, empty, close);

  let current: Command | undefined;
  let visible: Command[] = [];
  const enabled = (c: Command) => !c.control.disabled && !c.control.hidden;
  function choose(command?: Command) {
    if (!command || !enabled(command)) return;
    dialog.close();
    command.control.click();
  }
  function select(command?: Command) {
    current = command;
    input.removeAttribute('aria-activedescendant');
    for (const row of list.children) {
      const selected = !!current && row.id === 'command-' + current.id;
      row.setAttribute('aria-selected', String(selected));
      if (selected) {
        input.setAttribute('aria-activedescendant', row.id);
        row.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  function refresh() {
    if (!dialog.open) return;
    const t = translator(locale()), ja = translator('ja');
    const query = input.value.trim().toLowerCase();
    list.replaceChildren();
    visible = [];
    for (const command of commands) {
      const key = typeof command.label === 'string' ? command.label : command.label();
      if (![key, ja(key)].some(label => label.toLowerCase().includes(query))) continue;
      visible.push(command);
      const row = document.createElement('div');
      row.id = 'command-' + command.id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-disabled', String(!enabled(command)));
      row.textContent = t(key);
      row.onclick = () => choose(command);
      list.append(row);
    }
    empty.textContent = visible.length ? '' : t('No matching commands');
    select(current && visible.includes(current) && enabled(current) ? current : visible.find(enabled));
  }
  input.oninput = () => { current = undefined; refresh(); };
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  dialog.oncancel = e => { if (composing) e.preventDefault(); };
  input.onkeydown = e => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    const available = visible.filter(enabled);
    if (e.key === 'Enter') { e.preventDefault(); choose(current); }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && available.length) {
      e.preventDefault();
      const index = current ? available.indexOf(current) : -1;
      select(available[(index + (e.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length]);
    }
  };
  return { dialog, refresh, open() {
    if (dialog.open) return;
    const t = translator(locale());
    dialog.setAttribute('aria-label', t('Command palette'));
    list.setAttribute('aria-label', t('Commands'));
    input.setAttribute('aria-label', t('Search commands'));
    input.placeholder = t('Search commands');
    close.textContent = t('Close');
    composing = false;
    input.value = '';
    current = undefined;
    dialog.showModal();
    refresh();
  } };
}
