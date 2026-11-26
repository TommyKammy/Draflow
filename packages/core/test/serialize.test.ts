import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/registry.js';
import {
  createConnection,
  createNode,
  createWorkflow,
  parseWorkflow,
  serializeWorkflow,
} from '../src/serialize.js';
import { validateWorkflow } from '../src/validate.js';
import type { NodeType } from '../src/node.js';

const nodeType: NodeType = {
  type: 'test.node',
  version: 1,
  meta: { label: 'Test', category: 'core' },
  ports: { inputs: [{ type: 'main' }], outputs: [{ type: 'main' }] },
  parameters: [
    { name: 'value', label: 'Value', type: 'string', default: '', required: true },
  ],
};

describe('serialize', () => {
  it('round-trips a workflow', () => {
    const a = createNode({ id: 'a', type: 'test.node', name: 'A', parameters: { value: 'x' } });
    const b = createNode({ id: 'b', type: 'test.node', name: 'B', parameters: { value: 'y' } });
    const workflow = createWorkflow({
      id: 'wf',
      name: 'Test',
      nodes: [a, b],
      connections: [
        createConnection({ node: 'a', port: 'main', index: 0 }, { node: 'b', port: 'main', index: 0 }),
      ],
      settings: { timezone: 'Asia/Tokyo', executionTimeout: 1000 },
    });

    const parsed = parseWorkflow(serializeWorkflow(workflow));
    expect(parsed).toEqual(workflow);
  });

  it('rejects unknown schemas', () => {
    expect(() => parseWorkflow({ schema: 'other/v1' })).toThrow(/Unsupported workflow schema/);
  });

  it('validates node types and required parameters', () => {
    const registry = new NodeRegistry().register(nodeType);
    const workflow = createWorkflow({
      nodes: [
        createNode({ id: 'a', type: 'test.node', name: 'A', parameters: {} }),
        createNode({ id: 'b', type: 'test.node', name: 'B', parameters: { value: 'ok' } }),
      ],
      connections: [
        createConnection({ node: 'a', port: 'main', index: 0 }, { node: 'b', port: 'main', index: 0 }),
      ],
    });

    const result = validateWorkflow(workflow, registry);
    expect(result.ok).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'REQUIRED_PARAMETER_MISSING')).toBe(true);
  });

  it('reports duplicate names and unknown types as errors', () => {
    const registry = new NodeRegistry().register(nodeType);
    const workflow = createWorkflow({
      nodes: [
        createNode({ id: 'a', type: 'test.node', name: 'Same' }),
        createNode({ id: 'b', type: 'missing.node', name: 'Same' }),
      ],
    });

    const result = validateWorkflow(workflow, registry);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'DUPLICATE_NODE_NAME')).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'NODE_TYPE_NOT_FOUND')).toBe(true);
  });
});
