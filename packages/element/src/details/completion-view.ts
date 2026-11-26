import type { Translate } from '../locale.js';
import { complete, type CompletionData, type Suggestion } from './completion.js';

let nextId = 0;

export function bindCompletion(text: HTMLInputElement | HTMLTextAreaElement, parent: HTMLElement,
  data: () => CompletionData, t: Translate) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.textContent = t('Suggest');
  trigger.setAttribute('aria-label', t('Expression suggestions'));
  const list = document.createElement('div');
  list.className = 'expression-suggestions';
  list.id = 'suggestions-' + ++nextId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('Expression suggestions'));
  text.setAttribute('aria-controls', list.id);
  text.setAttribute('aria-autocomplete', 'list');
  text.setAttribute('aria-keyshortcuts', 'Control+Space');
  trigger.setAttribute('aria-controls', list.id);
  list.hidden = true;
  parent.append(trigger, list);
  let candidates: Suggestion[] = [], index = 0, composing = false;
  function close() {
    list.hidden = true;
    list.replaceChildren();
    candidates = [];
    text.removeAttribute('aria-activedescendant');
    trigger.setAttribute('aria-expanded', 'false');
  }
  function select(i: number) {
    index = i;
    Array.from(list.children).forEach((el, n) => el.setAttribute('aria-selected', String(n === index)));
    const selected = list.children[index];
    if (selected) {
      text.setAttribute('aria-activedescendant', selected.id);
      selected.scrollIntoView({ block: 'nearest' });
    }
  }
  function insert(i: number) {
    const match = candidates[i];
    if (!match || composing || text.matches(':disabled')) return;
    text.setRangeText(match.insert, match.start, match.end, 'end');
    text.focus();
    close();
    text.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function update() {
    trigger.hidden = !text.value.startsWith('=');
    close();
    if (trigger.hidden || composing || text.selectionStart === null || text.selectionStart !== text.selectionEnd || text.matches(':disabled')) return;
    candidates = complete(text.value, text.selectionStart, data());
    if (!candidates.length) return;
    for (const [i, candidate] of candidates.entries()) {
      const option = document.createElement('div');
      option.id = list.id + '-' + i;
      option.setAttribute('role', 'option');
      option.textContent = candidate.label;
      option.onmousedown = e => e.preventDefault();
      option.onclick = () => insert(i);
      list.append(option);
    }
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    select(0);
  }
  trigger.hidden = !text.value.startsWith('=');
  close();
  trigger.onclick = () => { text.focus(); update(); };
  text.addEventListener('input', e => { if (e instanceof InputEvent) update(); });
  text.addEventListener('click', update);
  text.addEventListener('blur', close);
  text.addEventListener('compositionstart', () => { composing = true; close(); });
  text.addEventListener('compositionend', () => { composing = false; });
  text.addEventListener('keydown', event => {
    const e = event as KeyboardEvent;
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); update(); return; }
    if (list.hidden) return;
    if (e.key === 'Enter') insert(index);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') select((index + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length);
    else if (e.key === 'Escape') close();
    else { close(); return; }
    e.preventDefault();
    e.stopPropagation();
  });
}
