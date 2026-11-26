import { describe, expect, it } from 'vitest';
import { NodeRegistry, type NodeType, type Workflow, type WorkflowNode } from '@draflow/core';
import { MemoryRuntime, type TriggerRegistration } from '../src/index.js';

const source: NodeType = {
  type: 'source', version: 1, meta: { category: 'trigger', label: 'Source' },
  parameters: [], ports: { inputs: [], outputs: [{ type: 'main' }] },
};
const stamp: NodeType = {
  ...source, type: 'stamp', meta: { category: 'transform', label: 'Stamp' },
  ports: { inputs: [{ type: 'main' }], outputs: [{ type: 'main' }] },
  execute: ctx => ctx.items.map(item => ({
    json: { ...item.json, label: ctx.param<string>('label'), run: ctx.execution.id },
  })),
};

function node(id: string, type: string): WorkflowNode {
  return { id, name: id, type, typeVersion: 2, parameters: { label: 'published' }, position: { x: 0, y: 0 } };
}

function draft(): Workflow {
  return {
    id: 'flow', name: 'Flow', schema: 'draflow/v1', settings: {},
    nodes: [node('left', 'source'), node('right', 'source'), node('a', 'stamp'), node('b', 'stamp')],
    connections: ([['left', 'a'], ['right', 'b']] as const).map(([from, to]) => ({
      id: from, from: { node: from, port: 'main', index: 0 }, to: { node: to, port: 'main', index: 0 },
    })),
    pinData: { a: [{ json: { label: 'editor preview' } }] },
  };
}

const event = { key: 'delivery-42', runId: 'run-42', items: [{ json: { payload: 42 } }] };

describe('published executions', () => {
  it('runs the published snapshot after draft edits and registry additions', async () => {
    const registry = new NodeRegistry().registerAll([source, stamp]);
    const runtime = new MemoryRuntime({ registry });
    const workflow = draft();
    runtime.saveDraft(workflow);
    const published = runtime.publish('flow');
    published.workflow.nodes[2]!.parameters.label = 'changed return value';
    workflow.nodes[2]!.parameters.label = 'new draft';
    runtime.saveDraft(workflow);
    registry.register({ ...stamp, version: 2, execute: () => [] });
    const next = runtime.publish('flow');
    await runtime.activate('flow', published.revision);
    const run = await runtime.fire('flow', 'left', event);
    expect(run).toMatchObject({
      revision: 1, workflowId: 'flow', triggerNodeId: 'left', eventKey: 'delivery-42',
      nodeVersions: { a: { type: 'stamp', version: 1 } }, result: { id: 'run-42', status: 'success' },
    });
    expect(run.result.runData.a?.[0]?.output?.main?.[0]?.[0]?.json)
      .toEqual({ payload: 42, label: 'published', run: 'run-42' });
    expect(next.revision).toBe(2);
  });

  it.each([['left', 'a'], ['right', 'b']])('executes only the branch registered for %s', async (id, output) => {
    const registrations = new Map<string, TriggerRegistration>();
    const runtime = new MemoryRuntime({
      registry: new NodeRegistry().registerAll([source, stamp]),
      registerTrigger: registration => { registrations.set(registration.node.id, registration); },
    });
    runtime.saveDraft(draft());
    runtime.publish('flow');
    await runtime.activate('flow', 1);
    const run = await registrations.get(id)!.fire(event);
    expect(Object.keys(run.result.runData)).toEqual([id, output]);
    await expect(runtime.fire('flow', output, event)).rejects.toThrow('Unknown active trigger');
  });

  it('rolls back partial registration and fences callbacks through repeated lifecycle operations', async () => {
    const live = new Set<TriggerRegistration>();
    let fail = true;
    const runtime = new MemoryRuntime({
      registry: new NodeRegistry().registerAll([source, stamp]),
      async registerTrigger(reg) {
        live.add(reg);
        reg.signal.addEventListener('abort', () => live.delete(reg), { once: true });
        await expect(reg.fire(event)).rejects.toThrow('Inactive trigger');
        if (reg.revision === 2 && reg.node.id === 'right' && fail) throw new Error('setup failed');
      },
    });
    runtime.saveDraft(draft());
    runtime.publish('flow');
    runtime.publish('flow');
    await Promise.all([runtime.activate('flow', 1), runtime.activate('flow', 1)]);
    const old = [...live][0]!;
    await expect(runtime.activate('flow', 2)).rejects.toThrow('setup failed');
    expect(live.size).toBe(2);
    expect((await old.fire(event)).revision).toBe(1);
    fail = false;
    await runtime.activate('flow', 2);
    expect(live.size).toBe(2);
    await expect(old.fire(event)).rejects.toThrow('Inactive trigger');
    await Promise.all([runtime.deactivate('flow'), runtime.deactivate('flow')]);
    expect(live.size).toBe(0);
    await expect(runtime.fire('flow', 'left', event)).rejects.toThrow('Inactive workflow');
  });

  it('validates publication and requires the exact installed versions on restore before registration', async () => {
    const registry = new NodeRegistry().registerAll([source, { ...stamp, version: 2 }]);
    const runtime = new MemoryRuntime({ registry });
    const workflow = draft();
    runtime.saveDraft(workflow);
    const release = runtime.publish('flow');
    workflow.nodes.pop();
    runtime.saveDraft(workflow);
    expect(() => runtime.publish('flow')).toThrow('unknown node');
    const registrations: string[] = [];
    const targetRegistry = new NodeRegistry().registerAll([source, stamp]);
    const target = new MemoryRuntime({
      registry: targetRegistry,
      registerTrigger: reg => { registrations.push(reg.node.id); },
    });
    expect(() => target.restore(release)).toThrow('requires stamp@2, resolved 1');
    await expect(target.activate('flow', 1)).rejects.toThrow('Unknown publication');
    expect(registrations).toEqual([]);
    targetRegistry.register({ ...stamp, version: 2 });
    target.restore(release);
    await target.activate('flow', 1);
    expect(registrations).toEqual(['left', 'right']);
  });
});
