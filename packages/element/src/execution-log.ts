import type { Translate } from './locale.js';
import type { EngineEvents, PortData, RunResult, TaskData } from '@draflow/core';

function count(data: PortData | undefined) {
  return Object.values(data ?? {}).reduce((sum, slots) =>
    sum + slots.reduce((total, items) => total + (items?.length ?? 0), 0), 0);
}

export function executionLog(clearExecution: () => void, t: Translate) {
  const panel = document.createElement('section');
  panel.className = 'execution-log';
  const title = document.createElement('h3');
  const info = document.createElement('p');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.onclick = clearExecution;
  const list = document.createElement('div');
  panel.append(title, info, list, clear);
  const rows = new Map<string, (task?: TaskData, terminal?: string) => void>();

  const renderRows: (() => void)[] = [];
  let summary: { name: string; id: string | undefined; state: string; detail?: string } | undefined;
  function setLocale(next: typeof t) {
    t = next;
    title.textContent = t('Execution log');
    panel.setAttribute('aria-label', title.textContent);
    clear.textContent = t('Clear execution');
    renderInfo();
    for (const render of renderRows) render();
  }
  function renderInfo() {
    info.textContent = summary ? [summary.name, summary.id, t(summary.state), summary.detail].filter(Boolean).join(' · ') : '';
  }
  setLocale(t);
  function reset(hasCachedData = false) {
    summary = undefined;
    renderRows.length = 0;
    rows.clear();
    list.replaceChildren();
    info.textContent = '';
    panel.hidden = !hasCachedData;
    clear.disabled = false;
  }
  function start(id: string, name: string) {
    reset();
    panel.hidden = false;
    summary = { name, id, state: 'running' };
    renderInfo();
    clear.disabled = true;
  }
  function nodeStart(event: EngineEvents['node:start']) {
    const row = document.createElement('details');
    const label = document.createElement('summary');
    const data = document.createElement('code');
    row.append(label, data);
    list.append(row);
    let finished: TaskData | undefined;
    function renderData() {
      data.textContent = row.open ? JSON.stringify({
        input: finished?.input ?? event.input, output: finished?.output,
      }, null, 2) : '';
    }
    row.ontoggle = renderData;
    let state = 'running';
    function renderLabel() {
      const task = finished;
      const parts = [event.nodeName, t('Run') + ' ' + event.runIndex, t(state),
        t('In') + ' ' + (task?.input ? count(task.input) : event.totalInputCount)];
      if (event.reused) parts.push(t('reused'));
      if (task) parts.push(t('Out') + ' ' + count(task.output), task.executionTime + ' ms');
      if (task?.error) parts.push(task.error.message);
      label.textContent = parts.join(' · ');
    }
    renderRows.push(renderLabel);
    function update(task?: TaskData, terminal?: string) {
      finished = task;
      state = task?.status ?? terminal ?? 'running';
      renderLabel();
      renderData();
    }
    update();
    rows.set(JSON.stringify([event.nodeId, event.runIndex]), update);
  }
  function nodeFinish(event: EngineEvents['node:finish']) {
    const key = JSON.stringify([event.nodeId, event.runIndex]);
    rows.get(key)?.(event.task);
    rows.delete(key);
  }
  function finish(result: RunResult, name: string) {
    for (const update of rows.values()) update(undefined, result.status);
    rows.clear();
    summary = { name, id: result.id, state: result.status,
      detail: [(result.stoppedAt - result.startedAt) + ' ms', result.error?.message].filter(Boolean).join(' · ') };
    renderInfo();
    clear.disabled = false;
  }
  function fail(message: string, name: string, id?: string) {
    for (const update of rows.values()) update(undefined, 'error');
    rows.clear();
    panel.hidden = false;
    summary = { name, id, state: 'error', detail: message };
    renderInfo();
    clear.disabled = false;
  }
  return { panel, setLocale, reset, start, nodeStart, nodeFinish, finish, fail };
}
