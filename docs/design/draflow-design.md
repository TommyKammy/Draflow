# Draflow 設計案 — 軽量・高速・ゼロ依存のワークフロー基盤

- 目的: n8n の「実行 → 観察 → 配線 → 再実行」という操作体験を、**TypeScript 7.0.2 / ゼロランタイム依存 / 埋め込み可能** な形で再実装する。
- 参照: [n8n 分析レポート](../analysis/n8n-analysis.md) / [REA 証跡](../analysis/rea-evidence.md)
- ステータス: **提案**（Phase 0 + Phase 1 は実装済み。[実装状況](../implementation.md)）

---

## 1. ゴール

1. **軽い**: エディタ全体で gzip 250 KB 以下。n8n の 33 MB から 99% 削減。
2. **速い**: 200 ノード / 500 エッジのキャンバスが 60fps。式評価は 1 回 0.1ms 台。
3. **ゼロ依存**: ランタイム依存パッケージなし。開発時のみ esbuild / Vite / Vitest / Playwright / TypeScript 7.0.2。
4. **埋め込み可能**: `<draflow-editor>` を 1 行で置ける。Shadow DOM でスタイル隔離。ホストの API・認証・ストレージと接続できる。
5. **安全**: デフォルトで `eval` しない。式はサブセット解釈。コード実行はホストの明示的なオプトイン。
6. **n8n の操作感**: 3 ペイン NDV、ドラッグマッピング、ピン、部分実行、ログ、実行リプレイ。
7. **フレームワーク非依存**: Vanilla API、Web Component、React ラッパー（任意）。

---

## 2. 非ゴール（v1）

- 1,000 個のアプリ統合。v1 は 15〜20 ノード。
- AI / LangChain / Agent / MCP。
- フォーム、チャット、評価、テンプレート、インサイト。
- RBAC / SSO / マルチテナント / 監査ログ。
- キュー / ワーカー / 分散実行。
- コラボレーション / CRDT / バージョン履歴。
- コミュニティノードのマーケットプレイス。
- `eval` を前提にしたフル JS 式（ホストのオプトインでのみ提供）。
- n8n JSON の完全互換（任意のコンバータで部分対応）。

---

## 3. パッケージ構成

```text
packages/
  core/        @draflow/core      純粋 TS。スキーマ、グラフ、式、実行エンジン、検証。DOM なし。
  nodes/       @draflow/nodes     標準ノード。core のみに依存。
  runtime/     @draflow/runtime   実行ホスト。スケジューラ、Webhook、実行管理。
  element/     @draflow/element   ゼロ依存 Web Component エディタ。Shadow DOM。
  storage/     @draflow/storage   永続化アダプタ（任意）。
  react/       @draflow/react     React ラッパー（任意）。
apps/
  demo/        Vite デモ。全パッケージを接続。
  server/      Node ランタイム + Webhook + cron（任意、Phase 3）。
```

依存ルール:

```text
core     → なし
nodes    → core
runtime  → core
element  → core
storage  → core
react    → element（peer: react）
demo     → すべて
server   → core, nodes, runtime, storage
```

**element は nodes を import しない。** ノードセットはホストが注入する。これにより、不要なノードをバンドルから落とせる。

---

## 4. 公開 API

### 4.1 Vanilla

```ts
import { createWorkflowEditor } from '@draflow/element';
import { standardNodes } from '@draflow/nodes';

const editor = createWorkflowEditor(document.querySelector('#app')!, {
  workflow: await fetch('/workflow.json').then((r) => r.json()),
  nodeTypes: standardNodes,
  theme: 'auto',
  locale: 'ja',
  ports: {
    fetch: (input, init) => fetch(input, init),
    storage: new HttpWorkflowStore('/api'),
    credentials: new HostCredentialProvider(),
  },
  onChange(workflow, meta) {
    save(workflow, meta);
  },
  onRun(event) {
    console.log(event);
  },
});
```

### 4.2 Web Component

```html
<draflow-editor
  theme="auto"
  locale="ja"
  readonly
  min-height="600px"
></draflow-editor>

<script type="module">
  import '@draflow/element/define';
  const el = document.querySelector('draflow-editor');
  el.nodeTypes = standardNodes;
  el.workflow = await fetch('/workflow.json').then((r) => r.json());
  el.addEventListener('draflow-change', (event) => save(event.detail.workflow));
</script>
```

`@draflow/element/define` は副作用モジュール。`@draflow/element` 本体は副作用なし。

### 4.3 エディタのインターフェース

```ts
export interface DraflowEditor {
  getWorkflow(): Workflow;
  setWorkflow(workflow: Workflow, options?: { resetHistory?: boolean }): void;

  run(options?: RunOptions): RunHandle;
  runNode(nodeId: string, options?: RunOptions): RunHandle;
  stop(): void;

  focusNode(nodeId: string): void;
  fitView(): void;
  undo(): void;
  redo(): void;

  on<K extends keyof EditorEvents>(event: K, handler: EditorEvents[K]): () => void;
  destroy(): void;
}
```

### 4.4 イベント

| イベント | ペイロード |
| --- | --- |
| `draflow-ready` | `{}` |
| `draflow-change` | `{ workflow, source, dirty }` |
| `draflow-selection` | `{ nodeIds, connectionIds }` |
| `draflow-run-start` | `{ runId, mode }` |
| `draflow-node-start` | `{ runId, nodeId, runIndex }` |
| `draflow-node-finish` | `{ runId, nodeId, runIndex, status, data, error?, executionTime }` |
| `draflow-run-finish` | `{ runId, status, startedAt, stoppedAt, error? }` |
| `draflow-toast` | `{ type, message }` |

すべて `bubbles: true, composed: true`。Shadow DOM の外まで届く。

---

## 5. データスキーマ

### 5.1 Workflow

```ts
export interface Workflow {
  schema: 'draflow/v1';
  id: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Connection[];
  settings: WorkflowSettings;
  pinData?: Record<string, Item[]>; // nodeId -> items
  meta?: JsonObject;
}

export interface WorkflowNode {
  id: string;
  type: string;          // 'draflow.httpRequest'
  typeVersion: number;
  name: string;          // 表示名 + 式からの参照名
  position: { x: number; y: number };
  parameters: Record<string, ParamValue>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  settings?: NodeSettings;
  credentials?: Record<string, string>; // slot -> credentialId
}

export interface Connection {
  id: string;
  from: { node: string; port: string; index: number };
  to: { node: string; port: string; index: number };
}

export interface NodeSettings {
  executeOnce?: boolean;
  alwaysOutputData?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;          // 2..5
  waitBetweenTries?: number;  // 0..5000ms
  onError?: 'stop' | 'continue' | 'errorOutput';
}

export interface WorkflowSettings {
  timezone?: string;          // IANA
  executionTimeout?: number;  // ms
  saveExecutionData?: 'all' | 'none' | 'error';
  maxItemsPerNode?: number;   // default 10_000
}
```

**n8n との違い**

- 接続は **ノード ID** で持つ。名前変更で壊れない。式からの参照は名前でも ID でもよい。
- 接続は配列。n8n の `connections[node][type][index]` の入れ子を平坦化する。
- `schema` フィールドでバージョンを明示。

### 5.2 Item

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface Item {
  json: JsonObject;
  binary?: Record<string, BinaryRef>;
  pairedItem?: PairedItem | PairedItem[];
}

export interface PairedItem {
  item: number;
  input?: number;   // input port index
  run?: number;
}

export interface BinaryRef {
  mimeType: string;
  fileName?: string;
  byteSize?: number;
  // 実体はホストが解決する。Draflow は保存しない。
  id?: string;
  url?: string;
}
```

### 5.3 RunData

```ts
export interface RunData {
  [nodeId: string]: TaskData[];
}

export interface TaskData {
  runIndex: number;
  startTime: number;
  executionTime: number;
  executionIndex: number;
  status: 'success' | 'error' | 'waiting' | 'canceled';
  input?: PortData;
  output?: PortData;
  error?: SerializedError;
  hints?: string[];
  source?: Array<SourceRef | null>;
}

export type PortData = Record<string, Item[][]>; // portType -> portIndex -> items
```

`RunData` が UI の唯一の源。キャンバス、ログ、NDV はここから描画する。

---

## 6. ノード SDK

### 6.1 定義

```ts
export interface NodeType {
  type: string;
  version: number;
  meta: NodeMeta;
  ports: { inputs: PortDef[]; outputs: PortDef[] };
  parameters: ParamSchema[];
  credentials?: CredentialSlot[];
  execute?: (ctx: NodeContext) => Promise<NodeOutput>;
  trigger?: (ctx: TriggerContext) => Promise<TriggerHandle>;
  webhook?: (ctx: WebhookContext) => Promise<WebhookResult>;
  methods?: {
    loadOptions?: Record<string, (ctx: LoadOptionsContext) => Promise<Option[]>>;
    listSearch?: Record<string, (ctx: ListSearchContext) => Promise<Option[]>>;
  };
}

export interface NodeMeta {
  label: string;
  category: 'trigger' | 'core' | 'transform' | 'flow' | 'network' | 'human';
  description?: string;
  icon?: string;       // 内蔵 SVG 名
  color?: string;      // アクセント色
  docsUrl?: string;
  tags?: string[];
  hidden?: boolean;
}
```

### 6.2 ポート

```ts
export interface PortDef {
  type: string;          // 'main' | 'error' | 'ai' など
  label?: string;
  required?: boolean;    // 入力が揃うまで待つ
  multiple?: boolean;    // 複数接続を許可
}
```

v1 は `main` と `error` のみ。`required: true` の入力が 2 つ以上あるノード（Merge）は waiting の対象。

### 6.3 パラメータ

```ts
export type ParamSchema =
  | StringParam
  | TextParam
  | NumberParam
  | BooleanParam
  | SelectParam
  | MultiSelectParam
  | JsonParam
  | CollectionParam
  | FixedCollectionParam
  | ResourceLocatorParam
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
}

interface StringParam extends BaseParam {
  type: 'string';
  password?: boolean;
  rows?: number;
  requiresDataPath?: 'single' | 'multiple';
}

interface SelectParam extends BaseParam {
  type: 'select';
  options: Option[] | DynamicOptions;
}

interface CollectionParam extends BaseParam {
  type: 'collection';
  fields: ParamSchema[];
}

interface FixedCollectionParam extends BaseParam {
  type: 'fixedCollection';
  fields: ParamSchema[];
  multiple: boolean;
  itemTitle?: string;    // '{{ $collection.item.name }}'
  min?: number;
  max?: number;
}
```

### 6.4 表示条件

n8n 互換のサブセット:

```ts
export interface DisplayOptions {
  show?: Record<string, Condition[]>;
  hide?: Record<string, Condition[]>;
}

export type Condition =
  | string | number | boolean
  | { eq: unknown }
  | { not: unknown }
  | { gte: number } | { lte: number }
  | { gt: number } | { lt: number }
  | { includes: string }
  | { startsWith: string } | { endsWith: string }
  | { regex: string }
  | { exists: true };
```

`@version` も参照できる。`displayOptions` は **フォームの描画時** と **パラメータ解決時** の両方で評価する。

### 6.5 実行コンテキスト

```ts
export interface NodeContext {
  /** 主入力の Item 全量。ノードは 1 回の呼び出しでこれを受け取る。 */
  readonly items: readonly Item[];
  readonly itemCount: number;
  readonly runIndex: number;
  readonly mode: ExecutionMode;

  /** itemIndex を省略すると 0 番目の Item として解決する。 */
  param<T = ParamValue>(name: string, itemIndex?: number, fallback?: T): T;
  /** 任意のパラメータ値（ネストしたオブジェクト・配列を含む）の式を解決する。 */
  resolve<T>(value: T, itemIndex?: number): T;
  input(port?: string, index?: number): readonly Item[];
  firstInput(port?: string, index?: number): Item | undefined;

  /** 特定の Item に束縛された軽量コンテキスト。 */
  forItem(index: number): ItemContext;

  /** Item ごとの処理を安全に書くためのヘルパー。 */
  each(fn: (item: Item, ctx: ItemContext, index: number) => void | Promise<void>): Promise<void>;

  output(items: Item | Item[]): NodeOutput;

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
```

**実行単位**

- 既定では、ノードの `execute` は **入力 run ごとに 1 回**呼ばれる。入力 Item 全量が `ctx.items` に入る。
- これは n8n と同じモデルで、Merge / Aggregate / Sort のように全 Item を見るノードに必要。
- Item ごとに設定を変えるノードは `ctx.each()` か `ctx.param(name, i)` を使う。
- `settings.executeOnce` が true の場合は、最初の Item だけを対象にする。
- ノード作者が自分で `for` を書いてもよい。`ctx.each` は単なる糖衣。

**ノード実装例（HTTP Request）**

```ts
export const httpRequestNode: NodeType = {
  type: 'draflow.httpRequest',
  version: 1,
  meta: {
    label: 'HTTP Request',
    category: 'network',
    description: 'Makes an HTTP request and returns the response data',
    icon: 'globe',
  },
  ports: {
    inputs: [{ type: 'main', required: true }],
    outputs: [{ type: 'main' }],
  },
  parameters: [
    {
      name: 'method',
      label: 'Method',
      type: 'select',
      default: 'GET',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((value) => ({ label: value, value })),
    },
    {
      name: 'url',
      label: 'URL',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://api.example.com/items',
    },
    {
      name: 'responseFormat',
      label: 'Response Format',
      type: 'select',
      default: 'json',
      options: [
        { label: 'JSON', value: 'json' },
        { label: 'Text', value: 'text' },
      ],
    },
  ],
  async execute(ctx) {
    const output: Item[] = [];

    await ctx.each(async (item, itemCtx, index) => {
      const url = itemCtx.param<string>('url');
      const method = itemCtx.param<string>('method');
      const format = itemCtx.param<string>('responseFormat');

      const response = await ctx.helpers.fetch(url, { method, signal: ctx.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const json = format === 'json' ? await response.json() : { text: await response.text() };
      output.push({ json, pairedItem: { item: index } });
    });

    return output;
  },
};
```

**設計意図**

- n8n の `this.getNodeParameter(name, itemIndex)` のような **index 引数地獄** をなくす。既定は 0 番目、Item ごとなら `ItemContext`。
- `helpers.fetch` はホスト注入。ブラウザの CORS、SSRF、プロキシをホストが制御できる。
- `credentials` は読み取り専用。Draflow は秘密を保存しない。
- `AbortSignal` を必ず渡す。キャンセルとタイムアウトをノード作者が尊重できる。

### 6.6 標準ノード（v1）

| カテゴリ | ノード | 備考 |
| --- | --- | --- |
| Trigger | Manual | エディタの実行ボタン |
| Trigger | Schedule | interval + cron（ランタイム） |
| Trigger | Webhook | テスト URL + 本番 URL |
| Trigger | Execute Workflow | サブワークフロー |
| Core | HTTP Request | fetch、クエリ、ヘッダー、ボディ、基本認証 |
| Core | Code | ホストの `codeRunner` がある場合のみ |
| Core | No Operation | 通過 |
| Transform | Edit Fields (Set) | フィールド追加・削除・型変換 |
| Transform | Filter | 条件に合う Item だけ通す |
| Transform | Sort | 複数キー |
| Transform | Limit | 件数制限 |
| Transform | Split Out | 配列を Item に展開 |
| Transform | Aggregate | Item を配列に集約 |
| Flow | If | 2 出力 |
| Flow | Switch | N 出力 |
| Flow | Merge | 3 モード（append / merge by key / choose branch） |
| Flow | Wait | ホストのスケジューラに委譲 |
| Flow | Loop Over Items | v1.1（まずは Split In Batches なし） |

**v1 で入れない**: Slack, Google Sheets, Notion, OpenAI, etc. これらは v2 以降、またはサードパーティのノードパッケージとして提供する。

---

## 7. 式エンジン

### 7.1 方針

- **デフォルトは安全な JS サブセット**。`eval` / `new Function` を使わない。
- 構文は n8n に寄せる。`{{ }}`、`$json`、`$node`、`$('Name')`、Luxon 風の日付メソッド。
- 1 つの式を **AST にコンパイルしてキャッシュ**。評価はツリーウォーク。
- ホストが `expressionEvaluator` を注入すれば、フル JS（n8n 互換）に差し替えられる。

### 7.2 文法（v1）

```text
expression   := ternary
ternary      := nullish ('?' expression ':' expression)?
nullish      := or ('??' or)*
or           := and ('||' and)*
and          := equality ('&&' equality)*
equality     := relational (('=='|'!='|'==='|'!==') relational)*
relational   := additive (('<'|'<='|'>'|'>='|'in') additive)*
additive     := multiplicative (('+'|'-') multiplicative)*
multiplicative := unary (('*'|'/'|'%') unary)*
unary        := ('!'|'-'|'+') unary | postfix
postfix      := primary (('.' IDENT | '[' expression ']' | '(' args ')')*
primary      := NUMBER | STRING | 'true' | 'false' | 'null' | 'undefined'
              | '[' elements ']' | '{' properties '}'
              | IDENT | '$' IDENT | '$' '(' expression ')' | '(' expression ')'
              | arrow
arrow        := IDENT '=>' expression | '(' IDENT (',' IDENT)* ')' '=>' expression
```

- 文（statements）、代入、`new`、`class`、`function` 宣言、`await` は禁止。
- アロー関数は **単一式のみ**。`map` / `filter` / `find` / `some` / `every` / `reduce` に渡せる。
- 三項演算子、テンプレートリテラルはサポート。
- オブジェクトリテラルのキーは識別子または文字列。

### 7.3 データプロキシ

| 変数 | 型 | 内容 |
| --- | --- | --- |
| `$json` | object | 現在の Item の JSON |
| `$binary` | object | 現在の Item のバイナリ参照 |
| `$item` | Item | 現在の Item |
| `$input.first()` | Item | 入力の先頭 |
| `$input.last()` | Item | 入力の末尾 |
| `$input.all()` | Item[] | 入力全部 |
| `$input.item` | Item | 現在の Item |
| `$('Name')` | NodeProxy | `.first()`, `.last()`, `.all()`, `.item`, `.json`, `.itemMatching(i)` |
| `$node['Name']` | NodeProxy | 旧式互換 |
| `$now` | DateTime | 現在時刻 |
| `$today` | DateTime | 今日 00:00 |
| `$vars` | object | ホスト提供の読み取り専用変数 |
| `$execution` | object | `id`, `mode` |
| `$workflow` | object | `id`, `name` |
| `$parameter` | object | 現在のノードのパラメータ |
| `$env` | object | ホスト提供（任意） |
| `$runIndex` | number | 実行 index |
| `$itemIndex` | number | Item index |

### 7.4 拡張関数

すべて **メソッド呼び出し** として実装する。プロトタイプは汚さない。

```ts
const stringFns = {
  toUpperCase, toLowerCase, trim, split, replace, replaceAll,
  includes, startsWith, endsWith, slice, substring, padStart, padEnd,
  toNumber, toBoolean, toJsonString, parseJson,
  base64Encode, base64Decode, urlEncode, urlDecode,
  isEmail, isUrl, isNumeric, isEmpty,
  toSentenceCase, toSnakeCase, toTitleCase,
  extractEmail, extractDomain, extractUrl, hash,
};

const arrayFns = {
  first, last, length, isEmpty, compact, unique, sum, min, max, average,
  chunk, flatten, join, reverse, sort, pluck, merge, difference, intersection, union,
};

const objectFns = {
  keys, values, hasField, removeField, keepFieldsContaining, toJsonString,
};

const numberFns = { round, floor, ceil, abs, isInteger, isEven, isOdd, format };

const dateFns = {
  format, plus, minus, diffTo, diffToNow, beginningOf, endOfMonth,
  isWeekend, isDst, isBetween, toISO,
};
```

### 7.5 日付

- `Date` + `Intl.DateTimeFormat` で実装。Luxon は使わない。
- `DateTime` は不変オブジェクト。`timezone` を持つ。
- `format('yyyy-MM-dd')` はトークン置換で実装。
- `plus({ days: 1 })` / `minus({ hours: 2 })` は ms 演算 + タイムゾーン再計算。
- DST の境界は `Intl` の offset を使って補正する。

### 7.6 セキュリティ

- 禁止識別子: `__proto__`, `prototype`, `constructor`, `globalThis`, `window`, `document`, `process`, `require`, `import`, `eval`, `Function`, `Reflect`, `Proxy`.
- プロパティアクセスは **own property のみ**（`Object.hasOwn`）。プロトタイプチェーンを辿らない。
- 配列長・文字列長・AST ノード数に上限（例: 10,000 / 100,000 / 500）。
- 評価ステップ数に上限（例: 100,000）。超過は `ExpressionLimitError`。
- エラーメッセージに位置情報（offset）を含める。

### 7.7 評価モード

| 入力 | 出力 |
| --- | --- |
| `"hello"` | 文字列のまま |
| `"={{ 1 + 2 }}"` | 数値 `3` |
| `"=Hello {{ $json.name }}"` | 文字列 |
| `"={{ $json.items }}"` | 配列（型保持） |
| `"={{ $json.a }} {{ $json.b }}"` | 文字列連結 |

n8n と同じく、**式が 1 つだけで前後に文字がない場合は型を保持**する。

---

## 8. 実行エンジン

### 8.1 状態

```ts
interface RunState {
  runId: string;
  status: 'running' | 'success' | 'error' | 'canceled' | 'waiting';
  stack: ExecEntry[];
  waiting: Map<string, Map<number, WaitingEntry>>;
  runData: RunData;
  pinData: Record<string, Item[]>;
  context: Record<string, JsonObject>;
  startedAt: number;
  stoppedAt?: number;
  error?: SerializedError;
  executionIndex: number;
}
```

### 8.2 ループ

```ts
async function execute(state: RunState, host: ExecutionHost): Promise<void> {
  while (state.stack.length > 0 || promoteWaiting(state)) {
    if (state.canceled) break;
    if (host.clock.now() - state.startedAt > timeout) {
      state.status = 'canceled';
      break;
    }

    const entry = state.stack.shift()!;
    const node = workflow.node(entry.nodeId);
    if (node.disabled) {
      route(state, node, entry.input, entry.runIndex);
      continue;
    }

    const started = host.clock.now();
    const task: TaskData = { ... };
    emit('node:start', ...);

    let output: PortData | undefined;
    let error: SerializedError | undefined;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      try {
        output = await executeNode(node, entry, state, host);
        break;
      } catch (e) {
        error = serializeError(e);
      }
    }

    task.executionTime = host.clock.now() - started;
    task.output = output;
    task.error = error;
    task.status = error ? 'error' : 'success';
    state.runData[node.id] ??= [];
    state.runData[node.id][entry.runIndex] = task;

    emit('node:finish', task);

    if (error && node.settings?.onError === 'stop') {
      state.status = 'error';
      state.error = error;
      break;
    }

    route(state, node, output ?? passthrough(entry.input), entry.runIndex);
  }

  state.status = state.status === 'running' ? 'success' : state.status;
  state.stoppedAt = host.clock.now();
  emit('run:finish', ...);
}
```

### 8.3 ルーティングと待機

- 出力ポート `p` の Item を、そのポートに接続された下流ノードへ送る。
- 下流に入力が 1 つだけなら即スタックへ。
- 入力が複数（Merge）なら `waiting[target][runIndex][port]` に蓄積。
- すべての `required` 入力が揃ったらスタックへ。
- `runIndex` は「同じノードが何回目か」。ループや複数回実行で増える。

### 8.4 エラー

| 設定 | 挙動 |
| --- | --- |
| `onError: 'stop'` | 実行停止。`runData` にエラーを記録 |
| `onError: 'continue'` | 入力 Item をそのまま下流へ |
| `onError: 'errorOutput'` | エラー Item を `error` ポートへ。`stop` しない |

- エラー Item は `json.error` と `error` の両方を持つ。
- リトライは `maxTries` 回。`waitBetweenTries` は `AbortSignal` で中断可能。
- 実行全体のタイムアウトは `settings.executionTimeout`。

### 8.5 ピンと部分実行

- `pinData[nodeId]` があれば、そのノードは実行せず固定 Item を出力する。
- 部分実行は次のアルゴリズム:
  1. destination から上流を BFS。
  2. `runData` があり、入力ハッシュとパラメータハッシュが変わっていないノードは再利用。
  3. `dirtyNodeIds` とその下流を実行対象にする。
  4. 実行対象の境界を `startNodes` としてスタックに積む。
- v1 は「destination まで」「選択ノードだけ」の 2 種類。n8n の完全な dirty 追跡は v1.1。

### 8.6 制限

- 1 実行あたりの Item 数: `maxItemsPerNode`（既定 10,000）。
- 1 実行あたりのノード実行回数: 10,000。
- 1 実行あたりの時間: 既定 5 分（設定可能）。
- 実行データのサイズ: 既定 10 MB（ホストで調整）。

---

## 9. ランタイムとトリガー

### 9.1 実行ホスト（ポート）

```ts
export interface RuntimePorts {
  fetch: FetchLike;
  clock: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
  random(): number;
  uuid(): string;
  storage: WorkflowStore & ExecutionStore;
  credentials: CredentialProvider;
  codeRunner?: CodeRunner;
  scheduler?: Scheduler;
  webhooks?: WebhookRegistry;
  logger?: Logger;
}
```

すべて任意。ブラウザでは `fetch` / `clock` / `uuid` だけでも動く。本番トリガーには `scheduler` と `webhooks` が必要。

### 9.2 トリガーの種類

| 種類 | ブラウザ | Node サーバー |
| --- | --- | --- |
| Manual | ○ | ○ |
| Schedule（interval） | △（タブが開いている間） | ○ |
| Schedule（cron） | × | ○ |
| Webhook（テスト） | × | ○ |
| Webhook（本番） | × | ○ |
| Execute Workflow | ○ | ○ |
| Poll（ホストイベント） | △ | ○ |

### 9.3 トリガー管理

```ts
interface TriggerManager {
  activate(workflow: Workflow): Promise<void>;
  deactivate(workflowId: string): Promise<void>;
  isActive(workflowId: string): boolean;
  list(): Array<{ workflowId: string; nodeId: string; type: string }>;
}
```

- アクティベーション時に trigger node を登録。
- 失敗時は部分的に登録したトリガーをロールバック。
- Webhook は `WebhookRegistry` にパス → ワークフローのマップを登録。
- スケジュールは `Scheduler` に cron / interval を登録。
- 実行は `ExecutionEngine` に渡す。

### 9.4 Webhook

```ts
interface WebhookRegistry {
  register(input: {
    workflowId: string;
    nodeId: string;
    method: string;
    path: string;
    test: boolean;
  }): Promise<void>;
  unregister(workflowId: string): Promise<void>;
  handle(request: WebhookRequest): Promise<WebhookResponse>;
}
```

- テスト URL: `/webhook-test/:workflowId/:nodeId`
- 本番 URL: `/webhook/:path`
- レスポンスモード: `onReceived` / `lastNode` / `responseNode`
- 署名検証、レート制限、ボディサイズ制限はホストの責務。

### 9.5 スケジューラ

- `Scheduler` は `setInterval` ベースの最小実装を同梱。
- cron は 5 フィールド（分 時 日 月 曜日）のサブセットを自前パーサで実装。
- タイムゾーンは `Intl` で計算。
- Node サーバーでは `setTimeout` のドリフト補正を行う。

---

## 10. エディタ UI アーキテクチャ

### 10.1 レイヤー

```text
<draflow-editor> (Shadow DOM)
├── Toolbar          (workflow name, run, stop, publish, menu)
├── Canvas           (SVG edges + DOM nodes + selection box + minimap?)
├── NodeCreator      (floating panel)
├── NDV              (modal: input | parameters | output)
├── LogsPanel        (bottom)
├── CommandPalette   (modal)
└── Toasts
```

### 10.2 状態

```ts
interface EditorState {
  workflow: Workflow;
  nodeTypes: Map<string, NodeType>;
  selection: Set<string>;
  viewport: { x: number; y: number; zoom: number };
  activeNodeId: string | null;
  panels: { logs: boolean; creator: boolean; ndv: boolean };
  run: { status: 'idle' | 'running' | 'success' | 'error'; runData: RunData };
  history: History;
  dirty: boolean;
}
```

- 単一の `EditorStore`。変更は `dispatch(command)` を通す。
- 変更後は `requestAnimationFrame` で 1 回だけ再描画。
- キャンバスのドラッグ中は DOM の `transform` を直接更新し、状態へのコミットは pointerup 時。

### 10.3 キャンバス

- **ノード**: 絶対配置の DOM カード。`transform: translate(x, y)`。
- **エッジ**: `<svg>` の `<path>`。ベジェ曲線。`pointer-events: stroke`。
- **ワールド**: `transform: translate(vx, vy) scale(z)`。ドットグリッドは CSS 背景。
- **パン**: 中ボタン / Space + ドラッグ / 背景ドラッグ。
- **ズーム**: ホイール + Ctrl/Cmd、または +/- ボタン。0.1〜2.0。
- **接続**: 出力ハンドルからドラッグ。入力ハンドルでドロップ。型が合わない場合は拒否。
- **選択**: クリック、Shift+クリック、矩形選択。
- **ドラッグ**: 複数選択をまとめて移動。16px グリッドにスナップ。
- **挿入**: エッジの上にノードをドロップすると、`source → new → target` に付け替え。
- **状態**: 成功（緑）、失敗（オレンジ）、実行中（パルス）、無効（グレー）、ピン（ピンアイコン）。
- **バッジ**: エッジ上に Item 数。ノードの下に設定要約。
- **Tidy Up**: 自前の層状レイアウト。
- **グループ**: 矩形 + ラベル。折りたたみ。
- **スティッキーノート**: 付箋。色選択。

### 10.4 Node Creator

- トリガー選択と通常追加の 2 モード。
- 検索は自前のファジーマッチ（部分一致 + スコア）。
- カテゴリ、人気、最近、アクション。
- キーボード: ↑↓ で移動、Enter で決定、Esc で閉じる。
- ノードを選ぶと、`resource` / `operation` の組み合わせからアクションを生成。
- 追加時は直前のノードと自動接続。既存エッジの途中なら挿入。

### 10.5 NDV

- 3 ペイン。ドラッグで幅を調整。モバイルではタブ。
- Input: 上流ノードのスキーマ。検索、Schema/Table/JSON。
- Parameters: 動的フォーム。`Fixed | Expression` 切替。`Execute step`。
- Output: テーブル。ピン。Item 数。
- Settings: Duplicate / Always Output / Execute Once / Retry / On Error / Notes / Version。
- ノード名のインライン編集。
- フォーカストラップ、Esc で閉じる、元のフォーカスに戻す。

### 10.6 データマッピング

- Input/Output のフィールドを **Pointer Events** でドラッグ。
- ドロップ可能なパラメータをハイライト。
- ドロップ時に `{{ $json.field }}` または `{{ $('Name').item.json.field }}` を挿入。
- 既存値がある場合は追記。テキストなら `=text {{ ... }}`。
- `requiresDataPath` のパラメータはパス文字列のみ。
- 式モードに自動で切り替え、結果プレビューを表示。

### 10.7 式エディタ

- インライン: textarea + `fx` バッジ + 結果プレビュー。
- モーダル: 左にフィールドツリー、中央に式、右に結果。
- オートコンプリート: `$json.`、`$('`、拡張関数。
- 構文ハイライトは自前のトークナイザ（文字列・数値・識別子・演算子・コメント）。
- エラーは位置付きで表示。

### 10.8 Logs と実行一覧

- Logs: 実行サマリー、ノードツリー、選択ノードの Input/Output/Actions。
- 実行中はイベントでストリーミング更新。
- Executions: 一覧、フィルタ、Auto refresh、読み取り専用キャンバス、Copy to editor。
- 実行データの保持は `ExecutionStore` の責務。

### 10.9 Undo / Redo

- コマンドパターン:
  - `AddNode`, `RemoveNode`, `MoveNodes`, `Connect`, `Disconnect`
  - `SetParameter`, `RenameNode`, `ToggleDisabled`, `PinData`
  - `GroupNodes`, `AddSticky`, `Bulk`
- パラメータ変更は 300ms で coalesce。
- 履歴は 100 ステップ。
- Undo 時に式の参照名も一貫して戻す。

### 10.10 テーマとアクセシビリティ

- CSS カスタムプロパティ。`theme="light|dark|auto"`。
- システムフォント。外部フォントなし。
- アイコンはインライン SVG（Lucide 風のパスを自前で持つ）。
- `prefers-reduced-motion` を尊重。
- 色だけで状態を伝えない。
- キャンバスはキーボードで全ノードに到達可能。
- NDV は `role="dialog"`、`aria-modal="true"`。

### 10.11 SSR

- `HTMLElement` が存在しない環境では `class {}` を基底にする（Nobita と同じ）。
- `customElements.define` は `typeof window !== 'undefined'` のときだけ。

---

## 11. 永続化と資格情報

### 11.1 ストレージ

```ts
export interface WorkflowStore {
  list(): Promise<WorkflowSummary[]>;
  load(id: string): Promise<Workflow | null>;
  save(workflow: Workflow): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ExecutionStore {
  append(execution: ExecutionRecord): Promise<void>;
  list(workflowId: string, options?: { limit?: number }): Promise<ExecutionSummary[]>;
  load(id: string): Promise<ExecutionRecord | null>;
  delete(id: string): Promise<void>;
  prune(options: { keep: number }): Promise<void>;
}
```

同梱アダプタ:

| アダプタ | 環境 |
| --- | --- |
| `MemoryStore` | テスト・プレビュー |
| `LocalStorageStore` | ブラウザ（小規模） |
| `IndexedDbStore` | ブラウザ（大規模） |
| `HttpStore` | ホスト API |
| `SqliteStore` | Node 22+（`node:sqlite`） |

### 11.2 資格情報

```ts
export interface CredentialProvider {
  get(id: string): Promise<Record<string, string> | null>;
  list(type: string): Promise<CredentialSummary[]>;
}
```

- Draflow は秘密を保存しない。
- ノードは `ctx.credentials.get('slot')` で取得。
- ホストが暗号化・監査・ローテーションを担当。
- デモでは `.env` またはローカル暗号化ストアを使う。

### 11.3 実行データ

- 実行レコードは `{ id, workflowId, status, mode, startedAt, stoppedAt, runData, workflowSnapshot }`。
- `runData` はサイズ上限を持つ。超過時は古い Item を切り捨て、`truncated: true` を立てる。
- バイナリは保存しない。`BinaryRef` のみ。

---

## 12. パフォーマンス予算

| 項目 | 目標 |
| --- | ---: |
| `core`（min+gzip） | 45 KB |
| 式エンジン | 15 KB |
| `nodes`（v1 標準） | 20 KB |
| `runtime` | 15 KB |
| `element`（キャンバス + NDV + Creator + Logs） | 120 KB |
| 合計 | **215 KB** |

**実測（Phase 1 完了時点）**: core 37.8 KB gzip + nodes 8.0 KB gzip = **45.8 KB gzip**。
（`pnpm size` で計測。ファイルごとの gzip 合計なので保守的。）
| 初回描画（50 ノード） | < 100ms |
| パン/ズーム（200 ノード / 500 エッジ） | 60fps |
| 式評価（典型） | < 0.1ms |
| エンジン overhead | < 1ms / node |
| メモリ（10k Item） | < 50 MB |

**測定方法**

- `scripts/size-report.mjs` で gzip サイズを CI で記録。
- `scripts/benchmark.mjs` で式評価・エンジン・レイアウトを測定。
- Playwright でキャンバスの FPS と初回描画を測定。

---

## 13. テスト

| 層 | ツール | 内容 |
| --- | --- | --- |
| core | Vitest | スキーマ、グラフ、式、エンジン、部分実行 |
| nodes | Vitest | fetch / clock / credentials のモック |
| runtime | Vitest | トリガー、スケジューラ、Webhook |
| element | Playwright | キャンバス、NDV、マッピング、Undo、a11y |
| public API | `tsc -p tsconfig.public-api.json` | 公開型の破壊検出 |
| size | 自作スクリプト | gzip サイズの予算チェック |
| bench | 自作スクリプト | 式・エンジン・レイアウト |

テスト用のフィクスチャ:

- n8n の実ワークフロー JSON（手動トリガー + HTTP + Set）を `tests/fixtures/` に置く。
- 式のスナップショット（`$json`, `$node`, 日付、配列）。
- 実行データのスナップショット。

---

## 14. マイルストーン

### Phase 0: 足場（1〜2 日）

- pnpm workspace、TS 7.0.2、`tsc -b`、Vitest、Playwright、esbuild。
- `tsconfig.base.json`（Nobita と同じ厳しめ設定）。
- `customConditions: ["draflow-source"]`。
- public API 型テスト。
- サイズレポート。

**完了条件**: `pnpm typecheck && pnpm test && pnpm build` が通る。

### Phase 1: コア（1〜2 週間）

- `Workflow` / `Node` / `Connection` / `Item` / `RunData` 型。
- グラフ（上流・下流・トポロジカル順・サイクル検出）。
- 式エンジン（lexer / parser / evaluator / functions / date）。
- 実行エンジン（stack / waiting / retry / error / pin / partial）。
- 標準ノード 5 個（Manual, Set, If, Merge, HTTP）。
- 単体テスト。

**完了条件**: JSON ワークフローを読み込み、手動実行し、RunData を返せる。

### Phase 2: エディタ MVP（2〜3 週間）

- `<draflow-editor>`、Shadow DOM、テーマ。
- キャンバス（ノード、エッジ、パン、ズーム、選択、ドラッグ、接続）。
- Node Creator（検索、カテゴリ、トリガー選択）。
- NDV（3 ペイン、フォーム、実行、出力テーブル）。
- Logs。
- Undo / Redo。
- 永続化アダプタ。

**完了条件**: ブラウザでワークフローを作成・実行・保存できる。

### Phase 3: ランタイム（1〜2 週間）

- `runtime` パッケージ。
- Scheduler（interval / cron）。
- Webhook（テスト / 本番）。
- TriggerManager。
- 資格情報アダプタ。
- Node サーバー（`apps/server`、`node:http`、`node:sqlite`）。

**完了条件**: サーバーで Webhook / スケジュール実行が動く。

### Phase 4: 操作感の仕上げ（1〜2 週間）

- ドラッグマッピング。
- 式エディタのオートコンプリート / プレビュー。
- ピン / 部分実行 / 実行リプレイ。
- Tidy Up、グループ、スティッキーノート。
- コマンドパレット。
- キーボードショートカット。
- アクセシビリティ。

**完了条件**: n8n の主要操作をマウスとキーボードで再現できる。

### Phase 5: 埋め込みと配布（1 週間）

- React ラッパー。
- n8n JSON インポータ（サブセット）。
- デモ、ドキュメント、ベンチマーク。
- サイズ予算の確認。

**完了条件**: `<draflow-editor>` を 1 行で埋め込める。gzip 215 KB 以下。

---

## 15. 未決事項

実装前に決めるべきこと:

1. **v1 の形**: エディタライブラリだけか、スタンドアロンアプリ（サーバー付き）か。
   - 推奨: ライブラリ + デモ。サーバーは Phase 3。
2. **実行場所**: ブラウザのみか、Node サーバーも必須か。
   - 推奨: コアは両対応。本番トリガーは Node。
3. **式**: 安全サブセットか、n8n 互換のフル JS か。
   - 推奨: サブセット + ホスト注入。
4. **n8n 互換**: JSON import/export を v1 に入れるか。
   - 推奨: v1.1。まずは独自スキーマ。
5. **ノードセット**: どの統合を最初に入れるか。
   - 推奨: HTTP / Set / If / Merge / Filter / Sort / Limit / Split Out / Aggregate / Manual / Schedule / Webhook / Execute Workflow。
6. **認証情報**: 内蔵ストアを持つか、ホスト委譲か。
   - 推奨: ホスト委譲。デモのみローカル暗号化。
7. **i18n**: 英語のみか、日本語も入れるか。
   - 推奨: en / ja の 2 言語。キーは小さく保つ。
8. **ビジュアル**: n8n 風か、独自ブランドか。
   - 推奨: 独自。レイアウトと操作は n8n 風、色・タイポグラフィは Draflow。

---

## 16. やらないこと（再掲）

- 1,000 ノードの移植。
- フル JS 式のデフォルト有効化。
- サーバーなしでの本番 Webhook / cron。
- マルチテナント / RBAC / SSO。
- コラボレーション / CRDT。
- 大規模 i18n / テレメトリ / 実験フラグ。
- n8n のコード・CSS・アイコンのコピー。

---

## 17. 参考: Nobita から借りる型

| Nobita のパターン | Draflow での適用 |
| --- | --- |
| `packages/core` は純粋、`element` は Web Component | `@draflow/core` + `@draflow/element` |
| `nobita-source` カスタム条件 | `draflow-source` |
| `tsc -b` + project references | 同じ |
| esbuild で ESM + IIFE | 同じ |
| Shadow DOM + CSS 変数 | 同じ |
| JSON in / JSON out | Workflow JSON |
| `onChange(doc, meta)` | `onChange(workflow, meta)` |
| ホストアダプタ（upload, mention, page） | `ports`（fetch, storage, credentials, codeRunner） |
| 公開 API 型テスト | `tsconfig.public-api.json` |
| サイズレポート / ベンチマーク | 同じ |
| React ラッパーはホスト要素だけ管理 | 同じ |

---

## 18. 最初の 1 週間でやること（提案）

1. リポジトリの足場を作る（pnpm、TS 7.0.2、Vitest、Playwright、esbuild）。
2. `@draflow/core` の型とグラフを書く。
3. 式エンジンの最小版（`$json`、演算子、三項、配列/オブジェクト）を書く。
4. 実行エンジンの最小版（Manual → Set → If → Merge）を書く。
5. JSON ワークフローを実行する CLI テストを書く。
6. その結果を `docs/` に記録し、UI の設計に進む。

この順序なら、**UI を作る前にエンジンの正しさを固められる**。
