// Trusted host port. The producer commits one immutable subscription snapshot per delivery.
import { createHash } from 'node:crypto';
import { createNode, createWorkflow, type JsonObject } from '@draflow/core';

export interface BusinessDelivery {
  organization: string;
  project: string;
  event: string;
  rule: string;
  revision: number;
  proposal: JsonObject;
}
export const businessSchema = `
CREATE TABLE IF NOT EXISTS business_publications (workflow TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS business_receipts (delivery TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, run TEXT NOT NULL UNIQUE REFERENCES runs(runId));`;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function describeDelivery(d: BusinessDelivery) {
  if (
    ![d.organization, d.project, d.event, d.rule].every(
      (v) => typeof v === 'string' && v.length && v.length <= 256,
    ) ||
    !Number.isSafeInteger(d.revision) ||
    d.revision < 1 ||
    !d.proposal ||
    typeof d.proposal !== 'object' ||
    Array.isArray(d.proposal)
  )
    throw Error('Invalid business delivery');
  const payload = JSON.stringify(d.proposal, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
  if (Buffer.byteLength(payload) > 65536) throw Error('Business proposal too large');
  const workflow = 'business-' + hash(JSON.stringify([d.organization, d.project, d.rule, d.revision]));
  return {
    key: hash(JSON.stringify([d.organization, d.project, d.event, d.rule])),
    fingerprint: hash(JSON.stringify([workflow, payload])),
    workflow,
    document: createWorkflow({
      id: workflow,
      name: 'Business action proposal',
      nodes: [
        createNode({
          id: 'event',
          name: 'Business event',
          type: 'draflow.manualTrigger',
          position: { x: 0, y: 0 },
        }),
      ],
    }),
  };
}
