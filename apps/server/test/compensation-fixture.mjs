import { readFileSync } from 'node:fs';
import { NodeRegistry } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { NodeHost } from '../dist/host.js';
const example = (id) =>
  JSON.parse(readFileSync(new URL('../../../examples/' + id + '.json', import.meta.url)));
const child = example('process-order-batch');
const source = example('order-import');
const names = ['reserve', 'charge', 'ship'];
const undo = ['release', 'refund', 'void'];
export function open(db, fetch, resolve, role = 'all') {
  return new NodeHost(db, {
    ...(process.env.DRAFLOW_TEST_SHARED && {
      shared: {
        connectionString: process.env.DRAFLOW_TEST_SHARED,
        organization: db,
        role,
        leaseMs: 1500,
        pollMs: 75,
      },
    }),
    registry: new NodeRegistry().registerAll(standardNodes),
    fetch,
    httpAuth: {
      organization: db,
      resolve,
      grants: [
        ['order-import', 'ship'],
        ['release', 'register'],
      ].map(([workflowId, nodeId]) => ({
        id: workflowId,
        workflowId,
        nodeId,
        kind: 'bearer',
        origin: 'https://sink.example.test',
      })),
    },
  });
}
export function publish(h, auto = false, manual = false, configure = () => {}) {
  const root = structuredClone(source);
  root.nodes = [root.nodes[0]];
  root.connections = [];
  names.forEach((id, i) => {
    const target = structuredClone(child);
    target.id = undo[i];
    target.nodes[1].parameters.url = 'https://sink.example.test/' + target.id;
    if (manual && i === 1) target.nodes[1].parameters.delivery = 'manual';
    const auth = (node, grant) => {
      node.parameters.authentication = 'credential';
      node.credentials = { httpAuth: grant };
    };
    if (i === 0) auth(target.nodes[1], target.id);
    h.publish(target);
    const n = structuredClone(child.nodes[1]);
    n.id = n.name = id;
    n.parameters.url = 'https://sink.example.test/' + id;
    n.parameters.compensation = { workflowId: target.id, revision: 1, order: 3 - i, onFailure: auto };
    if (i === 2) {
      n.parameters.allowRedrive = true;
      auth(n, root.id);
    }
    const c = structuredClone(child.connections[0]);
    c.id = id;
    c.from.node = root.nodes.at(-1).id;
    c.to.node = id;
    root.nodes.push(n);
    root.connections.push(c);
  });
  configure(root);
  h.activate(root.id, h.publish(root));
}
export const accept = (h) =>
  h.accept('order-import', 'schedule', { key: 'one-order', items: [{ json: { order: 1 } }] });
