import { executionReplay } from './execution-replay.js';
import type { NodeRegistry, RunStatus, Workflow } from '@draflow/core';
import type { ExecutionStore } from '@draflow/storage';
import type { Translate } from './locale.js';

export function executionHistory(store: ExecutionStore, current: () => Workflow, canDelete: () => boolean, t: Translate,
  registry: NodeRegistry, canCopy: () => boolean, copy: (workflow: Workflow) => void) {
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
  let request = 0, selection = 0;
  let inspecting: string | undefined;
  let deletedDuringList = new Set<string>();
  let replay: ReturnType<typeof executionReplay> | undefined;
  function clearReplay() {
    selection++; inspecting = undefined;
    replay?.destroy();
    replay = undefined;
  }
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
    clearReplay();
    const generation = ++request, workflowId = current().id;
    const valid = () => dialog.open && generation === request && current().id === workflowId;
    deletedDuringList = new Set();
    list.replaceChildren();
    message.textContent = t('Loading history');
    try {
      const result = await store.list(workflowId, (filter.value || undefined) as RunStatus | undefined);
      if (!valid()) return;
      const rows = result.filter(row => !deletedDuringList.has(row.id));
      message.textContent = rows.length ? '' : t('No executions');
      for (const row of rows) {
        const li = document.createElement('li');
        li.dataset.runId = row.id;
        const scope = [row.startNodeId && t('From node'), row.startNodeId, row.destinationNodeId && t(row.destinationMode === 'exclusive' ? 'Before node' : 'Through node'),
          row.destinationNodeId].filter(Boolean).join(' ');
        li.textContent = [new Date(row.startedAt).toLocaleString(dialog.closest('[lang]')?.getAttribute('lang') || undefined), row.id, t(row.status),
          scope || t('Full workflow'), ...(row.interrupted ? [t('Interrupted')] : [t('Executed tasks') + ' ' + row.executed, t('reused') + ' ' + row.reused]),
          !row.hasDetail && t('Detail omitted')].filter(Boolean).join(' · ');
        if (row.hasDetail) {
          const open = document.createElement('button');
          open.type = 'button'; open.textContent = t('Replay');
          open.onclick = async () => {
            if (!valid()) return;
            clearReplay();
            inspecting = row.id;
            const ticket = selection;
            const selected = () => valid() && ticket === selection;
            message.textContent = t('Loading history');
            try {
              const detail = await store.get(workflowId, row.id);
              if (!selected()) return;
              if (!detail) { message.textContent = t('Detail unavailable'); return; }
              message.textContent = '';
              replay = executionReplay(detail, row, registry, dialog.closest('[lang]')?.getAttribute('lang') === 'ja' ? 'ja' : 'en', t,
                canDelete() ? w => { if (selected() && canCopy()) copy(w); } : undefined);
              dialog.insertBefore(replay.root, close);
              replay.updateCopy(canCopy());
              replay.focus();
            } catch (error) { if (selected()) message.textContent = t('History unavailable') + ' · ' + String(error); }
          };
          li.append(' ', open);
        }
        if (canDelete()) {
          const remove = document.createElement('button');
          remove.type = 'button'; remove.textContent = t('Delete');
          remove.onclick = async () => {
            if (!valid() || !canDelete()) return;
            if (remove.matches(':focus')) filter.focus();
            remove.disabled = true;
            try {
              await store.delete(workflowId, row.id);
              if (!dialog.open || current().id !== workflowId) return;
              deletedDuringList.add(row.id);
              const removed = [...list.children].find(el => (el as HTMLElement).dataset.runId === row.id);
              if (removed?.matches(':focus-within') || (inspecting === row.id && replay?.root.matches(':focus-within'))) filter.focus();
              removed?.remove();
              if (inspecting === row.id) {
                // Appends defer list refresh while the replay is open.
                await refresh();
                return;
              }
              if (!list.childElementCount) message.textContent = t('No executions');
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
  dialog.onclose = () => { if (!dialog.open) clearReplay(); };
  function reset() {
    request++; clearReplay();
    dialog.close(); filter.value = ''; list.replaceChildren(); warning.textContent = '';
  }
  return { button, dialog, warning, setLocale, refresh: () => { if (inspecting === undefined) void refresh(); }, reset,
    updateCopy: () => replay?.updateCopy(canCopy()),
    failed(error: unknown) { warning.textContent = t('History unavailable') + ' · ' + String(error); },
  };
}
