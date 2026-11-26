import { isPlainObject, isParameterVisible, type ExpressionEngine, type JsonObject, type JsonValue,
  type NodeType, type ParamSchema, type ParamValue, type WorkflowNode } from '@draflow/core';

export function button(name: string, action: () => void) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = name;
  el.onclick = action;
  return el;
}
export function group(title: string) {
  const el = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = title;
  el.append(legend);
  return el;
}
type Values = Record<string, ParamValue>;
interface Context {
  expression: ExpressionEngine;
  preview(value: string): string;
  node: WorkflowNode;
  type: NodeType;
  modes: Map<string, { fixed: ParamValue; expression: ParamValue }>;
  changed(redraw: boolean, control?: HTMLElement): void;
}

const operators = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex',
  'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse', 'exists', 'notExists'];
const options = (values: string[]) => values.map(value => ({ value, label: value }));

export function renderFields(parent: HTMLElement, schemas: ParamSchema[], values: Values, ctx: Context, path: (string | number)[] = []) {
  for (const field of schemas) {
    if (field.type === 'hidden' || !isParameterVisible(field, ctx.node, ctx.type)) continue;
    const key = [...path, field.name];
    const currentValue = () => values[field.name] === undefined ? field.default : values[field.name];
    const value = currentValue();
    const expressionValue = !field.noExpression && typeof value === 'string' && value.startsWith('=');
    function write(next: ParamValue, redraw = false, control?: HTMLElement) {
      if (next === undefined) delete values[field.name];
      else values[field.name] = next;
      ctx.changed(redraw, control);
    }
    if (field.type === 'notice' || field.type === 'callout' || field.type === 'resourceLocator') {
      const note = document.createElement('p');
      note.textContent = [field.label, field.description, field.type === 'resourceLocator' && JSON.stringify(value)].filter(Boolean).join(' · ');
      parent.append(note);
      continue;
    }
    if (field.type === 'filter' && !expressionValue) {
      const combinators = field.allowedCombinators ?? ['and', 'or'];
      const conditionFields: ParamSchema[] = [
        { name: 'left', label: 'Left', type: 'string' },
        { name: 'operator', label: 'Operator', type: 'select', options: options(operators), default: 'equals' },
        { name: 'right', label: 'Right', type: 'string' },
      ];
      const box = group(field.label);
      const data = structuredClone(isPlainObject(value) ? value : { combinator: combinators[0] ?? 'and', conditions: [] });
      renderFields(box, [
        { name: 'combinator', label: 'Combine', type: 'select', options: options(combinators), default: combinators[0] ?? 'and' },
        { name: 'conditions', label: 'Conditions', type: 'fixedCollection', multiple: true, fields: conditionFields,
          ...(field.maxConditions !== undefined && { max: field.maxConditions }) },
      ], data, { ...ctx, changed: (redraw, control) => write(data, redraw, control) }, key);
      parent.append(box);
      continue;
    }
    if ((field.type === 'collection' || field.type === 'fixedCollection') && !expressionValue) {
      const box = group(field.label);
      parent.append(box);
      if (field.type === 'collection' || !field.multiple) {
        const data = structuredClone(isPlainObject(value) ? value : {});
        renderFields(box, field.fields, data, { ...ctx, changed: (redraw, control) => write(data, redraw, control) }, key);
        continue;
      }
      const wrapped = isPlainObject(value) && Array.isArray(value.values);
      const raw = wrapped ? value.values : value;
      const rows: JsonValue[] = structuredClone(Array.isArray(raw) ? raw : isPlainObject(raw) ? [raw] : []);
      function update(redraw: boolean, control?: HTMLElement) { write(wrapped ? { ...value as JsonObject, values: rows } : rows, redraw, control); }
      rows.forEach((row, i) => {
        const item = group(String(i + 1));
        if (isPlainObject(row)) renderFields(item, field.fields, row, { ...ctx, changed: update }, [...key, i]);
        const remove = button('Remove', () => { rows.splice(i, 1); ctx.modes.clear(); update(true); });
        remove.disabled = rows.length <= (field.min ?? 0);
        item.append(remove);
        box.append(item);
      });
      const add = button('Add row', () => {
        const row: JsonObject = {};
        for (const f of field.fields) if (f.default !== undefined) row[f.name] = structuredClone(f.default);
        rows.push(row);
        update(true);
      });
      add.disabled = rows.length >= (field.max ?? Infinity);
      box.append(add);
      continue;
    }

    const label = document.createElement('label');
    label.append(field.label);
    parent.append(label);
    const constrained = ['select', 'multiSelect', 'number', 'boolean'].includes(field.type);
    if (constrained && !field.noExpression) {
      const toggle = button(expressionValue ? 'Fixed' : 'Expression', () => {
        const id = JSON.stringify(key);
        const saved = ctx.modes.get(id) ?? { fixed: field.default, expression: undefined };
        const current = currentValue();
        if (expressionValue) saved.expression = current;
        else saved.fixed = current;
        ctx.modes.set(id, saved);
        write(expressionValue ? saved.fixed : saved.expression ?? '={{ ' + JSON.stringify(current ?? '') + ' }}', true);
      });
      toggle.setAttribute('aria-label', field.label + ' · ' + toggle.textContent);
      parent.append(toggle);
    }
    if (!expressionValue && (field.type === 'select' || field.type === 'multiSelect') && Array.isArray(field.options)) {
      const select = document.createElement('select');
      select.name = field.name;
      select.setAttribute('aria-label', field.label);
      select.multiple = field.type === 'multiSelect';
      if (!select.multiple && value === undefined) select.add(new Option('—', ''));
      for (const choice of field.options) {
        const option = new Option(choice.label, choice.value);
        option.disabled = choice.disabled ?? false;
        option.selected = Array.isArray(value) ? value.includes(choice.value) : choice.value === value;
        select.add(option);
      }
      select.required = field.required ?? false;
      select.onchange = () => write(select.multiple ? [...select.selectedOptions].map(o => o.value) : select.value);
      label.append(select);
      continue;
    }

    const text = field.type === 'text' || field.type === 'json' || field.type === 'code'
      ? document.createElement('textarea') : document.createElement('input');
    text.name = field.name;
    if (text instanceof HTMLInputElement) {
      if (field.type === 'boolean' && !expressionValue) { text.type = 'checkbox'; text.checked = value === true; }
      if (field.type === 'number' && !expressionValue) {
        text.type = 'number'; text.step = field.precision === undefined ? 'any' : String(10 ** -field.precision);
        if (field.min !== undefined) text.min = String(field.min);
        if (field.max !== undefined) text.max = String(field.max);
      }
      if (field.type === 'string' && field.password) text.type = 'password';
    }
    text.required = (field.required ?? false) && text.type !== 'checkbox';
    text.placeholder = field.placeholder ?? '';
    text.value = field.type === 'json' && !expressionValue ? JSON.stringify(value, null, 2) ?? '' : String(value ?? '');
    const preview = document.createElement('small');
    function read() {
      text.setCustomValidity('');
      text.removeAttribute('aria-invalid');
      try {
        const source = text.value;
        let next: ParamValue = source;
        if (text instanceof HTMLInputElement && text.type === 'checkbox') next = text.checked;
        else if (text instanceof HTMLInputElement && text.type === 'number') next = source ? text.valueAsNumber : undefined;
        else if (source.startsWith('=') && !field.noExpression) {
          const issue = ctx.expression.validate(source)[0];
          if (issue) throw new Error(issue.message);
          preview.textContent = ctx.preview(source);
        } else if (field.type === 'json') next = source ? JSON.parse(source) as JsonValue : undefined;
        if (!source.startsWith('=')) preview.textContent = '';
        if (text.validity.valid) write(next, false, text);
        else text.setAttribute('aria-invalid', 'true');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        text.setCustomValidity(message);
        text.setAttribute('aria-invalid', 'true');
        preview.textContent = message;
      }
    }
    if (expressionValue) {
      const issue = ctx.expression.validate(value)[0];
      if (issue) { text.setCustomValidity(issue.message); text.setAttribute('aria-invalid', 'true'); }
      preview.textContent = issue?.message ?? ctx.preview(value);
    }
    text.oninput = read;
    label.append(text);
    parent.append(preview);
  }
}
