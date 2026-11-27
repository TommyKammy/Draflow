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
    const profiles = new Map<string, Map<string, string>>();
    if (data.versions !== undefined) {
      if (!isPlainObject(data.versions)) throw Error();
      for (const [id, entries] of Object.entries(data.versions)) {
        if (!isPlainObject(entries)) throw Error();
        const versions = new Map<string, string>();
        for (const [version, variable] of Object.entries(entries)) {
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(version) || typeof variable !== 'string' || !variable)
            throw Error();
          versions.set(version, variable);
        }
        profiles.set(id, versions);
      }
    }
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
      ...(typeof data.organization === 'string' && { organization: data.organization }),
      grants,
      versions: Object.fromEntries([...profiles].map(([id, entries]) => [id, [...entries.keys()]])),
      resolve(id, version) {
        const name = version === undefined ? variables.get(id) : profiles.get(id)?.get(version);
        return typeof name === 'string' && Object.hasOwn(process.env, name) ? process.env[name] : undefined;
      },
    };
  } catch {
    throw new Error('Invalid server HTTP authentication configuration');
  }
}
