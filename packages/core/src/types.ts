/**
 * Core data model for Draflow.
 *
 * A workflow is plain JSON. Nodes are addressed by stable ids in connections,
 * while `name` is the human-readable label used by expressions.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ParamValue = JsonValue | undefined;

export interface Workflow {
  schema: 'draflow/v1';
  id: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Connection[];
  settings: WorkflowSettings;
  pinData?: Record<string, Item[]>;
  meta?: JsonObject;
}

export interface WorkflowNode {
  id: string;
  type: string;
  typeVersion: number;
  name: string;
  position: { x: number; y: number };
  parameters: Record<string, ParamValue>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  settings?: NodeSettings;
  credentials?: Record<string, string>;
}

export interface Connection {
  id: string;
  from: NodePortRef;
  to: NodePortRef;
}

export interface NodePortRef {
  /** Node id, not node name. */
  node: string;
  /** Port type such as `main` or `error`. */
  port: string;
  /** Port index, used by nodes with multiple outputs of the same type. */
  index: number;
}

export interface WorkflowSettings {
  timezone?: string;
  executionTimeout?: number;
  maxItemsPerNode?: number;
  saveExecutionData?: 'all' | 'none' | 'error';
}

export interface NodeSettings {
  executeOnce?: boolean;
  alwaysOutputData?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: OnErrorMode;
}

export type OnErrorMode = 'stop' | 'continue' | 'errorOutput';

export interface BinaryRef {
  mimeType: string;
  fileName?: string;
  byteSize?: number;
  /** Host-managed identifier; Draflow never stores bytes. */
  id?: string;
  /** Host-managed URL. */
  url?: string;
}

export interface PairedItem {
  item: number;
  input?: number;
  run?: number;
}

export interface Item {
  json: JsonObject;
  binary?: Record<string, BinaryRef>;
  pairedItem?: PairedItem | PairedItem[];
  error?: SerializedError;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  details?: JsonValue;
}

/** port type -> port index -> items (null means "not provided yet"). */
export type PortData = Record<string, Array<Item[] | null>>;

export interface SourceRef {
  node: string;
  port: string;
  index: number;
  runIndex: number;
}

export type TaskStatus = 'success' | 'error' | 'waiting' | 'canceled';

export interface TaskData {
  nodeId: string;
  runIndex: number;
  startTime: number;
  executionTime: number;
  executionIndex: number;
  status: TaskStatus;
  input?: PortData;
  output?: PortData;
  error?: SerializedError;
  hints?: string[];
  source?: Array<SourceRef | null>;
}

export type RunData = Record<string, TaskData[]>;

export type ExecutionMode = 'manual' | 'trigger' | 'webhook' | 'retry' | 'subworkflow';

export interface RunOptions {
  mode?: ExecutionMode;
  runId?: string;
  /** Start execution at this node instead of at the trigger nodes. */
  startNodeId?: string;
  /** Stop at this node. Upstream nodes still run. */
  destinationNodeId?: string;
  destinationMode?: 'inclusive' | 'exclusive';
  /** Reuse completed node outputs, keyed by node id. */
  runData?: RunData;
  /** Node outputs that must not be executed. */
  pinData?: Record<string, Item[]>;
  /** Data passed to the start node. Defaults to one empty item. */
  triggerData?: PortData;
  /** Nodes that must be re-executed when reusing runData. */
  dirtyNodeIds?: string[];
  signal?: AbortSignal;
}

export type RunStatus = 'success' | 'error' | 'canceled' | 'waiting';

export interface RunResult {
  id: string;
  workflowId: string;
  status: RunStatus;
  startedAt: number;
  stoppedAt: number;
  runData: RunData;
  error?: SerializedError;
}

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  nodeId?: string;
  connectionId?: string;
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}
