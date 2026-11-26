import { WorkflowValidationError } from './errors.js';
import type {
  BinaryRef,
  Connection,
  Item,
  JsonObject,
  JsonValue,
  NodePortRef,
  PairedItem,
  ParamValue,
  SerializedError,
  Workflow,
  WorkflowNode,
  WorkflowSettings,
} from './types.js';
import { createId, isPlainObject, toJsonValue } from './utils.js';

export interface CreateWorkflowInput {
  id?: string;
  name?: string;
  nodes?: WorkflowNode[];
  connections?: Connection[];
  settings?: WorkflowSettings;
  pinData?: Record<string, Item[]>;
  meta?: JsonObject;
}

export interface CreateNodeInput {
  id?: string;
  type: string;
  typeVersion?: number;
  name: string;
  position?: { x: number; y: number };
  parameters?: Record<string, ParamValue>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  settings?: WorkflowNode['settings'];
  credentials?: Record<string, string>;
}

export function createWorkflow(input: CreateWorkflowInput = {}): Workflow {
  const workflow: Workflow = {
    schema: 'draflow/v1',
    id: input.id ?? createId('wf'),
    name: input.name ?? 'Untitled workflow',
    nodes: input.nodes ?? [],
    connections: input.connections ?? [],
    settings: input.settings ?? {},
  };
  if (input.pinData !== undefined) workflow.pinData = input.pinData;
  if (input.meta !== undefined) workflow.meta = input.meta;
  return workflow;
}

export function createNode(input: CreateNodeInput): WorkflowNode {
  const node: WorkflowNode = {
    id: input.id ?? createId('node'),
    type: input.type,
    typeVersion: input.typeVersion ?? 1,
    name: input.name,
    position: input.position ?? { x: 0, y: 0 },
    parameters: input.parameters ?? {},
  };
  if (input.disabled !== undefined) node.disabled = input.disabled;
  if (input.notes !== undefined) node.notes = input.notes;
  if (input.notesInFlow !== undefined) node.notesInFlow = input.notesInFlow;
  if (input.settings !== undefined) node.settings = input.settings;
  if (input.credentials !== undefined) node.credentials = input.credentials;
  return node;
}

export function createConnection(
  from: NodePortRef,
  to: NodePortRef,
  id = createId('conn'),
): Connection {
  return { id, from, to };
}

export function parseWorkflow(input: unknown): Workflow {
  const value = typeof input === 'string' ? parseJson(input) : input;
  if (!isPlainObject(value)) {
    throw new WorkflowValidationError('Workflow must be a JSON object');
  }

  const schema = value.schema;
  if (schema !== 'draflow/v1') {
    throw new WorkflowValidationError(
      `Unsupported workflow schema "${typeof schema === 'string' ? schema : String(schema)}"`,
    );
  }

  const id = requireString(value.id, 'id');
  const name = requireString(value.name, 'name');
  const nodesRaw = requireArray(value.nodes, 'nodes');
  const connectionsRaw = requireArray(value.connections, 'connections');

  const nodes = nodesRaw.map((node, index) => parseNode(node, `nodes[${index}]`));
  const connections = connectionsRaw.map((connection, index) =>
    parseConnection(connection, `connections[${index}]`),
  );

  const workflow: Workflow = {
    schema: 'draflow/v1',
    id,
    name,
    nodes,
    connections,
    settings: parseSettings(value.settings),
  };

  if (value.pinData !== undefined) {
    workflow.pinData = parsePinData(value.pinData);
  }
  if (value.meta !== undefined) {
    if (!isPlainObject(value.meta)) {
      throw new WorkflowValidationError('meta must be an object');
    }
    workflow.meta = toJsonValue(value.meta) as JsonObject;
  }

  return workflow;
}

export function serializeWorkflow(workflow: Workflow, pretty = true): string {
  return JSON.stringify(workflow, null, pretty ? 2 : undefined);
}

export function cloneWorkflow(workflow: Workflow): Workflow {
  return parseWorkflow(serializeWorkflow(workflow, false));
}

function parseNode(input: unknown, path: string): WorkflowNode {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);

  const node: WorkflowNode = {
    id: requireString(input.id, `${path}.id`),
    type: requireString(input.type, `${path}.type`),
    typeVersion: requireNumber(input.typeVersion, `${path}.typeVersion`),
    name: requireString(input.name, `${path}.name`),
    position: parsePosition(input.position, `${path}.position`),
    parameters: parseParameters(input.parameters, `${path}.parameters`),
  };

  if (input.disabled !== undefined) node.disabled = requireBoolean(input.disabled, `${path}.disabled`);
  if (input.notes !== undefined) node.notes = requireString(input.notes, `${path}.notes`);
  if (input.notesInFlow !== undefined) {
    node.notesInFlow = requireBoolean(input.notesInFlow, `${path}.notesInFlow`);
  }
  if (input.settings !== undefined) node.settings = parseNodeSettings(input.settings, `${path}.settings`);
  if (input.credentials !== undefined) {
    if (!isPlainObject(input.credentials)) {
      throw new WorkflowValidationError(`${path}.credentials must be an object`);
    }
    const credentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.credentials)) {
      credentials[key] = requireString(value, `${path}.credentials.${key}`);
    }
    node.credentials = credentials;
  }

  return node;
}

function parseConnection(input: unknown, path: string): Connection {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);
  return {
    id: requireString(input.id, `${path}.id`),
    from: parsePortRef(input.from, `${path}.from`),
    to: parsePortRef(input.to, `${path}.to`),
  };
}

function parsePortRef(input: unknown, path: string): NodePortRef {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);
  const index = requireNumber(input.index, `${path}.index`);
  if (!Number.isInteger(index) || index < 0) {
    throw new WorkflowValidationError(`${path}.index must be a nonnegative integer`);
  }
  return {
    node: requireString(input.node, `${path}.node`),
    port: requireString(input.port, `${path}.port`),
    index,
  };
}

function parsePosition(input: unknown, path: string): { x: number; y: number } {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);
  return { x: requireNumber(input.x, `${path}.x`), y: requireNumber(input.y, `${path}.y`) };
}

function parseParameters(input: unknown, path: string): Record<string, ParamValue> {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);
  const result: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] = toJsonValue(value) as ParamValue;
  }
  return result;
}

function parseSettings(input: unknown): WorkflowSettings {
  if (input === undefined) return {};
  if (!isPlainObject(input)) throw new WorkflowValidationError('settings must be an object');

  const settings: WorkflowSettings = {};
  if (input.timezone !== undefined) settings.timezone = requireString(input.timezone, 'settings.timezone');
  if (input.executionTimeout !== undefined) {
    settings.executionTimeout = requireNumber(input.executionTimeout, 'settings.executionTimeout');
  }
  if (input.maxItemsPerNode !== undefined) {
    settings.maxItemsPerNode = requireNumber(input.maxItemsPerNode, 'settings.maxItemsPerNode');
  }
  if (input.saveExecutionData !== undefined) {
    const value = requireString(input.saveExecutionData, 'settings.saveExecutionData');
    if (value !== 'all' && value !== 'none' && value !== 'error') {
      throw new WorkflowValidationError('settings.saveExecutionData is invalid');
    }
    settings.saveExecutionData = value;
  }
  return settings;
}

function parseNodeSettings(input: unknown, path: string): NonNullable<WorkflowNode['settings']> {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);
  const settings: NonNullable<WorkflowNode['settings']> = {};
  if (input.executeOnce !== undefined) settings.executeOnce = requireBoolean(input.executeOnce, `${path}.executeOnce`);
  if (input.alwaysOutputData !== undefined) {
    settings.alwaysOutputData = requireBoolean(input.alwaysOutputData, `${path}.alwaysOutputData`);
  }
  if (input.retryOnFail !== undefined) settings.retryOnFail = requireBoolean(input.retryOnFail, `${path}.retryOnFail`);
  if (input.maxTries !== undefined) settings.maxTries = requireNumber(input.maxTries, `${path}.maxTries`);
  if (input.waitBetweenTries !== undefined) {
    settings.waitBetweenTries = requireNumber(input.waitBetweenTries, `${path}.waitBetweenTries`);
  }
  if (input.onError !== undefined) {
    const value = requireString(input.onError, `${path}.onError`);
    if (value !== 'stop' && value !== 'continue' && value !== 'errorOutput') {
      throw new WorkflowValidationError(`${path}.onError is invalid`);
    }
    settings.onError = value;
  }
  return settings;
}

function parsePinData(input: unknown): Record<string, Item[]> {
  if (!isPlainObject(input)) throw new WorkflowValidationError('pinData must be an object');
  const result: Record<string, Item[]> = {};
  for (const [nodeId, value] of Object.entries(input)) {
    if (!Array.isArray(value)) throw new WorkflowValidationError(`pinData.${nodeId} must be an array`);
    result[nodeId] = value.map((item, index) => parseItem(item, `pinData.${nodeId}[${index}]`));
  }
  return result;
}

function parseItem(input: unknown, path: string): Item {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);
  const jsonRaw = input.json ?? {};
  if (!isPlainObject(jsonRaw)) throw new WorkflowValidationError(`${path}.json must be an object`);

  const item: Item = { json: toJsonValue(jsonRaw) as JsonObject };
  if (input.binary !== undefined) {
    item.binary = parseBinary(input.binary, `${path}.binary`);
  }
  if (input.pairedItem !== undefined) {
    item.pairedItem = parsePairedItem(input.pairedItem, `${path}.pairedItem`);
  }
  if (input.error !== undefined) {
    item.error = parseSerializedError(input.error, `${path}.error`);
  }
  return item;
}

function parseBinary(input: unknown, path: string): Record<string, BinaryRef> {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);
  const result: Record<string, BinaryRef> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isPlainObject(value)) {
      throw new WorkflowValidationError(`${path}.${key} must be an object`);
    }
    const ref: BinaryRef = {
      mimeType: requireString(value.mimeType, `${path}.${key}.mimeType`),
    };
    if (value.fileName !== undefined) {
      ref.fileName = requireString(value.fileName, `${path}.${key}.fileName`);
    }
    if (value.byteSize !== undefined) {
      ref.byteSize = requireNumber(value.byteSize, `${path}.${key}.byteSize`);
    }
    if (value.id !== undefined) ref.id = requireString(value.id, `${path}.${key}.id`);
    if (value.url !== undefined) ref.url = requireString(value.url, `${path}.${key}.url`);
    result[key] = ref;
  }
  return result;
}

function parsePairedItem(input: unknown, path: string): PairedItem | PairedItem[] {
  if (Array.isArray(input)) {
    return input.map((entry, index) => parsePairedItemObject(entry, `${path}[${index}]`));
  }
  if (typeof input === 'number') {
    return { item: requireNumber(input, path) };
  }
  return parsePairedItemObject(input, path);
}

function parsePairedItemObject(input: unknown, path: string): PairedItem {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);
  const paired: PairedItem = { item: requireNumber(input.item, `${path}.item`) };
  if (input.input !== undefined) paired.input = requireNumber(input.input, `${path}.input`);
  if (input.run !== undefined) paired.run = requireNumber(input.run, `${path}.run`);
  return paired;
}

function parseSerializedError(input: unknown, path: string): SerializedError {
  if (!isPlainObject(input)) throw new WorkflowValidationError(`${path} must be an object`);
  const error: SerializedError = {
    name: requireString(input.name, `${path}.name`),
    message: requireString(input.message, `${path}.message`),
  };
  if (input.stack !== undefined) error.stack = requireString(input.stack, `${path}.stack`);
  if (input.code !== undefined) error.code = requireString(input.code, `${path}.code`);
  if (input.details !== undefined) {
    error.details = toJsonValue(input.details);
  }
  return error;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new WorkflowValidationError(
      `Workflow is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new WorkflowValidationError(`${path} must be a string`);
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorkflowValidationError(`${path} must be a number`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new WorkflowValidationError(`${path} must be a boolean`);
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new WorkflowValidationError(`${path} must be an array`);
  return value;
}

export type { JsonValue };
