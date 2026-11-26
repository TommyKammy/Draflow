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
  it.each([0, 1, 2])('preserves the filtered source across %i NoOp nodes', async (count) => {
    const source = node('source', 'draflow.manualTrigger', 'Source', 0);
    const filter = node('filter', 'draflow.filter', 'Filter', 1, {
      conditions: { conditions: [{ left: '={{ $json.id }}', operator: 'equals', right: 'c' }] },
    });
    const passes = Array.from({ length: count }, (_, i) => node('p' + i, 'draflow.noOp', 'Pass ' + i, i + 2));
    const set = node('set', 'draflow.set', 'Set', count + 2, {
      assignments: [{ name: 'origin', value: '={{ $("Source").item.json.id }}' }],
    });
    const nodes = [source, filter, ...passes, set];
    const edges = nodes.slice(1).map((target, i) => connect(nodes[i]!.id, target.id));
    const result = await run(workflow(nodes, edges), seed({ id: 'a' }, { id: 'b' }, { id: 'c' }));
    expect(result.status).toBe('success');
    expect(result.runData.set?.[0]?.output?.main?.[0]?.map(item => item.json))
      .toEqual([{ id: 'c', origin: 'c' }]);
  });

  it.each(['filter', 'if'])('compares resolved null values in %s', async (type) => {
    const wf = workflow([
      node('s', 'draflow.manualTrigger', 'Source', 0),
      node('n', 'draflow.' + type, 'Compare', 1, {
        conditions: { conditions: [{ left: '={{ $json.value }}', operator: 'equals', right: '={{ null }}' }] },
      }),
    ], [connect('s', 'n')]);
    const result = await run(wf, seed({ value: null }, { value: '' }));
    expect(result.status).toBe('success');
    expect(result.runData.n?.[0]?.output?.main?.[0]?.map(item => item.json)).toEqual([{ value: null }]);
  });

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

  it('does not mutate upstream nested data when editing fields', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('s', 'draflow.set', 'Set', 200, {
          mode: 'manual',
          includeOtherFields: true,
          assignments: [{ name: 'nested.x', value: 2, type: 'number' }],
        }),
      ],
      [connect('m', 's')],
    );

    const result = await run(wf, seed({ nested: { x: 1 } }));
    expect(result.status).toBe('success');
    expect(result.runData.m?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({ nested: { x: 1 } });
    expect(result.runData.s?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({ nested: { x: 2 } });
  });

  it('does not resolve assignment values twice', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('s', 'draflow.set', 'Set', 200, {
          mode: 'manual',
          includeOtherFields: false,
          assignments: [{ name: 'copied', value: '={{ $json.text }}' }],
        }),
      ],
      [connect('m', 's')],
    );

    const result = await run(wf, seed({ text: '={{ 1 + 2 }}' }));
    expect(result.status).toBe('success');
    expect(result.runData.s?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({
      copied: '={{ 1 + 2 }}',
    });
  });

  it('serializes date expression results as ISO strings', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('s', 'draflow.set', 'Set', 200, {
          mode: 'manual',
          includeOtherFields: false,
          assignments: [{ name: 'when', value: '={{ $now }}' }],
        }),
      ],
      [connect('m', 's')],
    );

    const result = await run(wf, seed({}));
    const when = result.runData.s?.[0]?.output?.main?.[0]?.[0]?.json.when;
    expect(typeof when).toBe('string');
    expect(when).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves binary references when editing fields', async () => {
    const binary = {
      file: { mimeType: 'text/plain', fileName: 'a.txt', id: 'bin-1' },
    };
    const options = { triggerData: { main: [[{ json: { x: 1 }, binary }]] } };

    const manual = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('s', 'draflow.set', 'Set', 200, {
          mode: 'manual',
          includeOtherFields: true,
          assignments: [],
        }),
      ],
      [connect('m', 's')],
    );
    const manualResult = await run(manual, options);
    expect(manualResult.runData.s?.[0]?.output?.main?.[0]?.[0]?.binary).toEqual(binary);

    const json = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('s', 'draflow.set', 'Set', 200, {
          mode: 'json',
          jsonOutput: '{"y":2}',
        }),
      ],
      [connect('m', 's')],
    );
    const jsonResult = await run(json, options);
    expect(jsonResult.runData.s?.[0]?.output?.main?.[0]?.[0]?.binary).toEqual(binary);
  });

  it('parses boolean strings under loose filter validation', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('f', 'draflow.filter', 'Filter', 200, {
          looseTypeValidation: true,
          conditions: {
            combinator: 'and',
            conditions: [
              { left: '={{ $json.flag }}', operator: 'equals', right: '={{ true }}' },
            ],
          },
        }),
      ],
      [connect('m', 'f')],
    );

    const result = await run(
      wf,
      seed({ flag: 'true' }, { flag: 'false' }, { flag: '1' }, { flag: '0' }),
    );
    const output = result.runData.f?.[0]?.output?.main?.[0] ?? [];
    expect(output.map((entry) => entry.json.flag)).toEqual(['true', '1']);
  });

  it('rejects prototype-related assignment paths', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('s', 'draflow.set', 'Set', 200, {
          mode: 'manual',
          assignments: [{ name: '__proto__.polluted', value: 'yes' }],
        }),
      ],
      [connect('m', 's')],
    );

    const result = await run(wf, seed({}));
    expect(result.status).toBe('error');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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

  it('resolves $("Node").item through filter lineage', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('f', 'draflow.filter', 'Filter', 200, {
          conditions: {
            combinator: 'and',
            conditions: [{ left: '={{ $json.id }}', operator: 'gte', right: '1' }],
          },
        }),
        node('s', 'draflow.set', 'Set', 400, {
          mode: 'manual',
          includeOtherFields: true,
          assignments: [
            { name: 'filtered', value: '={{ $("Filter").item.json.id }}' },
            { name: 'fromManual', value: '={{ $("Manual").item.json.id }}' },
          ],
        }),
      ],
      [connect('m', 'f'), connect('f', 's')],
    );

    const result = await run(wf, seed({ id: 0 }, { id: 1 }, { id: 2 }));
    expect(result.status).toBe('success');
    const items = result.runData.s?.[0]?.output?.main?.[0] ?? [];
    expect(items.map((entry) => entry.json)).toEqual([
      { id: 1, filtered: 1, fromManual: 1 },
      { id: 2, filtered: 2, fromManual: 2 },
    ]);
  });

  it('preserves binary references through Filter and If', async () => {
    const binary = {
      file: { mimeType: 'text/plain', fileName: 'a.txt', id: 'bin-1' },
    };
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('f', 'draflow.filter', 'Filter', 200, {
          conditions: { combinator: 'and', conditions: [] },
        }),
        node('i', 'draflow.if', 'If', 400, {
          conditions: {
            combinator: 'and',
            conditions: [{ left: '={{ String($json.id) }}', operator: 'equals', right: '1' }],
          },
        }),
      ],
      [connect('m', 'f'), connect('f', 'i')],
    );

    const result = await run(wf, {
      triggerData: { main: [[{ json: { id: 1 }, binary }]] },
    });
    expect(result.status).toBe('success');
    expect(result.runData.f?.[0]?.output?.main?.[0]?.[0]?.binary).toEqual(binary);
    expect(result.runData.i?.[0]?.output?.main?.[0]?.[0]?.binary).toEqual(binary);
  });

  it('runs a merge when one input branch is empty', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('n', 'draflow.noOp', 'Noop', 200),
        node('f', 'draflow.filter', 'Filter', 200, {
          conditions: {
            combinator: 'and',
            conditions: [{ left: '={{ $json.id }}', operator: 'gt', right: '5' }],
          },
        }),
        node('merge', 'draflow.merge', 'Merge', 400, { mode: 'append' }),
      ],
      [
        connect('m', 'n'),
        connect('m', 'f'),
        connect('n', 'merge', 'main', 0, 0),
        connect('f', 'merge', 'main', 0, 1),
      ],
    );

    const result = await run(wf, seed({ id: 1 }));
    expect(result.status).toBe('success');
    expect(result.runData.merge?.[0]?.output?.main?.[0]).toHaveLength(1);
  });

  it('tracks lineage through multiple nodes after a filter', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('f', 'draflow.filter', 'Filter', 200, {
          conditions: {
            combinator: 'and',
            conditions: [{ left: '={{ $json.id }}', operator: 'equals', right: 'c' }],
          },
        }),
        node('s1', 'draflow.set', 'Set1', 400, {
          mode: 'manual',
          includeOtherFields: true,
          assignments: [],
        }),
        node('s2', 'draflow.set', 'Set2', 600, {
          mode: 'manual',
          includeOtherFields: true,
          assignments: [
            { name: 'sourceId', value: '={{ $("Manual").item.json.id }}' },
          ],
        }),
      ],
      [connect('m', 'f'), connect('f', 's1'), connect('s1', 's2')],
    );

    const result = await run(wf, seed({ id: 'a' }, { id: 'b' }, { id: 'c' }));
    expect(result.status).toBe('success');
    expect(result.runData.s2?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({
      id: 'c',
      sourceId: 'c',
    });
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

  it('tracks lineage through an append merge', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('left', 'draflow.filter', 'Left', 200, {
          conditions: {
            combinator: 'and',
            conditions: [{ left: '={{ $json.id }}', operator: 'equals', right: 'a' }],
          },
        }),
        node('right', 'draflow.filter', 'Right', 200, {
          conditions: {
            combinator: 'and',
            conditions: [{ left: '={{ $json.id }}', operator: 'equals', right: 'b' }],
          },
        }),
        node('merge', 'draflow.merge', 'Merge', 400, { mode: 'append' }),
        node('s', 'draflow.set', 'Set', 600, {
          mode: 'manual',
          includeOtherFields: true,
          assignments: [
            { name: 'sourceId', value: '={{ $("Manual").item.json.id }}' },
          ],
        }),
      ],
      [
        connect('m', 'left'),
        connect('m', 'right'),
        connect('left', 'merge', 'main', 0, 0),
        connect('right', 'merge', 'main', 0, 1),
        connect('merge', 's'),
      ],
    );

    const result = await run(wf, seed({ id: 'a' }, { id: 'b' }));
    expect(result.status).toBe('success');
    const items = result.runData.s?.[0]?.output?.main?.[0] ?? [];
    expect(items.map((entry) => entry.json)).toEqual([
      { id: 'a', sourceId: 'a' },
      { id: 'b', sourceId: 'b' },
    ]);
  });

  it('preserves binary references in merge-by-key outputs', async () => {
    const binary = {
      file: { mimeType: 'text/plain', fileName: 'a.txt', id: 'bin-1' },
    };
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('left', 'draflow.filter', 'Left', 200, {
          conditions: {
            combinator: 'and',
            conditions: [
              { left: '={{ String($json.id) }}', operator: 'lte', right: '2' },
            ],
          },
        }),
        node('right', 'draflow.filter', 'Right', 200, {
          conditions: {
            combinator: 'and',
            conditions: [
              { left: '={{ String($json.id) }}', operator: 'gte', right: '2' },
            ],
          },
        }),
        node('merge', 'draflow.merge', 'Merge', 400, {
          mode: 'mergeByKey',
          key: 'id',
          joinMode: 'outer',
        }),
      ],
      [
        connect('m', 'left'),
        connect('m', 'right'),
        connect('left', 'merge', 'main', 0, 0),
        connect('right', 'merge', 'main', 0, 1),
      ],
    );

    const result = await run(wf, {
      triggerData: {
        main: [[
          { json: { id: 1 }, binary },
          { json: { id: 2 }, binary },
          { json: { id: 3 }, binary },
        ]],
      },
    });
    expect(result.status).toBe('success');
    const output = result.runData.merge?.[0]?.output?.main?.[0] ?? [];
    expect(output).toHaveLength(3);
    expect(output.map((entry) => entry.binary)).toEqual([binary, binary, binary]);
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

  it('handles successful bodyless responses', async () => {
    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('h', 'draflow.httpRequest', 'HTTP', 200, {
          method: 'HEAD',
          url: 'https://example.com/empty',
        }),
      ],
      [connect('m', 'h')],
    );

    const noContent = await run(
      wf,
      seed({}),
      async () =>
        new Response(null, {
          status: 204,
          statusText: 'No Content',
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(noContent.status).toBe('success');
    expect(noContent.runData.h?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({});

    const emptyOk = await run(
      wf,
      seed({}),
      async () =>
        new Response('', {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(emptyOk.status).toBe('success');
    expect(emptyOk.runData.h?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({});
  });

  it('checks Content-Type headers case-insensitively', async () => {
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = async (_input: string, init?: RequestInit): Promise<Response> => {
      sentHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('h', 'draflow.httpRequest', 'HTTP', 200, {
          method: 'POST',
          url: 'https://example.com/data',
          headers: { 'CONTENT-TYPE': 'application/vnd.api+json' },
          body: { hello: 'world' },
        }),
      ],
      [connect('m', 'h')],
    );

    const result = await run(wf, seed({}), fetchImpl);
    expect(result.status).toBe('success');
    expect(sentHeaders['CONTENT-TYPE']).toBe('application/vnd.api+json');
    expect(sentHeaders['content-type']).toBeUndefined();
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

  it('keeps the HTTP timeout active while reading the body', async () => {
    const fetchImpl = async (): Promise<Response> =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => new Promise<never>(() => {}),
        text: () => new Promise<never>(() => {}),
      }) as unknown as Response;

    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        node('h', 'draflow.httpRequest', 'HTTP', 200, {
          url: 'https://example.com/stall',
          timeout: 10,
        }),
      ],
      [connect('m', 'h')],
    );

    const result = await run(wf, seed({}), fetchImpl);
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/timed out/);
  });

  it('routes HTTP errors to a dynamically declared error output', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('nope', { status: 500, statusText: 'Server Error' });

    const httpNode = node('h', 'draflow.httpRequest', 'HTTP', 200, {
      url: 'https://example.com/fail',
    });
    httpNode.settings = { onError: 'errorOutput' };

    const wf = workflow(
      [
        node('m', 'draflow.manualTrigger', 'Manual', 0),
        httpNode,
        node('handler', 'draflow.set', 'Handler', 400, {
          mode: 'manual',
          includeOtherFields: true,
          assignments: [],
        }),
      ],
      [connect('m', 'h'), connect('h', 'handler', 'error', 0)],
    );

    const result = await run(wf, seed({}), fetchImpl);
    expect(result.status).toBe('success');
    expect(result.runData.handler?.[0]?.output?.main?.[0]?.[0]?.json.error).toMatch(/HTTP 500/);
  });
});
