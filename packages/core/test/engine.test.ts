import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/engine.js';
import type { NodeType } from '../src/node.js';
import { NodeRegistry } from '../src/registry.js';
import { createConnection, createNode, createWorkflow } from '../src/serialize.js';
import type { Item, RunData, Workflow, WorkflowNode } from '../src/types.js';

const triggerType: NodeType = {
  type: 'test.trigger',
  version: 1,
  meta: { label: 'Trigger', category: 'trigger' },
  ports: { inputs: [], outputs: [{ type: 'main' }] },
  parameters: [],
  execute() {
    return [{ json: { started: true } }];
  },
};

const echoType: NodeType = {
  type: 'test.echo',
  version: 1,
  meta: { label: 'Echo', category: 'core' },
  ports: { inputs: [{ type: 'main', required: true }], outputs: [{ type: 'main' }] },
  parameters: [{ name: 'suffix', label: 'Suffix', type: 'string', default: 'ok' }],
  execute(ctx) {
    return ctx.items.map((item, index) => ({
      json: { ...item.json, suffix: ctx.param<string>('suffix', index, 'ok') },
      pairedItem: item.pairedItem ?? { item: index },
    }));
  },
};

const branchType: NodeType = {
  type: 'test.branch',
  version: 1,
  meta: { label: 'Branch', category: 'flow' },
  ports: {
    inputs: [{ type: 'main', required: true }],
    outputs: [{ type: 'main', label: 'True' }, { type: 'main', label: 'False' }],
  },
  parameters: [],
  execute(ctx) {
    const yes: Item[] = [];
    const no: Item[] = [];
    ctx.items.forEach((item, index) => {
      const target = item.json.started === true ? yes : no;
      target.push({ json: { ...item.json }, pairedItem: item.pairedItem ?? { item: index } });
    });
    return { main: [yes, no] };
  },
};

const mergeType: NodeType = {
  type: 'test.merge',
  version: 1,
  meta: { label: 'Merge', category: 'flow' },
  ports: {
    inputs: [
      { type: 'main', required: true },
      { type: 'main', required: true },
    ],
    outputs: [{ type: 'main' }],
  },
  parameters: [],
  execute(ctx) {
    return [...ctx.input('main', 0), ...ctx.input('main', 1)];
  },
};

const registry = new NodeRegistry().registerAll([triggerType, echoType, branchType, mergeType]);

function node(
  id: string,
  type: string,
  name: string,
  x: number,
  settings?: WorkflowNode['settings'],
): WorkflowNode {
  return createNode({
    id,
    type,
    name,
    position: { x, y: 0 },
    ...(settings === undefined ? {} : { settings }),
  });
}

function connect(from: string, to: string, fromPort = 'main', fromIndex = 0, toIndex = 0) {
  return createConnection(
    { node: from, port: fromPort, index: fromIndex },
    { node: to, port: 'main', index: toIndex },
  );
}

function workflow(
  nodes: WorkflowNode[],
  connections: ReturnType<typeof connect>[],
): Workflow {
  return createWorkflow({ nodes, connections });
}

async function execute(
  wf: Workflow,
  options: Parameters<ExecutionEngine['run']>[1] = {},
  engine = new ExecutionEngine({ registry }),
) {
  return engine.run(wf, options).done;
}

describe('ExecutionEngine', () => {
  it.each([
    { partial: false, feedback: false },
    { partial: true, feedback: false },
    { partial: true, feedback: true },
  ])('collects nested fan-in (partial: $partial, feedback edge: $feedback)', async ({ partial, feedback }) => {
    const steps = ['a', 'b', 'join', 'bridge', 'end'].map((id, i) => {
      const step = node(id, echoType.type, id, i + 2);
      step.parameters.suffix = id === 'a' || id === 'b' ? id : '={{ $json.suffix }}';
      return step;
    });
    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('gate', branchType.type, 'Gate', 1), ...steps],
      [
        connect('t', 'gate'),
        ...(feedback ? [connect('gate', 'gate', 'main', 1)] : []),
        connect('gate', 'end'), connect('gate', 'a'), connect('gate', 'b'),
        connect('a', 'join'), connect('b', 'join'), connect('join', 'bridge'), connect('bridge', 'end'),
      ],
    );
    const result = await execute(wf, partial ? { destinationNodeId: 'end' } : {});
    expect(result.status).toBe('success');
    expect(result.runData.end).toHaveLength(1);
    const items = result.runData.end?.[0]?.output?.main?.[0];
    expect(items?.map(item => item.json.suffix)).toEqual([undefined, 'a', 'b']);
  });

  it.each(['fresh', 'pinned', 'cached'])('rejects oversized %s terminal output', async mode => {
    const items = [1, 2, 3].map(id => ({ json: { id } }));
    const source = { ...triggerType, execute: () => items };
    const engine = new ExecutionEngine({ registry: new NodeRegistry().registerAll([source]) });
    const wf = workflow([node('s', source.type, 'Source', 0)], []);
    const previous = await engine.run(wf).done;
    wf.settings.maxItemsPerNode = 2;
    const options = {
      ...(mode === 'cached' ? { runData: previous.runData } : {}),
      ...(mode === 'pinned' ? { pinData: { s: items } } : {}),
    };
    const handle = engine.run(wf, options);
    const events: string[] = [];
    handle.on('node:start', () => events.push('start'));
    handle.on('node:finish', ({ task }) => events.push(task.status));
    const result = await handle.done;
    expect(events).toEqual(mode === 'cached' ? [] : ['start', 'error']);
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/limit of 2/);
    expect(result.runData.s?.[0]?.output).toBeUndefined();
    expect(previous.runData.s?.[0]?.output?.main?.[0]).toHaveLength(3);
  });

  it('runs a linear workflow and records run data', async () => {
    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('a', echoType.type, 'A', 200), node('b', echoType.type, 'B', 400)],
      [connect('t', 'a'), connect('a', 'b')],
    );

    const result = await execute(wf);
    expect(result.status).toBe('success');
    expect(Object.keys(result.runData)).toEqual(['t', 'a', 'b']);
    expect(result.runData.a?.[0]?.status).toBe('success');
    expect(result.runData.b?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({
      started: true,
      suffix: 'ok',
    });
  });

  it('routes branch outputs independently', async () => {
    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('branch', branchType.type, 'Branch', 200),
        node('yes', echoType.type, 'Yes', 400),
        node('no', echoType.type, 'No', 400),
      ],
      [connect('t', 'branch'), connect('branch', 'yes', 'main', 0), connect('branch', 'no', 'main', 1)],
    );

    const result = await execute(wf);
    expect(result.status).toBe('success');
    expect(result.runData.yes?.[0]?.output?.main?.[0]).toHaveLength(1);
    expect(result.runData.no).toBeUndefined();
  });

  it('waits for both merge inputs', async () => {
    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('a', echoType.type, 'A', 200),
        node('b', echoType.type, 'B', 200),
        node('m', mergeType.type, 'Merge', 400),
      ],
      [
        connect('t', 'a'),
        connect('t', 'b'),
        connect('a', 'm', 'main', 0, 0),
        connect('b', 'm', 'main', 0, 1),
      ],
    );

    const result = await execute(wf);
    expect(result.status).toBe('success');
    const mergeTask = result.runData.m?.[0];
    expect(mergeTask).toBeDefined();
    expect(mergeTask?.input?.main?.[0]).toHaveLength(1);
    expect(mergeTask?.input?.main?.[1]).toHaveLength(1);
    expect(mergeTask?.output?.main?.[0]).toHaveLength(2);
  });

  it('stops on error by default', async () => {
    const failing: NodeType = {
      ...echoType,
      type: 'test.fail',
      execute() {
        throw new Error('boom');
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, echoType, failing]);

    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('f', failing.type, 'Fail', 200, { onError: 'stop' }),
        node('after', echoType.type, 'After', 400),
      ],
      [connect('t', 'f'), connect('f', 'after')],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('error');
    expect(result.runData.f?.[0]?.status).toBe('error');
    expect(result.runData.after).toBeUndefined();
    expect(result.error?.message).toBe('boom');
  });

  it('continues on error and passes input through', async () => {
    const failing: NodeType = {
      ...echoType,
      type: 'test.fail',
      execute() {
        throw new Error('boom');
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, echoType, failing]);

    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('f', failing.type, 'Fail', 200, { onError: 'continue' }),
        node('after', echoType.type, 'After', 400),
      ],
      [connect('t', 'f'), connect('f', 'after')],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('success');
    expect(result.runData.f?.[0]?.status).toBe('error');
    expect(result.runData.after?.[0]?.output?.main?.[0]?.[0]?.json.started).toBe(true);
  });

  it('routes errors to the error output', async () => {
    const failing: NodeType = {
      ...echoType,
      type: 'test.fail',
      ports: {
        inputs: [{ type: 'main', required: true }],
        outputs: [{ type: 'main' }, { type: 'error' }],
      },
      execute() {
        throw new Error('boom');
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, echoType, failing]);

    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('f', failing.type, 'Fail', 200, { onError: 'errorOutput' }),
        node('handler', echoType.type, 'Handler', 400),
      ],
      [connect('t', 'f'), connect('f', 'handler', 'error', 0)],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('success');
    expect(result.runData.handler?.[0]?.output?.main?.[0]?.[0]?.json.error).toBe('boom');
  });

  it('retries failed nodes', async () => {
    let attempts = 0;
    const retrying: NodeType = {
      ...echoType,
      type: 'test.retry',
      execute(ctx) {
        attempts += 1;
        if (attempts < 3) throw new Error('not yet');
        return [...ctx.items];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, echoType, retrying]);

    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('r', retrying.type, 'Retry', 200, {
          retryOnFail: true,
          maxTries: 3,
          waitBetweenTries: 0,
        }),
        node('after', echoType.type, 'After', 400),
      ],
      [connect('t', 'r'), connect('r', 'after')],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('success');
    expect(attempts).toBe(3);
    expect(result.runData.after).toBeDefined();
  });

  it('uses pinned data without executing the node', async () => {
    let calls = 0;
    const counted: NodeType = {
      ...echoType,
      type: 'test.count',
      execute(ctx) {
        calls += 1;
        return [...ctx.items];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, counted]);

    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('c', counted.type, 'Count', 200)],
      [connect('t', 'c')],
    );

    const result = await execute(
      wf,
      { pinData: { c: [{ json: { pinned: true } }] } },
      new ExecutionEngine({ registry: local }),
    );
    expect(result.status).toBe('success');
    expect(calls).toBe(0);
    expect(result.runData.c?.[0]?.output?.main?.[0]?.[0]?.json).toEqual({ pinned: true });
  });

  it('honors an explicitly empty pin without executing the node', async () => {
    let calls = 0;
    const counted: NodeType = {
      ...echoType,
      type: 'test.count',
      execute(ctx) {
        calls += 1;
        return [...ctx.items];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, counted]);

    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('c', counted.type, 'Count', 200)],
      [connect('t', 'c')],
    );

    const result = await execute(
      wf,
      { pinData: { c: [] } },
      new ExecutionEngine({ registry: local }),
    );
    expect(result.status).toBe('success');
    expect(calls).toBe(0);
    expect(result.runData.c?.[0]?.output?.main?.[0]).toHaveLength(0);
  });

  it('passes data through disabled nodes', async () => {
    let calls = 0;
    const counted: NodeType = {
      ...echoType,
      type: 'test.count',
      execute(ctx) {
        calls += 1;
        return [...ctx.items];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, counted]);
    const disabled = node('c', counted.type, 'Count', 200);
    disabled.disabled = true;

    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), disabled],
      [connect('t', 'c')],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('success');
    expect(calls).toBe(0);
    expect(result.runData.c?.[0]?.output?.main?.[0]?.[0]?.json.started).toBe(true);
  });

  it('runs up to a destination node', async () => {
    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('a', echoType.type, 'A', 200),
        node('b', echoType.type, 'B', 400),
        node('c', echoType.type, 'C', 600),
      ],
      [connect('t', 'a'), connect('a', 'b'), connect('b', 'c')],
    );

    const inclusive = await execute(wf, { destinationNodeId: 'b', destinationMode: 'inclusive' });
    expect(Object.keys(inclusive.runData)).toEqual(['t', 'a', 'b']);
    expect(inclusive.runData.c).toBeUndefined();

    const exclusive = await execute(wf, { destinationNodeId: 'b', destinationMode: 'exclusive' });
    expect(Object.keys(exclusive.runData)).toEqual(['t', 'a']);
    expect(exclusive.runData.b).toBeUndefined();
  });

  it('reuses unchanged upstream run data', async () => {
    let aCalls = 0;
    const counted: NodeType = {
      ...echoType,
      type: 'test.count',
      execute(ctx) {
        aCalls += 1;
        return [...ctx.items];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, counted]);
    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('a', counted.type, 'A', 200),
        node('b', counted.type, 'B', 400),
      ],
      [connect('t', 'a'), connect('a', 'b')],
    );

    const engine = new ExecutionEngine({ registry: local });
    const first = await engine.run(wf).done;
    expect(aCalls).toBe(2);

    const second = await engine
      .run(wf, { runData: first.runData, dirtyNodeIds: ['b'] })
      .done;
    expect(second.status).toBe('success');
    expect(aCalls).toBe(3);
    expect(Object.keys(second.runData)).toEqual(['t', 'a', 'b']);
  });

  it('emits node:start for each actual execution', async () => {
    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('a', echoType.type, 'A', 200),
        node('b', echoType.type, 'B', 400),
      ],
      [connect('t', 'a'), connect('a', 'b')],
    );

    const handle = new ExecutionEngine({ registry }).run(wf);
    const starts: string[] = [];
    handle.on('node:start', (event) => starts.push(event.nodeName));
    const result = await handle.done;

    expect(result.status).toBe('success');
    expect(starts).toEqual(['Trigger', 'A', 'B']);
  });

  it('aborts a never-settling node at the execution deadline', async () => {
    let aborted = false;
    const hanging: NodeType = {
      ...echoType,
      type: 'test.hanging',
      execute(ctx) {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        }, { once: true });
        return new Promise<never>(() => {});
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, hanging]);
    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('h', hanging.type, 'Hang', 200)],
      [connect('t', 'h')],
    );

    const started = Date.now();
    const result = await new ExecutionEngine({
      registry: local,
      limits: { executionTimeout: 20 },
    })
      .run(wf)
      .done;

    expect(result.status).toBe('canceled');
    expect(result.error?.message).toMatch(/timed out/);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('removes external abort listeners when runs finish', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let added = 0;
    let removed = 0;

    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    const patched = signal as unknown as {
      addEventListener: typeof signal.addEventListener;
      removeEventListener: typeof signal.removeEventListener;
    };
    patched.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'abort') added += 1;
      originalAdd(type, listener, options);
    };
    patched.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'abort') removed += 1;
      originalRemove(type, listener, options);
    };

    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('a', echoType.type, 'A', 200)],
      [connect('t', 'a')],
    );
    const engine = new ExecutionEngine({ registry });

    for (let index = 0; index < 5; index += 1) {
      await engine.run(wf, { signal }).done;
      await Promise.resolve();
    }

    expect(added).toBe(5);
    expect(removed).toBe(5);
  });

  it('treats only each input definition as required', async () => {
    const optionalSecond: NodeType = {
      ...echoType,
      type: 'test.optionalSecond',
      ports: {
        inputs: [
          { type: 'main', required: true },
          { type: 'main', required: false },
        ],
        outputs: [{ type: 'main' }],
      },
      execute(ctx) {
        return [...ctx.input('main', 0)];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, optionalSecond]);
    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('n', optionalSecond.type, 'Optional', 200)],
      [connect('t', 'n')],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('success');
    expect(result.runData.n?.[0]).toBeDefined();
  });

  it('waits for all same-port fan-in branches before executing', async () => {
    const join: NodeType = {
      ...echoType,
      type: 'test.join',
      ports: {
        inputs: [{ type: 'main', required: true }],
        outputs: [{ type: 'main' }],
      },
      execute(ctx) {
        return [...ctx.items];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, echoType, join]);
    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('a', echoType.type, 'A', 200),
        node('b', echoType.type, 'B', 200),
        node('c', echoType.type, 'C', 400),
        node('join', join.type, 'Join', 600),
      ],
      [
        connect('t', 'a'),
        connect('t', 'b'),
        connect('a', 'join'),
        connect('b', 'c'),
        connect('c', 'join'),
      ],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('success');
    expect(result.runData.join).toHaveLength(1);
    expect(result.runData.join?.[0]?.output?.main?.[0]).toHaveLength(2);
  });

  it('advances run indices when replaying cached data', async () => {
    const loop: NodeType = {
      ...echoType,
      type: 'test.replayLoop',
      execute(ctx) {
        return ctx.runIndex >= 2 ? [] : [...ctx.items];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, loop]);
    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('loop', loop.type, 'Loop', 200)],
      [connect('t', 'loop'), connect('loop', 'loop')],
    );

    const engine = new ExecutionEngine({ registry: local });
    const first = await engine.run(wf).done;
    expect(first.status).toBe('success');
    expect(first.runData.loop).toHaveLength(3);

    const replay = await engine
      .run(wf, { runData: first.runData, dirtyNodeIds: ['loop'] })
      .done;

    expect(replay.status).toBe('success');
    expect(replay.runData.loop).toHaveLength(3);
  });

  it('removes stale tasks for dirty replay nodes', async () => {
    let stopAt = 2;
    const loop: NodeType = {
      ...echoType,
      type: 'test.replayStale',
      execute(ctx) {
        return ctx.runIndex >= stopAt ? [] : [...ctx.items];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, loop]);
    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('loop', loop.type, 'Loop', 200)],
      [connect('t', 'loop'), connect('loop', 'loop')],
    );

    const engine = new ExecutionEngine({ registry: local });
    const first = await engine.run(wf).done;
    expect(first.runData.loop).toHaveLength(3);

    stopAt = 1;
    const replay = await engine
      .run(wf, { runData: first.runData, dirtyNodeIds: ['loop'] })
      .done;

    expect(replay.status).toBe('success');
    expect(replay.runData.loop).toHaveLength(2);
  });

  it('treats a rejection with an undefined reason as a failure', async () => {
    const rejecting: NodeType = {
      ...echoType,
      type: 'test.rejectUndefined',
      execute() {
        return Promise.reject(undefined);
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, rejecting]);
    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('r', rejecting.type, 'Reject', 200)],
      [connect('t', 'r')],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('error');
    expect(result.runData.r?.[0]?.status).toBe('error');
    expect(result.error?.message).toBe('undefined');
  });

  it('preserves a populated second output when alwaysOutputData is set', async () => {
    const falseBranch: NodeType = {
      ...branchType,
      type: 'test.falseBranch',
      execute(ctx) {
        return {
          main: [
            [],
            ctx.items.map((item, index) => ({
              json: { ...item.json },
              pairedItem: item.pairedItem ?? { item: index },
            })),
          ],
        };
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, falseBranch, echoType]);
    const branch = node('branch', falseBranch.type, 'Branch', 200, {
      alwaysOutputData: true,
    });

    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        branch,
        node('false', echoType.type, 'False', 400),
      ],
      [connect('t', 'branch'), connect('branch', 'false', 'main', 1)],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('success');
    expect(result.runData.branch?.[0]?.output?.main?.[0]).toHaveLength(0);
    expect(result.runData.branch?.[0]?.output?.main?.[1]).toHaveLength(1);
    expect(result.runData.false?.[0]?.output?.main?.[0]).toHaveLength(1);
  });

  it('enforces the item limit on every input port', async () => {
    const local = new NodeRegistry().registerAll([mergeType]);
    const wf = workflow([node('m', mergeType.type, 'Merge', 0)], []);

    const result = await new ExecutionEngine({
      registry: local,
      limits: { maxItemsPerNode: 2 },
    })
      .run(wf, {
        startNodeId: 'm',
        triggerData: {
          main: [[{ json: { side: 'left' } }], [{ json: {} }, { json: {} }, { json: {} }]],
        },
      })
      .done;

    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/limit of 2/);
  });

  it('rejects unsafe node ids before execution', () => {
    const wf = workflow(
      [node('__proto__', triggerType.type, 'Unsafe', 0)],
      [],
    );

    expect(() => new ExecutionEngine({ registry }).run(wf)).toThrow(/Unsafe node id/);
    expect(({} as Record<string, unknown>)['0']).toBeUndefined();
    expect(([] as unknown[])[0]).toBeUndefined();
  });

  it('preserves per-item producer lineage across same-port fan-in', async () => {
    const seedType: NodeType = {
      ...triggerType,
      type: 'test.seedTwo',
      execute() {
        return [{ json: { id: 'a' } }, { json: { id: 'b' } }];
      },
    };
    const choose = (type: string, id: string): NodeType => ({
      ...echoType,
      type,
      execute(ctx) {
        const output: Item[] = [];
        ctx.items.forEach((item, index) => {
          if (item.json.id === id) {
            output.push({ ...item, pairedItem: { item: index, input: 0 } });
          }
        });
        return output;
      },
    });
    const joinType: NodeType = {
      ...echoType,
      type: 'test.lineageJoin',
      parameters: [{ name: 'sourceId', label: 'Source', type: 'string', default: '' }],
      execute(ctx) {
        return ctx.items.map((item, index) => ({
          json: { id: item.json.id ?? null, sourceId: ctx.param<string>('sourceId', index, '') },
          pairedItem: { item: index, input: 0 },
        }));
      },
    };
    const local = new NodeRegistry().registerAll([
      seedType,
      choose('test.chooseA', 'a'),
      choose('test.chooseB', 'b'),
      joinType,
    ]);

    const joinNode = node('join', joinType.type, 'Join', 400);
    joinNode.parameters = { sourceId: '={{ $("Seed").item.json.id }}' };

    const wf = workflow(
      [
        node('seed', seedType.type, 'Seed', 0),
        node('a', 'test.chooseA', 'A', 200),
        node('b', 'test.chooseB', 'B', 200),
        joinNode,
      ],
      [
        connect('seed', 'a'),
        connect('seed', 'b'),
        connect('a', 'join'),
        connect('b', 'join'),
      ],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry: local }));
    expect(result.status).toBe('success');
    const items = result.runData.join?.[0]?.output?.main?.[0] ?? [];
    expect(items.map((item) => item.json)).toEqual([
      { id: 'a', sourceId: 'a' },
      { id: 'b', sourceId: 'b' },
    ]);
  });

  it('defers a fan-in consumer while another producer is pending', async () => {
    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('a', echoType.type, 'A', 200),
        node('b', echoType.type, 'B', 200),
        node('x', echoType.type, 'X', 400),
        node('j', echoType.type, 'J', 600),
      ],
      [
        connect('t', 'a'),
        connect('t', 'b'),
        connect('a', 'x'),
        connect('b', 'x'),
        connect('a', 'j'),
        connect('x', 'j'),
      ],
    );

    const result = await execute(wf, {}, new ExecutionEngine({ registry }));
    expect(result.status).toBe('success');
    expect(result.runData.j).toHaveLength(1);
    expect(result.runData.j?.[0]?.output?.main?.[0]).toHaveLength(3);
  });

  it('does not execute a node canceled from node:start', async () => {
    let calls = 0;
    const target: NodeType = {
      ...echoType,
      type: 'test.cancelTarget',
      execute() {
        calls += 1;
        throw new Error('should not run');
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, target]);
    const wf = workflow(
      [
        node('t', triggerType.type, 'Trigger', 0),
        node('target', target.type, 'Target', 200),
      ],
      [connect('t', 'target')],
    );

    const handle = new ExecutionEngine({ registry: local }).run(wf);
    handle.on('node:start', (event) => {
      if (event.nodeName === 'Target') handle.cancel();
    });
    const result = await handle.done;

    expect(result.status).toBe('canceled');
    expect(calls).toBe(0);
  });

  it('stops runaway loops at the execution limit', async () => {
    const loopType: NodeType = {
      ...echoType,
      type: 'test.loop',
      execute(ctx) {
        return [...ctx.items];
      },
    };
    const local = new NodeRegistry().registerAll([triggerType, loopType]);
    const wf = workflow(
      [node('t', triggerType.type, 'Trigger', 0), node('loop', loopType.type, 'Loop', 200)],
      [connect('t', 'loop'), connect('loop', 'loop')],
    );

    const result = await execute(
      wf,
      {},
      new ExecutionEngine({ registry: local, limits: { maxNodeExecutions: 8 } }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/exceeded/);
  });
});
