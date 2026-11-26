import type { NodeType, RunOptions, Workflow } from '@draflow/core';
import { createWorkflowEditor, type EditorOptions, type WorkflowEditor } from './index.js';

export interface DraflowEditorElement extends HTMLElement {
  workflow: Workflow | undefined;
  nodeTypes: readonly NodeType[];
  run: WorkflowEditor['run'];
  fitView(): void;
  focusNode(id: string): void;
  stop(): void;
  destroy(): void;
}

declare global {
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
      if (this.#editor) this.#mount();
    }

    connectedCallback() {
      // Replay properties assigned while the element was awaiting registration.
      for (const key of ['workflow', 'nodeTypes'] as const) {
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
      const options: EditorOptions = { ...this.#presentation(), nodeTypes: this.#types };
      if (this.#workflow) options.workflow = this.#workflow;
      this.#editor = createWorkflowEditor(this, options);
    }

    run(options?: RunOptions) {
      if (!this.#editor) throw new Error('Editor is not mounted');
      return this.#editor.run(options);
    }
    fitView() { this.#editor?.fitView(); }
    focusNode(id: string) { this.#editor?.focusNode(id); }
    stop() { this.#editor?.stop(); }
    destroy() {
      this.#editor?.destroy();
      this.#editor = undefined;
    }
  }
  customElements.define('draflow-editor', EditorElement);
}

defineDraflowEditor();
