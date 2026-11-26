import { readFileSync } from 'node:fs';
import { isPlainObject } from '@draflow/core';
import type { HttpAuth, HttpGrant } from './http-auth.js';

/** Local configuration contains grants and environment-variable names only. */
export function loadHttpAuth(path: string): HttpAuth {
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(data) || !Array.isArray(data.grants) || !isPlainObject(data.environment))
      throw new Error();
    const variables = new Map(Object.entries(data.environment));
    const grants: HttpGrant[] = data.grants.map((rule) => {
      if (!isPlainObject(rule)) throw new Error();
      const { workflowId, nodeId, id, origin, kind, header } = rule;
      if (
        typeof workflowId !== 'string' ||
        typeof nodeId !== 'string' ||
        typeof id !== 'string' ||
        typeof origin !== 'string' ||
        origin !== new URL(origin).origin
      )
        throw new Error();
      const scope = { workflowId, nodeId, id, origin };
      if (kind === 'bearer') return { ...scope, kind };
      if (kind === 'apiKey' && typeof header === 'string' && header) return { ...scope, kind, header };
      throw new Error();
    });
    return {
      grants,
      resolve(id) {
        const name = variables.get(id);
        return typeof name === 'string' && Object.hasOwn(process.env, name) ? process.env[name] : undefined;
      },
    };
  } catch {
    throw new Error('Invalid server HTTP authentication configuration');
  }
}
