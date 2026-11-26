import type { Translate } from '../locale.js';
import { getVisibleParameters, isParameterVisible, resolveNodeSettings, type ExecutionEngine, type NodeRegistry, type NodeSettings,
  type ParamSchema, type ParamValue, type Item, type TaskData, type WorkflowNode } from '@draflow/core';
import { choice, dataPanel, entries } from './data.js';
import { fieldPath, type Mapping } from './mapping.js';
import { button, renderFields } from './fields.js';

interface Actions {
  registry: NodeRegistry;
  engine: ExecutionEngine;
  get(id: string): WorkflowNode | undefined;
  tasks(id: string): TaskData[];
  hasOutput(id: string): boolean;
  ancestors(id: string): string[];
  pinned(id: string): Item[] | undefined;
  pin(id: string, items: Item[] | undefined): void;
  canEdit(): boolean;
  commit(node: WorkflowNode, control?: HTMLElement): void;
  duplicate(id: string): void;
  execute(id: string): void;
  previous(id: string): void;
  running(): boolean;
  failure(): string | undefined;
  stop(): void;
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

export function nodeDetails(actions: Actions, t: Translate) {
  const dialog = document.createElement('dialog');
  dialog.className = 'node-details';
  dialog.setAttribute('aria-labelledby', 'details-title');
  const title = document.createElement('h2');
  title.id = 'details-title';
  const version = document.createElement('small');
  const header = document.createElement('header');
  const step = button(t('Execute step'), () => {
    if (!draft || !flush(true)) return;
    try { actions.execute(draft.id); } catch (e) { feedback.textContent = String(e); }
  });
  const previous = button(t('Execute previous nodes'), () => {
    if (!draft || !flush(true)) return;
    try { actions.previous(draft.id); } catch (e) { feedback.textContent = String(e); }
  });
  const stop = button(t('Stop'), actions.stop);
  const duplicate = button(t('Duplicate'), () => {
    if (!draft || !flush(true)) return;
    const id = draft.id;
    close();
    actions.duplicate(id);
  });
  const discard = button(t('Discard invalid input'), close);
  discard.hidden = true;
  const dismiss = button(t('Close'), () => { if (flush(true)) close(); });
  dismiss.autofocus = true;
  header.append(title, version, previous, step, stop, duplicate, dismiss, discard);
  const panes = document.createElement('div');
  panes.className = 'details-panes';
  const tabs = document.createElement('nav');
  tabs.className = 'details-tabs';
  const sections = ['Input', 'Node', 'Output'].map((name, index) => {
    const section = document.createElement('section');
    const tab = button(t(name), () => showPane(index));
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
  for (const name of ['Parameters', 'Settings']) mode.append(button(t(name), () => {
    if (!flush(true)) return;
    settingsMode = name === 'Settings';
    renderForm();
  }));
  sections[1]!.append(mode, form, feedback);
  dialog.append(header, tabs, panes);
  let draft: WorkflowNode | undefined;
  const previews: (() => void)[] = [];
  let runIndex = -1;
  const runChoice = document.createElement('span');
  header.insertBefore(runChoice, step);
  let ancestor = '', append = false, dragging = false;
  let mapping: Mapping | undefined;
  let mappingTask: TaskData | undefined;
  const mappingControls = document.createElement('div');
  const pinControls = document.createElement('div');
  const inputPanel = dataPanel('Input', t, () => {
    clearMapping();
    renderMapping();
    // Refresh previews without replacing controls containing uncommitted text.
    for (const update of previews) update();
  });
  const outputPanel = dataPanel('Output', t, () => {});
  sections[0]!.append(inputPanel.root, mappingControls);
  sections[2]!.append(outputPanel.root, pinControls);
  function task() { return draft && actions.tasks(draft.id)[runIndex]; }
  function clearMapping() {
    mapping = undefined;
    dragging = false;
    delete dialog.dataset.mapping;
  }
  function renderMapping() {
    mappingControls.replaceChildren();
    const selected = inputPanel.selection();
    const currentTask = task();
    if (!draft || !currentTask || !selected.item || !actions.canEdit()) { clearMapping(); return; }
    const names = actions.ancestors(draft.id);
    const source = choice(t('Map from'), [['', t('Current input')], ...names.map(n => [n, n] as [string, string])], ancestor, v => {
      ancestor = v; clearMapping(); renderMapping();
    });
    const position = choice(t('Mapping insertion'), [['replace', t('Replace value')], ['cursor', t('Insert at cursor')]],
      append ? 'cursor' : 'replace', v => { append = v === 'cursor'; });
    mappingControls.append(source, position);
    const item = ancestor ? actions.engine.previewAncestor(currentTask, ancestor, selected.index, selected.port, selected.slot) : selected.item;
    if (!item) { mappingControls.append(t('No linked item')); clearMapping(); return; }
    const fields = document.createElement('div');
    fields.className = 'mapping-fields';
    for (const { path, value } of entries(item.json)) {
      const key = fieldPath(path);
      function select() {
        mapping = { path, ...(ancestor && { ancestor }),
          ...(selected.port !== 'main' || selected.slot !== 0 ? { input: { port: selected.port, slot: selected.slot } } : {}) };
        dialog.dataset.mapping = 'true';
        for (const b of fields.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === field));
      }
      const field = button(key, select);
      field.setAttribute('aria-pressed', String(mapping?.ancestor === (ancestor || undefined) && fieldPath(mapping?.path ?? []) === key));
      field.title = JSON.stringify(value);
      field.draggable = true;
      field.ondragstart = e => {
        select(); dragging = true;
        e.dataTransfer?.setData('text/plain', key);
      };
      field.ondragend = () => { dragging = false; };
      fields.append(field);
    }
    mappingControls.append(fields);
  }
  let pending = false;
  let fieldNames = '';
  const modes = new Map<string, { fixed: ParamValue; expression: ParamValue }>();
  function signature(node: WorkflowNode) {
    if (settingsMode) return String(node.settings?.retryOnFail ?? false);
    const type = actions.registry.get(node.type, node.typeVersion);
    if (!type) return '';
    const paths: string[][] = [];
    function visit(fields: ParamSchema[], parent: string[]) {
      for (const field of fields) {
        if (field.type === 'hidden' || !isParameterVisible(field, node, type!)) continue;
        const path = [...parent, field.name];
        paths.push(path);
        if (field.type === 'collection' || field.type === 'fixedCollection') visit(field.fields, path);
      }
    }
    visit(type.parameters, []);
    return JSON.stringify(paths);
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
    clearMapping(); mappingTask = undefined; mappingControls.replaceChildren();
    previews.length = 0;
    runIndex = -1; ancestor = ''; append = false;
    inputPanel.reset(); outputPanel.reset();
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
    previews.length = 0;
    const fields = document.createElement('fieldset');
    fields.disabled = !actions.canEdit();
    form.append(fields);
    const switches = mode.querySelectorAll('button');
    switches[0]!.setAttribute('aria-pressed', String(!settingsMode));
    switches[1]!.setAttribute('aria-pressed', String(settingsMode));
    if (!type) { fields.textContent = node.type; return; }
    let names: string[] | undefined;
    let linkedTask: TaskData | undefined, linkedKey = '', linked: Item | undefined;
    const context = { t, modes, canRedraw, previews, expression: actions.engine.expression, type, node, changed,
      completion() {
        const selected = inputPanel.selection(), current = task();
        return {
          input: selected.port === 'main' && selected.slot === 0 ? undefined : { port: selected.port, slot: selected.slot },
          names: () => names ??= actions.ancestors(node.id),
          json(name?: string) {
            if (name === undefined) return selected.item?.json;
            if (!current || !selected.item) return;
            const key = JSON.stringify([name, selected.port, selected.slot, selected.index]);
            if (current !== linkedTask || key !== linkedKey) {
              linked = actions.engine.previewAncestor(current, name, selected.index, selected.port, selected.slot);
              linkedTask = current; linkedKey = key;
            }
            return linked?.json;
          },
        };
      },
      preview(value: string) {
        const currentTask = task(), selected = inputPanel.selection();
        if (!currentTask || !selected.item) return { text: t('No preview input') };
        try {
          const result = actions.engine.preview(currentTask, value, selected.index, node.parameters, selected.port, selected.slot);
          return { text: JSON.stringify(result) ?? 'undefined', type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result };
        } catch (e) { return { text: String(e) }; }
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
      renderFields(fields, schemas, node.parameters, { ...context, mapping: () => mapping,
        insertAtCursor: () => append, dragging: () => dragging });
    }
  }
  function refreshData() {
    if (!draft) return;
    const id = draft.id;
    stop.hidden = !actions.running();
    previous.disabled = step.disabled = duplicate.disabled = !actions.canEdit();
    const tasks = actions.tasks(id).filter(Boolean);
    if (!tasks.some(t => t.runIndex === runIndex)) runIndex = tasks.at(-1)?.runIndex ?? -1;
    runChoice.replaceChildren();
    if (tasks.length) runChoice.append(choice(t('Run index'), tasks.map(task => [String(task.runIndex), t('Run') + ' ' + task.runIndex]),
      String(runIndex), v => {
        runIndex = Number(v); inputPanel.reset(); outputPanel.reset(); clearMapping();
        refreshData();
      }));
    const currentTask = task();
    inputPanel.set(currentTask?.input);
    const output = actions.hasOutput(id) ? currentTask?.output : undefined;
    const pinned = actions.pinned(id);
    outputPanel.set(output ?? (pinned !== undefined ? { main: [pinned] } : undefined));
    if (mappingTask !== currentTask || !actions.canEdit()) {
      mappingTask = currentTask;
      renderMapping();
    }
    pinControls.replaceChildren();
    const type = actions.registry.get(draft.type, draft.typeVersion);
    const ports = type?.ports.outputs ?? [];
    const pinnable = ports.length === 1 && ports[0]?.type === 'main' && draft.settings?.onError !== 'errorOutput' &&
      (!output || (Object.keys(output).every(k => k === 'main') && (output.main?.length ?? 0) <= 1));
    const items = output?.main?.[0];
    const pin = button(t(pinned !== undefined ? 'Unpin' : 'Pin output'), () => {
      if (flush(true)) actions.pin(id, pinned !== undefined ? undefined : items ?? undefined);
    });
    pin.disabled = !actions.canEdit() || (pinned === undefined && (!pinnable || !items || currentTask?.status !== 'success'));
    pinControls.append(pin);
    if (!pinnable) pinControls.append(' ' + t('Pinning requires a single main[0] output.'));
    for (const update of previews) update();
    feedback.textContent = currentTask?.error?.message ?? actions.failure() ?? '';
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
