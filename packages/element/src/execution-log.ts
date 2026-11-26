import type { EngineEvents, PortData, RunResult, TaskData } from '@draflow/core';

function count(data: PortData | undefined) {
  return Object.values(data ?? {}).reduce((sum, slots) =>
    sum + slots.reduce((total, items) => total + (items?.length ?? 0), 0), 0);
}

export function executionLog(clearExecution: () => void) {
  const panel = document.createElement('section');
  panel.setAttribute('aria-label', 'Execution log');
  const title = document.createElement('h3');
  title.textContent = 'Execution log';
  const info = document.createElement('p');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = 'Clear execution';
  clear.onclick = clearExecution;
  const list = document.createElement('div');
  panel.append(title, info, list, clear);
  const rows = new Map<string, (task?: TaskData, terminal?: string) => void>();

  function reset(hasCachedData = false) {
    rows.clear();
    list.replaceChildren();
    info.textContent = '';
    panel.hidden = !hasCachedData;
    clear.disabled = false;
  }
  function start(id: string, name: string) {
    reset();
    panel.hidden = false;
    info.textContent = name + ' · ' + id + ' · running';
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
    function update(task?: TaskData, terminal?: string) {
      finished = task;
      const parts = [event.nodeName, 'Run ' + event.runIndex, task?.status ?? terminal ?? 'running',
        'In ' + (task?.input ? count(task.input) : event.totalInputCount)];
      if (event.reused) parts.push('reused');
      if (task) parts.push('Out ' + count(task.output), task.executionTime + ' ms');
      if (task?.error) parts.push(task.error.message);
      label.textContent = parts.join(' · ');
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
    info.textContent = [name, result.id, result.status, (result.stoppedAt - result.startedAt) + ' ms',
      result.error?.message].filter(Boolean).join(' · ');
    clear.disabled = false;
  }
  function fail(message: string, name: string, id?: string) {
    for (const update of rows.values()) update(undefined, 'error');
    rows.clear();
    panel.hidden = false;
    info.textContent = [name, id, 'error', message].filter(Boolean).join(' · ');
    clear.disabled = false;
  }
  return { panel, reset, start, nodeStart, nodeFinish, finish, fail };
}
