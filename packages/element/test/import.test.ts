import { expect, it } from 'vitest';
import { createWorkflowEditor } from '@draflow/element';
import { defineDraflowEditor } from '@draflow/element/define';

it('imports both entry points and tolerates repeated registration on the server', () => {
  expect(typeof createWorkflowEditor).toBe('function');
  defineDraflowEditor();
  defineDraflowEditor();
});
