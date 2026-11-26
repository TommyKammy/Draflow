import type { RunStatus, Workflow } from '@draflow/core';
import type { ExecutionStore } from '@draflow/storage';
import type { Translate } from './locale.js';

export function executionHistory(store: ExecutionStore, current: () => Workflow, canDelete: () => boolean, t: Translate) {
  const button = document.createElement('button'), close = document.createElement('button');
  button.type = close.type = 'button';
  const dialog = document.createElement('dialog');
  dialog.className = 'execution-history';
  dialog.setAttribute('aria-labelledby', 'history-title');
  const title = document.createElement('h2');
  title.id = 'history-title';
  const filter = document.createElement('select');
  filter.autofocus = true;
  const list = document.createElement('ul');
  const message = document.createElement('p');
  message.setAttribute('aria-live', 'polite');
  const warning = document.createElement('p');
  warning.setAttribute('aria-live', 'polite');
  let request = 0;
  function setLocale(next: Translate) {
    t = next;
    title.textContent = button.textContent = t('Execution history');
    close.textContent = t('Close');
    filter.setAttribute('aria-label', t('Execution status'));
    const value = filter.value;
    filter.replaceChildren(...['', 'success', 'error', 'waiting', 'canceled'].map(status => new Option(t(status || 'All statuses'), status)));
    filter.value = value;
  }
  async function refresh() {
    if (!dialog.open) return;
    const generation = ++request, workflowId = current().id;
    const valid = () => dialog.open && generation === request && current().id === workflowId;
    list.replaceChildren();
    message.textContent = t('Loading history');
    try {
      const rows = await store.list(workflowId, (filter.value || undefined) as RunStatus | undefined);
      if (!valid()) return;
      message.textContent = rows.length ? '' : t('No executions');
      for (const row of rows) {
        const li = document.createElement('li');
        const scope = [row.startNodeId && t('From node'), row.startNodeId, row.destinationNodeId && t(row.destinationMode === 'exclusive' ? 'Before node' : 'Through node'),
          row.destinationNodeId].filter(Boolean).join(' ');
        li.textContent = [new Date(row.startedAt).toLocaleString(dialog.closest('[lang]')?.getAttribute('lang') || undefined), row.id, t(row.status),
          scope || t('Full workflow'), t('Executed tasks') + ' ' + row.executed, t('reused') + ' ' + row.reused,
          !row.hasDetail && t('Detail omitted')].filter(Boolean).join(' · ');
        if (canDelete()) {
          const remove = document.createElement('button');
          remove.type = 'button'; remove.textContent = t('Delete');
          remove.onclick = async () => {
            if (!valid() || !canDelete()) return;
            remove.disabled = true;
            try {
              await store.delete(workflowId, row.id);
              if (dialog.open && current().id === workflowId) { filter.focus(); await refresh(); }
            } catch (error) { if (valid()) { message.textContent = String(error); remove.disabled = false; } }
          };
          li.append(' ', remove);
        }
        list.append(li);
      }
    } catch (error) { if (valid()) message.textContent = t('History unavailable') + ' · ' + String(error); }
  }
  setLocale(t);
  dialog.append(title, filter, message, list, close);
  filter.onchange = refresh;
  button.onclick = () => { button.focus(); dialog.showModal(); void refresh(); };
  close.onclick = () => dialog.close();
  function reset() {
    request++;
    dialog.close(); filter.value = ''; list.replaceChildren(); warning.textContent = '';
  }
  return { button, dialog, warning, setLocale, refresh, reset,
    failed(error: unknown) { warning.textContent = t('History unavailable') + ' · ' + String(error); },
  };
}
