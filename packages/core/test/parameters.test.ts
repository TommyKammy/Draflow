import { describe, expect, it } from 'vitest';
import {
  applyParameterDefaults,
  evaluateDisplayOptions,
  getVisibleParameters,
  unwrapParameterValue,
} from '../src/parameters.js';
import type { NodeType } from '../src/node.js';
import { createNode } from '../src/serialize.js';

const nodeType: NodeType = {
  type: 'test.node',
  version: 1,
  meta: { label: 'Test', category: 'core' },
  ports: { inputs: [{ type: 'main' }], outputs: [{ type: 'main' }] },
  parameters: [
    {
      name: 'resource',
      label: 'Resource',
      type: 'select',
      default: 'contact',
      options: [
        { label: 'Contact', value: 'contact' },
        { label: 'Company', value: 'company' },
      ],
    },
    {
      name: 'contactId',
      label: 'Contact ID',
      type: 'string',
      default: '',
      displayOptions: { show: { resource: ['contact'] } },
    },
    {
      name: 'companyId',
      label: 'Company ID',
      type: 'string',
      default: '',
      displayOptions: { show: { resource: ['company'] } },
    },
    {
      name: 'limit',
      label: 'Limit',
      type: 'number',
      default: 10,
      displayOptions: { show: { limit: [{ _cnd: { gte: 5 } }] } },
    },
    {
      name: 'options',
      label: 'Options',
      type: 'collection',
      default: {},
      fields: [
        { name: 'timeout', label: 'Timeout', type: 'number', default: 1000 },
        { name: 'retries', label: 'Retries', type: 'number', default: 2 },
      ],
    },
  ],
};

describe('parameters', () => {
  it('resolves display options', () => {
    const contact = createNode({
      type: nodeType.type,
      name: 'Node',
      parameters: { resource: 'contact' },
    });
    const company = createNode({
      type: nodeType.type,
      name: 'Node',
      parameters: { resource: 'company' },
    });

    expect(getVisibleParameters(nodeType, contact).map((parameter) => parameter.name)).toContain(
      'contactId',
    );
    expect(getVisibleParameters(nodeType, contact).map((parameter) => parameter.name)).not.toContain(
      'companyId',
    );
    expect(getVisibleParameters(nodeType, company).map((parameter) => parameter.name)).toContain(
      'companyId',
    );
  });

  it('supports _cnd conditions', () => {
    const node = createNode({
      type: nodeType.type,
      name: 'Node',
      parameters: { resource: 'contact', limit: 10 },
    });
    expect(
      evaluateDisplayOptions(
        { show: { limit: [{ _cnd: { gte: 5 } }] } },
        node,
        nodeType,
      ),
    ).toBe(true);
    node.parameters.limit = 3;
    expect(
      evaluateDisplayOptions(
        { show: { limit: [{ _cnd: { gte: 5 } }] } },
        node,
        nodeType,
      ),
    ).toBe(false);
  });

  it('supports shorthand operator conditions', () => {
    const node = createNode({
      type: nodeType.type,
      name: 'Node',
      parameters: { resource: 'contact', limit: 10 },
    });
    expect(
      evaluateDisplayOptions({ show: { limit: [{ gte: 5 }] } }, node, nodeType),
    ).toBe(true);
    expect(
      evaluateDisplayOptions({ hide: { limit: [{ gte: 5 }] } }, node, nodeType),
    ).toBe(false);

    node.parameters.limit = 3;
    expect(
      evaluateDisplayOptions({ show: { limit: [{ gte: 5 }] } }, node, nodeType),
    ).toBe(false);
    expect(
      evaluateDisplayOptions({ hide: { limit: [{ gte: 5 }] } }, node, nodeType),
    ).toBe(true);
  });

  it('applies nested defaults', () => {
    const values = applyParameterDefaults(nodeType, {});
    expect(values.resource).toBe('contact');
    expect(values.limit).toBe(10);
    expect(values.options).toEqual({ timeout: 1000, retries: 2 });
  });

  it('unwraps resource locator values', () => {
    expect(unwrapParameterValue({ __rl: true, mode: 'id', value: 'abc' })).toBe('abc');
    expect(unwrapParameterValue('plain')).toBe('plain');
  });
});
