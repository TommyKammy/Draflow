import type {
  BinaryRef,
  ExecutionMode,
  Item,
  JsonObject,
  JsonValue,
  NodeSettings,
  ParamValue,
  PortData,
  WorkflowNode,
} from './types.js';

export type NodeCategory = 'trigger' | 'core' | 'transform' | 'flow' | 'network' | 'human';

export interface NodeMeta {
  label: string;
  category: NodeCategory;
  description?: string;
  icon?: string;
  color?: string;
  docsUrl?: string;
  tags?: string[];
  hidden?: boolean;
}

export interface PortDef {
  type: string;
  label?: string;
  required?: boolean;
  multiple?: boolean;
}

export type NodeOutput = Item[] | Item[][] | PortData | void;

export interface CredentialSlot {
  name: string;
  label: string;
  required?: boolean;
}

export interface WaitRequest {
  mode: 'time' | 'event';
  dueAt: number;
}

export interface WaitResult {
  reason: 'event' | 'time' | 'expired' | 'canceled';
  data: JsonObject;
}

export type JournalItem = (index: number, fingerprint: string,
  send: (key: string) => Promise<JsonObject>) => Promise<JsonObject>;

export interface NodeType {
  journalMode?: (node: WorkflowNode) => 'keyed' | 'manual' | undefined;
  wait?: (ctx: NodeContext) => WaitRequest;
  type: string;
  version: number;
  meta: NodeMeta;
  ports: { inputs: PortDef[]; outputs: PortDef[] };
  parameters: ParamSchema[];
  credentials?: CredentialSlot[];
  execute?: (ctx: NodeContext) => Promise<NodeOutput> | NodeOutput;
  trigger?: (ctx: TriggerContext) => Promise<TriggerHandle> | TriggerHandle;
  webhook?: (ctx: WebhookContext) => Promise<WebhookResult> | WebhookResult;
  methods?: NodeMethods;
}

export interface NodeMethods {
  loadOptions?: Record<string, (ctx: LoadOptionsContext) => Promise<Option[]> | Option[]>;
  listSearch?: Record<string, (ctx: ListSearchContext) => Promise<Option[]> | Option[]>;
}

export type ParamSchema =
  | StringParam
  | TextParam
  | CodeParam
  | NumberParam
  | BooleanParam
  | SelectParam
  | MultiSelectParam
  | JsonParam
  | CollectionParam
  | FixedCollectionParam
  | ResourceLocatorParam
  | FilterParam
  | NoticeParam
  | HiddenParam;

interface BaseParam {
  name: string;
  label: string;
  description?: string;
  hint?: string;
  required?: boolean;
  default?: ParamValue;
  displayOptions?: DisplayOptions;
  placeholder?: string;
  noExpression?: boolean;
}

export interface StringParam extends BaseParam {
  type: 'string';
  password?: boolean;
  rows?: number;
  requiresDataPath?: 'single' | 'multiple';
}

export interface TextParam extends BaseParam {
  type: 'text';
  rows?: number;
}

export interface CodeParam extends BaseParam {
  type: 'code';
  language?: 'javascript' | 'json' | 'text';
  rows?: number;
}

export interface NumberParam extends BaseParam {
  type: 'number';
  min?: number;
  max?: number;
  precision?: number;
}

export interface BooleanParam extends BaseParam {
  type: 'boolean';
}

export interface Option {
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export type DynamicOptions = (ctx: LoadOptionsContext) => Promise<Option[]> | Option[];

export interface SelectParam extends BaseParam {
  type: 'select';
  options: Option[] | DynamicOptions;
}

export interface MultiSelectParam extends BaseParam {
  type: 'multiSelect';
  options: Option[] | DynamicOptions;
}

export interface JsonParam extends BaseParam {
  type: 'json';
  rows?: number;
}

export interface CollectionParam extends BaseParam {
  type: 'collection';
  fields: ParamSchema[];
  addLabel?: string;
}

export interface FixedCollectionParam extends BaseParam {
  type: 'fixedCollection';
  fields: ParamSchema[];
  multiple: boolean;
  itemTitle?: string;
  min?: number;
  max?: number;
}

export interface ResourceLocatorMode {
  name: string;
  label: string;
  type: 'string' | 'list';
  placeholder?: string;
  searchListMethod?: string;
}

export interface ResourceLocatorValue {
  __rl: true;
  mode: string;
  value: string;
  cachedResultName?: string;
  cachedResultUrl?: string;
}

export interface ResourceLocatorParam extends BaseParam {
  type: 'resourceLocator';
  modes: ResourceLocatorMode[];
}

export interface FilterCondition {
  left: string;
  operator: FilterOperator;
  right?: string;
}

export type FilterCombinator = 'and' | 'or';

export interface FilterValue {
  combinator: FilterCombinator;
  conditions: FilterCondition[];
}

export interface FilterParam extends BaseParam {
  type: 'filter';
  maxConditions?: number;
  allowedCombinators?: FilterCombinator[];
}

export interface NoticeParam extends BaseParam {
  type: 'notice' | 'callout';
  noticeType?: 'info' | 'warning' | 'danger' | 'success';
}

export interface HiddenParam extends BaseParam {
  type: 'hidden';
}

export type Condition =
  | string
  | number
  | boolean
  | null
  | { _cnd: Record<string, unknown> }
  | { eq: unknown }
  | { not: unknown }
  | { gte: number }
  | { lte: number }
  | { gt: number }
  | { lt: number }
  | { between: { from: number; to: number } }
  | { includes: string }
  | { startsWith: string }
  | { endsWith: string }
  | { regex: string }
  | { exists: true };

export interface DisplayOptions {
  show?: Record<string, Condition[]>;
  hide?: Record<string, Condition[]>;
}

export type FilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isTrue'
  | 'isFalse'
  | 'exists'
  | 'notExists';

export interface NodeContext {
  resume?: WaitResult;
  journalItem?: JournalItem;
  /** All items of the primary input. */
  readonly items: readonly Item[];
  readonly itemCount: number;
  readonly runIndex: number;
  readonly mode: ExecutionMode;

  param<T = ParamValue>(name: string, itemIndex?: number, fallback?: T): T;
  /** Resolves expressions inside an arbitrary parameter value for the given item. */
  resolve<T>(value: T, itemIndex?: number): T;
  input(port?: string, index?: number): readonly Item[];
  firstInput(port?: string, index?: number): Item | undefined;
  forItem(index: number): ItemContext;
  each(fn: (item: Item, ctx: ItemContext, index: number) => void | Promise<void>): Promise<void>;

  /** Returns the items unchanged. A convenience for node authors. */
  output(items: Item | Item[]): Item[];

  readonly helpers: NodeHelpers;
  readonly credentials: CredentialReader;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly vars: Readonly<Record<string, JsonValue>>;
  readonly workflow: WorkflowInfo;
  readonly execution: ExecutionInfo;
}

export interface ItemContext {
  readonly item: Item;
  readonly itemIndex: number;
  param<T = ParamValue>(name: string, fallback?: T): T;
  resolve<T>(value: T): T;
}

export interface NodeHelpers {
  fetch: FetchLike;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
  uuid(): string;
  hash(algo: 'sha256' | 'sha1', data: string | ArrayBuffer): Promise<string>;
  base64Encode(value: string): string;
  base64Decode(value: string): string;
}

export interface CredentialReader {
  /** Opaque transport for a configured slot. The node never receives the secret. */
  fetchForSlot?(slot: string, required: boolean): FetchLike;
  get(slot: string): Promise<Record<string, string> | null>;
}

export interface Logger {
  debug(message: string, data?: JsonObject): void;
  info(message: string, data?: JsonObject): void;
  warn(message: string, data?: JsonObject): void;
  error(message: string, data?: JsonObject): void;
}

export interface WorkflowInfo {
  id: string;
  name: string;
  timezone: string;
}

export interface ExecutionInfo {
  id: string;
  mode: ExecutionMode;
  startedAt: number;
}

export interface LoadOptionsContext {
  param<T = ParamValue>(name: string, fallback?: T): T;
  getCurrentNodeParameters(): Record<string, ParamValue>;
  readonly credentials: CredentialReader;
  readonly helpers: NodeHelpers;
  readonly node: WorkflowNode;
}

export interface ListSearchContext extends LoadOptionsContext {
  filter?: string;
  paginationToken?: string;
}

export interface TriggerContext {
  readonly node: WorkflowNode;
  readonly helpers: NodeHelpers;
  readonly credentials: CredentialReader;
  readonly logger: Logger;
  param<T = ParamValue>(name: string, fallback?: T): T;
  emit(items: Item | Item[]): Promise<void>;
  readonly signal: AbortSignal;
}

export interface TriggerHandle {
  stop(): Promise<void>;
  manualTrigger?(): Promise<Item[]>;
}

export interface WebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface WebhookResult {
  items?: Item[];
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | JsonValue;
  };
  noResponse?: boolean;
}

export interface WebhookContext {
  readonly node: WorkflowNode;
  readonly request: WebhookRequest;
  readonly helpers: NodeHelpers;
  readonly credentials: CredentialReader;
  readonly logger: Logger;
  param<T = ParamValue>(name: string, fallback?: T): T;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface NodeTypeResolution {
  node: WorkflowNode;
  type: NodeType;
  settings: NodeSettings;
}

export function portItems(data: PortData | undefined, port: string, index: number): Item[] {
  return data?.[port]?.[index] ?? [];
}

export function primaryInput(data: PortData | undefined): Item[] {
  return portItems(data, 'main', 0);
}

export function binarySize(binary: Record<string, BinaryRef> | undefined): number {
  if (binary === undefined) return 0;
  let total = 0;
  for (const ref of Object.values(binary)) total += ref.byteSize ?? 0;
  return total;
}
