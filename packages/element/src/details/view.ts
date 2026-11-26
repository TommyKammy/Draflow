import { getVisibleParameters, resolveNodeSettings, type ExecutionEngine, type NodeRegistry, type NodeSettings,
  type ParamSchema, type ParamValue, type PortData, type TaskData, type WorkflowNode } from '@draflow/core';
import { button, renderFields } from './fields.js';

interface Actions {
  registry: NodeRegistry;
  engine: ExecutionEngine;
  get(id: string): WorkflowNode | undefined;
  task(id: string): TaskData | undefined;
  output(id: string): PortData | undefined;
  canEdit(): boolean;
  commit(node: WorkflowNode, control?: HTMLElement): void;
  duplicate(id: string): void;
  execute(id: string): void;
}

const settings: ParamSchema[] = [
  { name: 'disabled', label: 'Disabled', type: 'boolean' },
  { name: 'executeOnce', label: 'Execute Once', type: 'boolean' },
  { name: 'alwaysOutputData', label: 'Always Output Data', type: 'boolean' },
  { name: 'retryOnFail', label: 'Retry on Fail', type: 'boolean' },
  { name: 'maxTries', label: 'Max Tries', type: 'number', min: 2, max: 5, precision: 0 },
  { name: 'waitBetweenTries', label: 'Wait Between Tries (ms)', type: 'number', min: 0, max: 5000, precision: 0 },
  { name: 'onError', label: 'On Error', type: 'select', options: [
    { label: 'Stop', value: 'stop' }, { label: 'Continue', value: 'continue' },
    { label: 'Error Output', value: 'errorOutput' }] },
  { name: 'notes', label: 'Notes', type: 'text' },
  { name: 'notesInFlow', label: 'Show notes on canvas', type: 'boolean' },
];

export function nodeDetails(actions: Actions) {
  const dialog = document.createElement('dialog');
  dialog.className = 'node-details';
  dialog.setAttribute('aria-labelledby', 'details-title');
  const title = document.createElement('h2');
  title.id = 'details-title';
  const version = document.createElement('small');
  const header = document.createElement('header');
  const step = button('Execute step', () => {
    if (!draft || !flush(true)) return;
    try { actions.execute(draft.id); } catch (e) { feedback.textContent = String(e); }
  });
  const duplicate = button('Duplicate', () => {
    if (!draft || !flush(true)) return;
    const id = draft.id;
    close();
    actions.duplicate(id);
  });
  const discard = button('Discard invalid input', close);
  discard.hidden = true;
  header.append(title, version, step, duplicate, button('Close', () => { if (flush(true)) close(); }), discard);
  const panes = document.createElement('div');
  panes.className = 'details-panes';
  const tabs = document.createElement('nav');
  tabs.className = 'details-tabs';
  const sections = ['Input', 'Node', 'Output'].map((name, index) => {
    const section = document.createElement('section');
    const tab = button(name, () => showPane(index));
    tabs.append(tab);
    panes.append(section);
    return section;
  });
  function showPane(index: number) {
    sections.forEach((s, i) => {
      s.classList.toggle('current', i === index);
      tabs.children[i]!.setAttribute('aria-pressed', String(i === index));
    });
  }
  const mode = document.createElement('nav');
  const form = document.createElement('form');
  form.setAttribute('aria-labelledby', 'details-title');
  form.onsubmit = e => { e.preventDefault(); flush(true); };
  const feedback = document.createElement('p');
  feedback.setAttribute('aria-live', 'polite');
  let settingsMode = false;
  for (const name of ['Parameters', 'Settings']) mode.append(button(name, () => {
    if (!flush(true)) return;
    settingsMode = name === 'Settings';
    renderForm();
  }));
  sections[1]!.append(mode, form, feedback);
  dialog.append(header, tabs, panes);
  let draft: WorkflowNode | undefined;
  let pending = false;
  let fieldNames = '';
  const modes = new Map<string, { fixed: ParamValue; expression: ParamValue }>();
  function visibleFields(node: WorkflowNode) {
    const type = actions.registry.get(node.type, node.typeVersion);
    return type ? getVisibleParameters(type, node) : [];
  }
  function signature(node: WorkflowNode) {
    return settingsMode ? String(node.settings?.retryOnFail ?? false) : JSON.stringify(visibleFields(node).map(f => f.name));
  }
  let editingControl: HTMLElement | undefined;

  function flush(report = false) {
    if (!draft || !actions.canEdit()) return true;
    if (!form.checkValidity()) {
      if (report) { discard.hidden = false; form.reportValidity(); }
      return false;
    }
    discard.hidden = true;
    if (pending) {
      pending = false;
      actions.commit(structuredClone(draft), editingControl);
    }
    return true;
  }
  // Invalid text exists only in its control until it can be parsed into the draft.
  function canRedraw(removing?: HTMLElement) {
    const invalid = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[aria-invalid="true"]:invalid')]
      .find(control => !removing?.contains(control));
    if (!invalid) return true;
    discard.hidden = false;
    invalid.reportValidity();
    return false;
  }
  function changed(redraw: boolean, control?: HTMLElement) {
    editingControl = control;
    pending = true;
    if (redraw || (draft && fieldNames !== signature(draft) && canRedraw())) renderForm();
    flush();
  }
  function close() {
    editingControl = undefined;
    pending = false;
    draft = undefined;
    modes.clear();
    discard.hidden = true;
    dialog.close();
  }
  // Escape dismisses the editor and discards any invalid, uncommitted input.
  dialog.oncancel = () => { flush(); close(); };
  function renderForm() {
    if (!draft) return;
    const node = draft;
    fieldNames = signature(node);
    const type = actions.registry.get(node.type, node.typeVersion);
    form.replaceChildren();
    const fields = document.createElement('fieldset');
    fields.disabled = !actions.canEdit();
    form.append(fields);
    const switches = mode.querySelectorAll('button');
    switches[0]!.setAttribute('aria-pressed', String(!settingsMode));
    switches[1]!.setAttribute('aria-pressed', String(settingsMode));
    if (!type) { fields.textContent = node.type; return; }
    const context = { modes, canRedraw, expression: actions.engine.expression, type, node, changed,
      preview(value: string) {
        const task = actions.task(node.id);
        if (!task?.input?.main?.[0]?.length) return 'No preview input';
        try { return JSON.stringify(actions.engine.preview(task, value, 0, node.parameters)) ?? 'undefined'; }
        catch (e) { return String(e); }
      },
    };
    if (settingsMode) {
      const defaults = resolveNodeSettings(node);
      const values = { ...defaults, disabled: node.disabled ?? false, notes: node.notes ?? '', notesInFlow: node.notesInFlow ?? false };
      const visible = settings.filter(s => values.retryOnFail || !['maxTries', 'waitBetweenTries'].includes(s.name));
      renderFields(fields, visible.map(field => ({ ...field, noExpression: true })), values, { ...context, changed(redraw, control) {
        if (values.disabled !== (node.disabled ?? false)) node.disabled = values.disabled;
        if (values.notes !== (node.notes ?? '')) node.notes = values.notes;
        if (values.notesInFlow !== (node.notesInFlow ?? false)) node.notesInFlow = values.notesInFlow;
        const next: NodeSettings = { ...node.settings };
        for (const key of Object.keys(defaults) as (keyof NodeSettings)[]) {
          if (values[key] !== defaults[key]) Object.assign(next, { [key]: values[key] });
        }
        if (Object.keys(next).length) node.settings = next;
        Object.assign(defaults, resolveNodeSettings(node));
        changed(redraw, control);
      } });
    } else {
      const schemas = getVisibleParameters(type, node);
      if (!schemas.length) fields.textContent = 'No parameters';
      renderFields(fields, schemas, node.parameters, context);
    }
  }
  function dataPane(section: HTMLElement, name: string, data?: PortData) {
    const heading = document.createElement('h3');
    heading.textContent = name;
    section.replaceChildren(heading);
    for (const [port, slots] of Object.entries(data ?? {})) slots.forEach((items, index) => {
      const label = document.createElement('h4');
      label.textContent = port + '[' + index + '] · ' + (items?.length ?? 0);
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify((items ?? []).slice(0, 100).map(i => i.json), null, 2);
      section.append(label, pre);
    });
  }
  function refreshData() {
    if (!draft) return;
    step.disabled = duplicate.disabled = !actions.canEdit();
    const task = actions.task(draft.id);
    dataPane(sections[0]!, 'Input', task?.input);
    dataPane(sections[2]!, 'Output', actions.output(draft.id));
    feedback.textContent = task?.error?.message ?? '';
  }
  function refresh() { refreshData(); renderForm(); }
  return { dialog, close, refresh, refreshData, flush,
    open(id: string) {
      const node = actions.get(id);
      if (!node) return;
      close();
      draft = structuredClone(node);
      title.textContent = node.name;
      version.textContent = node.type + ' · v' + node.typeVersion;
      settingsMode = false;
      showPane(1);
      refresh();
      dialog.showModal();
    },
  };
}
