import type { EngineEvents, NodeType, RunOptions, Workflow } from '@draflow/core';
import { createWorkflowEditor, type ChangeMeta, type EditorOptions, type WorkflowEditor } from './index.js';

export interface DraflowEditorElement extends HTMLElement {
  workflow: Workflow | undefined;
  nodeTypes: readonly NodeType[];
  ports: NonNullable<EditorOptions['ports']>;
  undo(): void;
  redo(): void;
  run: WorkflowEditor['run'];
  runNode: WorkflowEditor['runNode'];
  fitView(): void;
  focusNode(id: string): void;
  runPreviousNodes: WorkflowEditor['runPreviousNodes'];
  clearExecution(): void;
  stop(): void;
  destroy(): void;
}

declare global {
  interface HTMLElementEventMap {
    'draflow-ready': CustomEvent<null>;
    'draflow-change': CustomEvent<ChangeMeta & { workflow: Workflow }>;
    'draflow-selection': CustomEvent<{ nodeIds: string[] }>;
    'draflow-toast': CustomEvent<{ workflowId: string; message: string }>;
    'draflow-run-start': CustomEvent<EngineEvents['run:start']>;
    'draflow-node-start': CustomEvent<EngineEvents['node:start']>;
    'draflow-node-finish': CustomEvent<EngineEvents['node:finish']>;
    'draflow-run-finish': CustomEvent<EngineEvents['run:finish']>;
  }
  interface HTMLElementTagNameMap {
    'draflow-editor': DraflowEditorElement;
  }
}

export function defineDraflowEditor(): void {
  if (typeof customElements === 'undefined' || customElements.get('draflow-editor')) return;

  class EditorElement extends HTMLElement implements DraflowEditorElement {
    static observedAttributes = ['locale', 'theme', 'readonly'];
    #workflow: Workflow | undefined;
    #types: readonly NodeType[] = [];
    #ports: NonNullable<EditorOptions['ports']> = {};
    get ports() { return { ...this.#ports }; }
    set ports(value: NonNullable<EditorOptions['ports']>) {
      this.#ports = { ...value };
      if (this.#editor) this.#remount();
    }
    #remount() {
      this.#workflow = this.#editor?.getWorkflow();
      this.#mount();
    }
    #editor: WorkflowEditor | undefined;

    get workflow() { return this.#editor?.getWorkflow() ?? structuredClone(this.#workflow); }
    set workflow(value: Workflow | undefined) {
      this.#workflow = structuredClone(value);
      if (value && this.#editor) this.#editor.setWorkflow(value);
      else if (this.#editor) this.#mount();
    }

    get nodeTypes() { return [...this.#types]; }
    set nodeTypes(types: readonly NodeType[]) {
      this.#types = [...types];
      if (this.#editor) this.#remount();
    }

    connectedCallback() {
      // Replay properties assigned while the element was awaiting registration.
      for (const key of ['workflow', 'nodeTypes', 'ports'] as const) {
        if (Object.hasOwn(this, key)) {
          const value = Reflect.get(this, key);
          Reflect.deleteProperty(this, key);
          Reflect.set(this, key, value);
        }
      }
      if (!this.#editor) this.#mount();
      this.dispatchEvent(new CustomEvent('draflow-ready', { bubbles: true, composed: true }));
    }

    disconnectedCallback() { this.destroy(); }
    attributeChangedCallback(_name: string, before: string | null, after: string | null) {
      if (!this.#editor || before === after) return;
      this.#editor.setPresentation(this.#presentation());
    }

    #presentation(): Pick<EditorOptions, 'theme' | 'locale' | 'readonly'> {
      const theme = this.getAttribute('theme');
      return {
        theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
        locale: this.getAttribute('locale') === 'ja' ? 'ja' : 'en',
        readonly: this.hasAttribute('readonly'),
      };
    }

    #mount() {
      this.#editor?.destroy();
      const options: EditorOptions = { ...this.#presentation(), nodeTypes: this.#types, ports: this.#ports };
      if (this.#workflow) options.workflow = this.#workflow;
      this.#editor = createWorkflowEditor(this, options);
    }

    run(options?: RunOptions) {
      if (!this.#editor) throw new Error('Editor is not mounted');
      return this.#editor.run(options);
    }
    runNode(id: string) {
      if (!this.#editor) throw new Error('Editor is not mounted');
      return this.#editor.runNode(id);
    }
    runPreviousNodes(id: string) {
      if (!this.#editor) throw new Error('Editor is not mounted');
      return this.#editor.runPreviousNodes(id);
    }
    clearExecution() { this.#editor?.clearExecution(); }
    undo() { this.#editor?.undo(); }
    redo() { this.#editor?.redo(); }
    fitView() { this.#editor?.fitView(); }
    focusNode(id: string) { this.#editor?.focusNode(id); }
    stop() { this.#editor?.stop(); }
    destroy() {
      if (this.#editor) this.#workflow = this.#editor.getWorkflow();
      this.#editor?.destroy();
      this.#editor = undefined;
    }
  }
  customElements.define('draflow-editor', EditorElement);
}

defineDraflowEditor();
