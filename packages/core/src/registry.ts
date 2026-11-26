import { NodeTypeNotFoundError } from './errors.js';
import type { NodeType } from './node.js';
import type { NodeSettings, WorkflowNode } from './types.js';

const DEFAULT_SETTINGS: Required<Omit<NodeSettings, 'onError'>> & { onError: NonNullable<NodeSettings['onError']> } = {
  executeOnce: false,
  alwaysOutputData: false,
  retryOnFail: false,
  maxTries: 3,
  waitBetweenTries: 1000,
  onError: 'stop',
};

export class NodeRegistry {
  readonly #versions = new Map<string, NodeType[]>();

  register(nodeType: NodeType): this {
    const existing = this.#versions.get(nodeType.type) ?? [];
    if (existing.some((entry) => entry.version === nodeType.version)) {
      throw new Error(
        `Node type "${nodeType.type}" version ${nodeType.version} is already registered`,
      );
    }
    existing.push(nodeType);
    existing.sort((a, b) => a.version - b.version);
    this.#versions.set(nodeType.type, existing);
    return this;
  }

  registerAll(nodeTypes: Iterable<NodeType>): this {
    for (const nodeType of nodeTypes) this.register(nodeType);
    return this;
  }

  get(type: string, version?: number): NodeType | undefined {
    const versions = this.#versions.get(type);
    if (versions === undefined || versions.length === 0) return undefined;
    if (version === undefined) return versions[versions.length - 1];
    const exact = versions.find((entry) => entry.version === version);
    if (exact !== undefined) return exact;
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      const entry = versions[index];
      if (entry !== undefined && entry.version < version) return entry;
    }
    return undefined;
  }

  require(type: string, version?: number): NodeType {
    const nodeType = this.get(type, version);
    if (nodeType === undefined) throw new NodeTypeNotFoundError(type, version);
    return nodeType;
  }

  has(type: string, version?: number): boolean {
    return this.get(type, version) !== undefined;
  }

  list(): NodeType[] {
    return [...this.#versions.values()].flat().sort((a, b) => {
      if (a.meta.category !== b.meta.category) {
        return a.meta.category.localeCompare(b.meta.category);
      }
      return a.meta.label.localeCompare(b.meta.label);
    });
  }

  types(): string[] {
    return [...this.#versions.keys()];
  }
}

export function resolveNodeSettings(node: WorkflowNode): Required<NodeSettings> {
  const settings = node.settings ?? {};
  return {
    executeOnce: settings.executeOnce ?? DEFAULT_SETTINGS.executeOnce,
    alwaysOutputData: settings.alwaysOutputData ?? DEFAULT_SETTINGS.alwaysOutputData,
    retryOnFail: settings.retryOnFail ?? DEFAULT_SETTINGS.retryOnFail,
    maxTries: clampInt(settings.maxTries ?? DEFAULT_SETTINGS.maxTries, 2, 5),
    waitBetweenTries: clampInt(
      settings.waitBetweenTries ?? DEFAULT_SETTINGS.waitBetweenTries,
      0,
      5000,
    ),
    onError: settings.onError ?? DEFAULT_SETTINGS.onError,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
