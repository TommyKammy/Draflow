# 実装状況 — コアエンジン

- 更新日: 2026-11-26
- 状態: **Phase 0（足場）+ Phase 1（コア）完了**
- 次の milestone: エディタ UI（キャンバス / Node Creator / NDV / Logs）

---

## 1. できていること

| 領域 | 内容 |
| --- | --- |
| スキーマ | `Workflow` / `WorkflowNode` / `Connection` / `Item` / `TaskData` / `RunData` |
| グラフ | 上流・下流、トポロジカル順、サイクル検出、到達判定 |
| 式 | 字句解析、構文解析、評価、`{{ }}` テンプレート、データプロキシ、拡張関数、日付 |
| 実行 | スタック、waiting（複数入力）、runIndex、リトライ、エラー 3 モード、ピン、無効化、executeOnce、部分実行、実行制限 |
| ノード | Manual / NoOp / Set / If / Filter / Merge / HTTP Request |
| 永続化 | JSON の読み書き、検証、デフォルト適用 |
| テスト | 85 tests（core 63 / nodes 22） |
| サイズ | core 37.3 KB gzip + nodes 7.9 KB gzip = **45.2 KB gzip** |

---

## 2. パッケージ

```text
packages/
  core/    @draflow/core    型、グラフ、式、実行、検証、シリアライズ
  nodes/   @draflow/nodes   標準ノード 7 個
```

依存関係:

```text
@draflow/nodes → @draflow/core
```

ランタイム依存はゼロ。開発時のみ TypeScript 7.0.2 / Vitest 3.2.7。

---

## 3. 使い方

### 3.1 ワークフローを組み立てる

```ts
import {
  ExecutionEngine,
  NodeRegistry,
  createConnection,
  createNode,
  createWorkflow,
} from '@draflow/core';
import { standardNodes } from '@draflow/nodes';

const registry = new NodeRegistry().registerAll(standardNodes);
const engine = new ExecutionEngine({ registry });

const manual = createNode({
  id: 'manual',
  type: 'draflow.manualTrigger',
  name: 'Manual',
  position: { x: 0, y: 0 },
});

const set = createNode({
  id: 'set',
  type: 'draflow.set',
  name: 'Set',
  position: { x: 220, y: 0 },
  parameters: {
    mode: 'manual',
    includeOtherFields: false,
    assignments: [
      { name: 'greeting', value: '=Hello {{ $json.name }}' },
      { name: 'length', value: '={{ $json.name.length }}' },
    ],
  },
});

const workflow = createWorkflow({
  name: 'Example',
  nodes: [manual, set],
  connections: [
    createConnection(
      { node: 'manual', port: 'main', index: 0 },
      { node: 'set', port: 'main', index: 0 },
    ),
  ],
});

const result = await engine
  .run(workflow, { triggerData: { main: [[{ json: { name: 'Draflow' } }]] } })
  .done;

console.log(result.status);
console.log(result.runData.set?.[0]?.output?.main?.[0]?.[0]?.json);
// { greeting: 'Hello Draflow', length: 7 }
```

### 3.2 実行イベントを購読する

```ts
const run = engine.run(workflow);

run.on('node:start', (event) => {
  console.log('start', event.nodeName, event.runIndex);
});
run.on('node:finish', (event) => {
  console.log('finish', event.nodeName, event.task.status, event.task.executionTime);
});
run.on('run:finish', (event) => {
  console.log('done', event.result.status);
});

await run.done;
```

### 3.3 部分実行

```ts
const result = await engine
  .run(workflow, {
    destinationNodeId: 'set',
    destinationMode: 'inclusive',
  })
  .done;
```

- `inclusive`: 指定ノードまで実行する。
- `exclusive`: 指定ノードの手前まで実行する。
- `runData` と `dirtyNodeIds` を渡すと、変更されていない上流を再利用する。

### 3.4 ピン

```ts
const result = await engine
  .run(workflow, {
    pinData: {
      set: [{ json: { pinned: true } }],
    },
  })
  .done;
```

ピンされたノードは実行されず、固定 Item が下流に流れる。

---

## 4. 式エンジン

### 4.1 構文

- パラメータ値が `=` で始まる場合だけ式モード。
- `={{ 1 + 2 }}` は型を保持（数値 `3`）。
- `=Hello {{ $json.name }}` は文字列補間。
- `={{ }}` が 1 つだけで前後に文字がなければ、値の型を保持。

### 4.2 使えるもの

| 種類 | 例 |
| --- | --- |
| 現在の Item | `$json`, `$binary`, `$item`, `$itemIndex` |
| 入力 | `$input.first()`, `$input.last()`, `$input.all()`, `$input.item` |
| ノード参照 | `$('Node').first()`, `$node.Node.json`, `$items('Node')` |
| コンテキスト | `$now`, `$today`, `$vars`, `$execution`, `$workflow`, `$parameter`, `$env`, `$runIndex` |
| 演算子 | `+ - * / %`, `== != === !==`, `< <= > >=`, `&& \|\| ??`, `? :`, `in`, `!` |
| 配列 | `map`, `filter`, `find`, `some`, `every`, `reduce`, `flat`, `sort`, `unique`, `sum`, `average`, `chunk`, `pluck`, `merge` |
| 文字列 | `toUpperCase`, `toLowerCase`, `trim`, `split`, `replace`, `includes`, `startsWith`, `endsWith`, `slice`, `padStart`, `toNumber`, `toJsonString`, `parseJson`, `base64Encode`, `isEmail`, `isUrl` |
| オブジェクト | `keys`, `values`, `hasField`, `removeField`, `keepFieldsContaining`, `toJsonString` |
| 数値 | `round`, `floor`, `ceil`, `abs`, `isInteger`, `isEven`, `isOdd`, `format` |
| 日付 | `format`, `plus`, `minus`, `diffTo`, `diffToNow`, `beginningOf`, `endOfMonth`, `isWeekend`, `isDst`, `isBetween` |
| グローバル | `Math.*`, `JSON.parse/stringify`, `Number`, `String`, `Boolean`, `Array.isArray`, `parseInt`, `parseFloat`, `encodeURIComponent` |

### 4.3 安全性

- `eval` / `new Function` を使わない。
- `globalThis` / `window` / `document` / `process` / `require` / `constructor` / `__proto__` を拒否。
- プロパティは own property のみ。
- ステップ数・深さに上限。
- ホストがフル JS 評価器を注入する差し替え口は今後追加する（`ExpressionEngine` のインターフェース化）。

---

## 5. ノード

### Manual Trigger

- 入力なし。1 Item を出力。
- `triggerData` で初期データを渡せる。

### No Operation

- 入力をそのまま出力。

### Edit Fields (Set)

- モード: Manual Mapping / JSON
- フィールド名はドット記法でネスト可能（`a.b`）。
- 型: Auto / String / Number / Boolean / JSON
- `includeOtherFields` で入力フィールドを残すか選べる。

### If

- 条件は AND / OR。
- 演算子: equals, notEquals, contains, notContains, startsWith, endsWith, regex, gt, gte, lt, lte, isEmpty, isNotEmpty, isTrue, isFalse, exists, notExists。
- 2 出力（True / False）。

### Filter

- 条件に合う Item だけ出力。
- If と同じ条件モデル。

### Merge

- Append / Merge By Key / Choose Branch
- Merge By Key は Inner / Left / Outer。
- キーはドット記法。

### HTTP Request

- Method / URL / Headers / Body / Response Format / Timeout
- `ctx.helpers.fetch` 経由。ホストが CORS・SSRF・プロキシを制御できる。
- JSON / Text レスポンス。
- 非 2xx はノードエラー。

---

## 6. 実行セマンティクス

| 機能 | 実装 |
| --- | --- |
| 複数入力の待機 | `waiting` + `queued`。全 required 入力が揃うまで待つ |
| ファンイン | 同じ入力ポートへの複数接続を 1 回の実行にマージ |
| runIndex | 同じノードの実行回数。ループ・複数回実行を区別 |
| リトライ | `retryOnFail`, `maxTries`（2〜5）, `waitBetweenTries`（0〜5000ms） |
| エラー | `stop` / `continue` / `errorOutput` |
| ピン | ノードを実行せず固定出力 |
| 無効化 | 入力をそのまま通過 |
| executeOnce | 2 回目以降は最初の出力を再利用 |
| 常時出力 | `alwaysOutputData` で空でも `{}` を 1 Item |
| 部分実行 | destination / runData 再利用 / dirtyNodeIds |
| 制限 | 最大ノード実行回数、最大 Item 数、実行タイムアウト |
| キャンセル | `AbortSignal` / `run.cancel()` |

---

## 7. テスト

```bash
pnpm test
```

```
✓ packages/core/test/utils.test.ts         (2)
✓ packages/core/test/graph.test.ts         (4)
✓ packages/core/test/parameters.test.ts    (5)
✓ packages/core/test/serialize.test.ts     (7)
✓ packages/core/test/expression.test.ts   (20)
✓ packages/core/test/engine.test.ts       (25)
✓ packages/nodes/test/nodes.test.ts       (22)
──────────────────────────────────────────────
85 tests passed
```

型チェック:

```bash
pnpm typecheck
```

`tsc -b`（TS 7.0.2）+ テスト用 `tsconfig.test.json`。

---

## 8. サイズ

```bash
pnpm build
pnpm size
```

```
package        files      raw       gzip
------------------------------------------
core              21  176.2 KB   37.3 KB
nodes              9   27.3 KB    7.9 KB
------------------------------------------
total                 203.4 KB   45.2 KB
```

gzip はファイルごとの gzip の合計（保守的な見積もり）。
設計目標の 250 KB に対して、コアは **45.2 KB**。

---

## 8.1 Codex レビュー対応

PR #1 のレビュー指摘 13 件、追加 9 件、追加 5 件、追加 4 件、追加 3 件、追加 4 件、追加 2 件、合計 40 件をすべて修正し、回帰テストを追加した。

| 指摘 | 対応 |
| --- | --- |
| Set のプロトタイプ汚染 | `__proto__` / `prototype` / `constructor` をパスで拒否 |
| 実行タイムアウトがノード実行中に効かない | 実行全体のタイマー + `AbortSignal` + `raceWithAbort` |
| `$("Node").item` が Filter 後に誤った Item を返す | `pairedItem` と `source` を辿る系譜解決 |
| Set が上流のネストデータを変更する | 入力 JSON をディープクローン |
| HTTP のタイムアウトが body 読み取り前に解除される | body 消費までタイマーと abort を維持 |
| `node:start` が通常実行で発火しない | 実行前にイベント発火 + 開始前の microtask |
| `onError: errorOutput` の動的 error 出力が検証で拒否される | 検証時に動的 error ポートを許可 |
| キャッシュ再生時に runIndex が 0 のまま | ノードごとの next runIndex を管理 |
| ピン Item の binary / pairedItem が消える | `parseItem` で保持 |
| `months` + `days` の日付計算で小さい単位が無視される | 暦計算後に残りの duration を加算 |
| 同じ型の入力で required が全 index に適用される | 入力定義ごとに required を判定 |
| 文字列リテラルの `)` / `]` が区切りとして消費される | トークン種別を区別 |
| 長さの違う fan-in が 1 回にマージされない | 複数接続の入力は stack が空になるまで待機 |

追加レビュー（2 回目）:

| 指摘 | 対応 |
| --- | --- |
| Set の代入値が二重に式評価される | `param('assignments')` の解決結果をそのまま使用 |
| replay 時に dirty ノードの古いタスクが残る | dirty ノードと下流のタスクを事前削除 + current run index を追跡 |
| Filter / If が `binary` を落とす | Item 全体を引き継ぐ |
| Date / DraflowDateTime が `{ timeZone }` や `{}` になる | `toJSON()` を尊重 |
| 204 / HEAD の bodyless JSON 応答が失敗する | 空 body を `{}` として処理 |
| `"2" <= 2` / `"2" >= 2` が false になる | inclusive 比較で一貫した数値変換 |
| optional chain の短絡が途中で切れる | チェーン全体で short-circuit を伝播 |
| `alwaysOutputData` が他出力を消す | 既存出力を保持し、全出力が空のときだけ placeholder |
| `Promise.reject(undefined)` が成功扱いになる | `failed` フラグで失敗を追跡 |

追加レビュー（3 回目）:

| 指摘 | 対応 |
| --- | --- |
| 空配列の pin が無視されてノードが実行される | pin の存在だけで実行をスキップ |
| Set が `binary` を落とす | Item の `binary` / `error` を引き継ぐ |
| 文字列・数値の日付変換が UTC 固定 | 式コンテキストのタイムゾーンを拡張メソッドへ渡す |
| loose 比較で `"false"` が true になる | boolean 文字列を明示的にパース |
| メンバー/呼び出しチェーンが評価予算を回避 | チェーン各ノードで steps / depth を加算 |

追加レビュー（4 回目）:

| 指摘 | 対応 |
| --- | --- |
| offset なし ISO がホストのタイムゾーンで解釈される | ワークフローのタイムゾーンで日時成分を構築 |
| Merge By Key が `binary` を落とす | matched / unmatched の全経路で binary を保持・結合 |
| 複数入力の 2 番目以降が item 上限を回避する | 全 input port / index を検査 |
| `CONTENT-TYPE` の大文字小文字で重複ヘッダーが付く | ヘッダー名を大文字小文字無視で確認 |

追加レビュー（5 回目）:

| 指摘 | 対応 |
| --- | --- |
| 空ブランチが Merge の入力として記録されない | 複数入力ノードでは空入力を完了として記録 |
| optional call が拡張メソッドを短絡する | 既知の拡張メソッドを判定してから短絡 |
| `__proto__` ノード ID が runData を汚染する | 危険なノード ID を検証・グラフ構築で拒否 |

追加レビュー（6 回目）:

| 指摘 | 対応 |
| --- | --- |
| pairedItem が上流の index を引き継ぎ系譜が壊れる | 各ノードの即時入力 index で pairing を構築し、resolver は source の出力 Item から辿る |
| `beginningOf("week")` が DST で誤った日付になる | ローカル暦の日付を月曜へ移動してから instant に変換 |
| 外部 abort listener が run 終了後も残る | 実行完了時に forwarding listener を解除 |
| displayOptions の短縮形 `{ gte: 2 }` が効かない | `_cnd` と短縮形の両方を正規化して評価 |

追加レビュー（7 回目）:

| 指摘 | 対応 |
| --- | --- |
| 同一入力ポートの fan-in で producer の系譜が上書きされる | item ごとに producer と producer 内 index を保持し、lineage 解決に使用 |
| `DateTime.now()` / `diffToNow()` が注入時計を無視する | expression context の now を DateTime と diffToNow に伝播 |

テストは 83 件から **85 件**に増えている。

## 9. デモ

```bash
pnpm build
node examples/run-workflow.mjs
```

出力:

```
status: success
duration: 11ms
manual: success (0ms, 1 items)
set: success (10ms, 1 items)
branch: success (0ms, 1 items)
yes: success (0ms, 1 items)
output: [
  {
    "json": {
      "greeting": "Hello Draflow",
      "length": 7,
      "result": "long enough"
    },
    "pairedItem": { "item": 0, "input": 0 }
  }
]
```

---

## 10. まだないもの

| 領域 | 状態 |
| --- | --- |
| エディタ UI | 未着手（Phase 2） |
| キャンバス / Node Creator / NDV / Logs | 未着手 |
| トリガー実行（cron / webhook / poll） | 未着手（Phase 3） |
| 認証情報ストア | インターフェースのみ |
| バイナリデータ | 型のみ（`BinaryRef`） |
| Code ノード | 未実装（ホストの `codeRunner` 前提） |
| サブワークフロー | 未実装 |
| n8n JSON インポート | 未実装 |
| React ラッパー | 未実装 |
| ブラウザ永続化 | 未実装 |

---

## 11. 次の作業

1. `@draflow/element` の足場（Shadow DOM、テーマ、イベント）。
2. ゼロ依存キャンバス（SVG エッジ + DOM ノード、パン / ズーム / ドラッグ / 接続）。
3. Node Creator（検索、カテゴリ、トリガー選択）。
4. NDV（3 ペイン、パラメータフォーム、実行、出力テーブル）。
5. Logs パネルと実行状態のストリーミング。
6. Undo / Redo。
7. 永続化アダプタ。
8. Playwright によるブラウザテスト。

UI に入る前に、`ExpressionEngine` のホスト差し替えインターフェースと、`NodeContext.resolve` の型を固める。
