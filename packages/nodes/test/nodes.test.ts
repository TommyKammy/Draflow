import { describe, expect, it } from 'vitest';
import {
  ExecutionEngine,
  NodeRegistry,
  createConnection,
  createNode,
  createWorkflow,
  type Connection,
  type NodeType,
  type Workflow,
  type WorkflowNode,
} from '@draflow/core';
import { standardNodes } from '../src/index.js';

const registry = new NodeRegistry().registerAll(standardNodes);

function node(
  id: string,
  type: string,
  name: string,
  x: number,
  parameters: Record<string, unknown> = {},
): WorkflowNode {
  return createNode({
    id,
    type,
    name,
    position: { x, y: 0 },
    parameters: parameters as WorkflowNode['parameters'],
  });
}

function connect(
  from: string,
  to: string,
  fromPort = 'main',
  fromIndex = 0,
  toIndex = 0,
): Connection {
  return createConnection(
    { node: from, port: fromPort, index: fromIndex },
    { node: to, port: 'main', index: toIndex },
  );
}

function workflow(nodes: WorkflowNode[], connections: Connection[]): Workflow {
  return createWorkflow({ nodes, connections });
}

function seed(...items: unknown[]) {
  return {
    triggerData: {
      main: [items.map((json) => ({ json: json as Record<string, never> }))],
    },
  };
}

async function run(
  wf: Workflow,
  options: Parameters<ExecutionEngine['run']>[1] = {},
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>,
) {
  const engine = new ExecutionEngine({
    registry,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  return engine.run(wf, options).done;
}

describe('standard nodes', () => {
  it('edits fields with expressions', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('s', 'draflow.set', 'Set', 200, {
          mode: 'manual',
          includeOtherFields: false,
          assignments: [
            { name: 'sum', value: '={{ $json.a + $json.b }}', type: 'auto' },
            { name: 'nested.label', value: 'hello', type: 'string' },
          ],
        }),
      ],
      [connect('m', 's')],
    );

    const result = await run(wf, seed({ a: 1, b: 2 }));
    expect(result.status).toBe('success');
    expect(result.runData.s?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({
      sum: 3,
      nested: { label: 'hello' },
    });
  });

  it('edits fields from JSON mode', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('s', 'draflow.set', 'Set', 200, {
          mode: 'json',
          jsonOutput: '{"x":1,"ok":true}',
        }),
      ],
      [connect('m', 's')],
    );

    const result = await run(wf, seed({ ignored: true }));
    expect(result.runData.s?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({ x: 1, ok: true });
  });

  it('routes items through If branches', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('if', 'draflow.if', 'If', 200, {
          conditions: {
            combinator: 'and',
            conditions: [{ left: '={{ $json.status }}', operator: 'equals', right: 'ok' }],
          },
        }),
        node('yes', 'draflow.set', 'Yes', 400, {
          mode: 'manual',
          includeOtherFields: false,
          assignments: [{ name: 'branch', value: 'yes' }],
        }),
        node('no', 'draflow.set', 'No', 400, {
          mode: 'manual',
          includeOtherFields: false,
          assignments: [{ name: 'branch', value: 'no' }],
        }),
      ],
      [
        connect('m', 'if'),
        connect('if', 'yes', 'main', 0),
        connect('if', 'no', 'main', 1),
      ],
    );

    const result = await run(wf, seed({ status: 'ok' }, { status: 'bad' }));
    expect(result.status).toBe('success');
    expect(result.runData.yes?.[0]?.output?.main?.[0]).toHaveLength(1);
    expect(result.runData.yes?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({ branch: 'yes' });
    expect(result.runData.no?.[0]?.output?.main?.[0]).toHaveLength(1);
    expect(result.runData.no?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({ branch: 'no' });
  });

  it('filters items', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('f', 'draflow.filter', 'Filter', 200, {
          conditions: {
            combinator: 'and',
            conditions: [{ left: '={{ $json.n }}', operator: 'gt', right: '1' }],
          },
        }),
      ],
      [connect('m', 'f')],
    );

    const result = await run(wf, seed({ n: 1 }, { n: 2 }, { n: 3 }));
    expect(result.runData.f?.[0]?.output?.main?.[0]).toHaveLength(2);
  });

  it('merges two branches by key', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('a', 'draflow.set', 'A', 200, {
          mode: 'manual',
          includeOtherFields: true,
          assignments: [{ name: 'group', value: 'a' }],
        }),
        node('b', 'draflow.set', 'B', 200, {
          mode: 'manual',
          includeOtherFields: true,
          assignments: [{ name: 'group', value: 'b' }],
        }),
        node('merge', 'draflow.merge', 'Merge', 400, {
          mode: 'mergeByKey',
          key: 'id',
          joinMode: 'outer',
        }),
      ],
      [
        connect('m', 'a'),
        connect('m', 'b'),
        connect('a', 'merge', 'main', 0, 0),
        connect('b', 'merge', 'main', 0, 1),
      ],
    );

    const result = await run(wf, seed({ id: 1 }, { id: 2 }));
    expect(result.status).toBe('success');
    const output = result.runData.merge?.[0]?.output?.main?.[0] ?? [];
    expect(output).toHaveLength(2);
    expect(output[0]?.json).toEqual({ id: 1, group: 'b' });
    expect(output[1]?.json).toEqual({ id: 2, group: 'b' });
  });

  it('calls HTTP endpoints and parses JSON', async () => {
    let requested = '';
    let method = '';
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      requested = input;
      method = String(init?.method ?? 'GET');
      return new Response(JSON.stringify({ ok: true, items: [1, 2] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('h', 'draflow.httpRequest', 'HTTP', 200, {
          method: 'GET',
          url: 'https://example.com/data',
        }),
      ],
      [connect('m', 'h')],
    );

    const result = await run(wf, seed({}), fetchImpl);
    expect(result.status).toBe('success');
    expect(requested).toBe('https://example.com/data');
    expect(method).toBe('GET');
    expect(result.runData.h?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({
      ok: true,
      items: [1, 2],
    });
  });

  it('reports HTTP failures as node errors', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('nope', { status: 500, statusText: 'Server Error' });

    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('h', 'draflow.httpRequest', 'HTTP', 200, {
          url: 'https://example.com/fail',
        }),
      ],
      [connect('m', 'h')],
    );

    const result = await run(wf, seed({}), fetchImpl);
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/HTTP 500/);
  });
});
