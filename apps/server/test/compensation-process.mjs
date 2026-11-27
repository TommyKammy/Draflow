import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { open, publish, accept } from './compensation-fixture.mjs';
import { until } from './fixture.mjs';
const [db, phase, mode] = process.argv.slice(2);
const path = db + '.receiver';
const confirmed = () =>
  existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) : [];
const h = open(
  db,
  async (url, init) => {
    const name = new URL(url).pathname.slice(1);
    const key = new Headers(init.headers).get('Idempotency-Key');
    if (!confirmed().some((r) => r.key === key)) appendFileSync(path, JSON.stringify({ name, key }) + '\n');
    if (name === 'ship' && phase === 'interrupt-shipment') process.kill(process.pid, 'SIGKILL');
    if (name === 'refund' && phase === 'kill') process.kill(process.pid, 'SIGKILL');
    return Response.json({ id: name + '-123' });
  },
  (id) => (id === 'release' ? 'opaque-secret' : undefined),
);
if (phase === 'interrupt-shipment') {
  publish(h, true, false, (workflow) => {
    const ship = workflow.nodes.at(-1);
    ship.parameters = { method: 'POST', url: ship.parameters.url };
    delete ship.credentials;
    if (mode === 'nested') {
      const child = JSON.parse(
        readFileSync(new URL('../../../examples/process-order-batch.json', import.meta.url)),
      );
      child.id = 'shipment-service';
      child.nodes[1].parameters = ship.parameters;
      h.publish(child);
      ship.type = 'draflow.call';
      ship.typeVersion = 1;
      ship.parameters = { workflowId: child.id, revision: 1 };
    }
  });
  writeFileSync(db + '.id', accept(h));
} else if (phase === 'kill') {
  publish(h, false, mode === 'manual');
  const root = accept(h);
  await until(() => h.receipt(root).state === 'finished');
  const id = h.compensate(root);
  writeFileSync(db + '.id', JSON.stringify({ root, id }));
} else {
  const { root, id } = JSON.parse(readFileSync(db + '.id'));
  if (h.compensate(root) !== id || h.compensate(root) !== id) throw Error('Duplicate compensation');
  if (mode === 'manual') {
    await until(() => h.compensationInfo(root).state === 'review');
    const child = h.compensationInfo(root).steps[0].child;
    const [effect] = h.effects(child);
    if (!h.reconcile(child, effect.key, 'applied', { id: 'refund-123' }))
      throw Error('Cannot reconcile refund');
  }
  await until(() => h.compensationInfo(root).state === 'compensated');
  console.log(JSON.stringify(confirmed().map((r) => r.name)));
  await h.close();
}
