import type { Translate } from '../locale.js';
import type { JsonValue, PortData } from '@draflow/core';
import { button } from './fields.js';
import { fieldPath, type FieldPath } from './mapping.js';

export function choice(name: string, options: [string, string][], value: string, change: (value: string) => void) {
  const el = document.createElement('select');
  el.setAttribute('aria-label', name);
  for (const [id, label] of options) el.add(new Option(label, id));
  el.value = value;
  el.onchange = () => change(el.value);
  return el;
}
export function entries(value: JsonValue, path: FieldPath = []): { path: FieldPath; value: JsonValue }[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const next = [...path, Array.isArray(value) ? Number(k) : k];
    return [{ path: next, value: v }, ...entries(v, next)];
  });
}

export function dataPanel(name: string, t: Translate, selectionChanged: () => void) {
  const root = document.createElement('div');
  const heading = document.createElement('h3');
  heading.textContent = t(name);
  let data: PortData | undefined;
  let mode = 'JSON', query = '', page = 0, item = 0, port = 'main', slot = 0;
  let explicitPort = false;
  const controls = document.createElement('div');
  const search = document.createElement('input');
  search.type = 'search';
  search.setAttribute('aria-label', t('Search ' + name));
  search.placeholder = t('Search');
  const body = document.createElement('div');
  root.append(heading, controls, body);
  search.oninput = () => { query = search.value.toLowerCase(); page = 0; renderBody(); };
  const items = () => data?.[port]?.[slot] ?? [];
  const count = document.createElement('small');
  function renderBody() {
    body.replaceChildren();
    const list = items();
    const matches = list.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
      !query || JSON.stringify(entry.json).toLowerCase().includes(query));
    count.textContent = (query ? matches.length + ' / ' : '') + list.length + t(list.length === 1 ? ' item' : ' items');
    const pages = Math.max(1, Math.ceil(matches.length / 100));
    page = Math.min(page, pages - 1);
    const batch = matches.slice(page * 100, page * 100 + 100);
    if (mode === 'Table') {
      const wrap = document.createElement('div');
      wrap.className = 'data-scroll'; wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', t(name + ' table'));
      const table = document.createElement('table');
      const cols = [...new Set(list.flatMap(entry => Object.keys(entry.json)))];
      const header = table.createTHead().insertRow();
      for (const label of [t('Item'), ...cols]) {
        const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; header.append(th);
      }
      const tbody = table.createTBody();
      for (const { entry, index } of batch) {
        const row = tbody.insertRow();
        const select = button(String(index + 1), () => pick(index));
        select.setAttribute('aria-pressed', String(item === index));
        const rowHeader = document.createElement('th');
        rowHeader.scope = 'row'; rowHeader.append(select); row.append(rowHeader);
        for (const key of cols) row.insertCell().textContent = JSON.stringify(entry.json[key]) ?? '';
      }
      wrap.append(table); body.append(wrap);
    } else if (mode === 'Schema') {
      const schema = new Map<string, Set<string>>();
      for (const { entry } of matches) for (const field of entries(entry.json)) {
        const key = fieldPath(field.path);
        const types = schema.get(key) ?? new Set<string>();
        types.add(field.value === null ? 'null' : Array.isArray(field.value) ? 'array' : typeof field.value);
        schema.set(key, types);
      }
      const dl = document.createElement('dl');
      for (const [key, types] of schema) {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = key; dd.textContent = [...types].join(' | '); dl.append(dt, dd);
      }
      body.append(dl);
    } else {
      const pre = document.createElement('pre');
      pre.append('[');
      batch.forEach(({ entry, index }, i) => {
        pre.append(i ? ',\n' : '\n');
        const line = document.createElement(index === item ? 'mark' : 'span');
        line.textContent = JSON.stringify(entry.json, null, 2).split('\n').map(s => '  ' + s).join('\n');
        pre.append(line);
      });
      pre.append(batch.length ? '\n]' : ']');
      body.append(pre);
    }
    if (mode !== 'Schema' && pages > 1) {
      const prev = button(t('Previous'), () => { page--; renderBody(); });
      const next = button(t('Next'), () => { page++; renderBody(); });
      prev.disabled = page === 0; next.disabled = page + 1 >= pages;
      body.append(prev, ' ' + (page + 1) + ' / ' + pages + ' ', next);
    }
  }
  function pick(index: number) {
    item = index;
    render(); selectionChanged();
  }
  function render() {
    controls.replaceChildren(); body.replaceChildren();
    const slots = Object.entries(data ?? {}).flatMap(([key, values]) => values.flatMap((value, i) =>
      value === null ? [] : [{ key, i, length: value.length }]));
    if (!slots.length) return;
    const current = slots.find(s => s.key === port && s.i === slot);
    const active = (explicitPort && current) || slots.find(s => s.length) || slots[0]!;
    port = active.key; slot = active.i; item = Math.min(item, Math.max(0, active.length - 1));
    controls.append(choice(t(name + ' port'), slots.map((s, i) => [String(i), s.key + '[' + s.i + '] · ' + s.length]),
      String(slots.indexOf(active)), v => {
        const s = slots[Number(v)]!; port = s.key; slot = s.i; explicitPort = true; page = 0; pick(0);
      }));
    const index = document.createElement('input');
    index.type = 'number'; index.min = '1'; index.max = String(active.length); index.value = String(item + 1);
    index.setAttribute('aria-label', t(name + ' item')); index.disabled = !active.length;
    index.onchange = () => { if (index.value && index.validity.valid) { page = Math.floor((index.valueAsNumber - 1) / 100); pick(index.valueAsNumber - 1); } };
    const label = document.createElement('label');
    label.append(t('Item'), index);
    controls.append(label, choice(t(name + ' view'), ['Schema', 'Table', 'JSON'].map(v => [v, t(v)]), mode, v => {
      mode = v; page = 0; renderBody();
    }), search, count);
    renderBody();
  }
  return { root, set(value?: PortData) { if (data !== value) { data = value; render(); } },
    reset() { data = undefined; controls.replaceChildren(); body.replaceChildren(); mode = 'JSON'; query = search.value = ''; page = item = slot = 0; port = 'main'; explicitPort = false; },
    selection() { return { port, slot, index: item, item: items()[item] }; },
  };
}
