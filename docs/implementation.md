# 実装状況 — コアエンジン

- 更新日: 2026-11-26
- 状態: **Phase 1（コア）完了、Phase 2 M5（Data パネル・ピン・マッピング）実装**
- 次の milestone: [M6 上流実行・停止・Logs](phase2-plan.md)

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
| テスト | 140 tests（Phase 1 完了時点、core 112 / nodes 28） |
| サイズ | core 38.5 KB gzip + nodes 8.1 KB gzip = **46.6 KB gzip** |

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
✓ packages/core/test/parameters.test.ts    (6)
✓ packages/core/test/serialize.test.ts     (8)
✓ packages/core/test/expression.test.ts   (58)
✓ packages/core/test/engine.test.ts       (34)
✓ packages/nodes/test/nodes.test.ts       (28)
──────────────────────────────────────────────
140 tests passed (Phase 1)
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
core              21  181.1 KB   38.5 KB
nodes              9   27.6 KB    8.1 KB
------------------------------------------
total                 208.7 KB   46.6 KB
```

gzip はファイルごとの gzip の合計（保守的な見積もり）。
設計目標の 250 KB に対して、コアは **46.6 KB**。

---

## 8.1 Codex レビュー対応

PR #1 のレビュー指摘 13 件、追加 9 件、追加 5 件、追加 4 件、追加 3 件、追加 4 件、追加 2 件、追加 3 件、追加 5 件、合計 48 件をすべて修正し、回帰テストを追加した。

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

追加レビュー（8 回目）:

| 指摘 | 対応 |
| --- | --- |
| Append / Choose Branch が上流 pairing を保持する | Merge 入力 index と位置で即時 pairing を再生成 |
| テンプレート内コメントの `}}` を終端と誤認する | line / block comment をスキャン時にスキップ |
| `split()` の separator 省略と limit が失われる | ネイティブの `split(separator, limit)` セマンティクスを保持 |

追加レビュー（9 回目）:

| 指摘 | 対応 |
| --- | --- |
| fan-in consumer が保留中の producer を待たない | 上流 producer が waiting / queued / stack にある間は promotion を保留 |
| displayOptions が schema default を無視する | 制御パラメータのデフォルトを解決して表示判定 |
| days / weeks が DST で時刻をずらす | ローカル暦の日付に加算してから instant に変換 |
| node:start 内の cancel 後もノードが実行される | イベント後に abort を再確認し、promise の rejection も observe |
| 小数の接続 index が検証を通る | 接続 index を非負整数として検証・パース |

テストは 88 件から **92 件**に増えている。

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
| エディタ UI | 埋め込み実行、キャンバス表示・編集、Undo / Redo、自動保存 |
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

## M1 canvas baseline

固定サイズのカードと SVG 配線を共通の座標系に置き、パン・ズーム時はワールドの transform を更新する。ノードのクリック・Shift 選択・矩形選択は `draflow-selection` の `detail.nodeIds` で取得できる。ホストは `fitView()` と `focusNode(id)` を呼び出せる。選択と表示位置の変更は workflow JSON に影響しない。

`pnpm build`、`pnpm exec playwright install chromium`、`pnpm bench:canvas` で再計測できる。以下は macOS arm64、headless Chromium 159.0.8154.6、1280 × 800、DPR 1 のローカル計測。フィクスチャは10列の固定配置で、近隣ノードへ決定的に配線する。

| 計測対象 | サンプル数 | 中央値 | p95 |
| --- | ---: | ---: | ---: |
| 50ノード・125エッジの初回表示 | 7 | 33.3 ms | 34.1 ms |
| 200ノード・500エッジの初回表示 | 7 | 33.1 ms | 34.2 ms |
| 200ノード・500エッジのパン中のフレーム間隔 | 100 | 16.7 ms | 16.8 ms |
| 同条件でのズーム中のフレーム間隔 | 100 | 16.7 ms | 16.8 ms |

初回表示はモジュール読込後、空のキャンバスへの文書設定から2回目の requestAnimationFrame まで（1回ウォームアップ）。操作は100%から開始し、各フレームに1イベントを送り、先頭20フレームを除外。ブラウザのフレーム間隔を測っており、物理デバイスの入力遅延は含まない。CI でも同一スクリプトを実行し、時間は比較用に記録する。ノード移動の結果は下記 M2 の測定を参照。

## M2 キャンバス編集

ノードの移動はズーム倍率を考慮して16単位にスナップする。ドラッグ中はカードと接続エッジだけを rAF で更新し、ドロップで1操作を履歴に記録する。削除はノード・関連エッジ・ピンをまとめて戻せる。複数選択の複製・貼り付けは内部配線を新しい ID に対応付ける。Undo は100操作まで。ポートは種別と index を保ち、エッジの選択・削除で切断できる。

デモは localStorage から復元する。ホストの保存アダプタ指定時は500msの debounce 後に文書 ID ごとに保存し、文書切替・破棄時には保留中の版を送り出す。失敗は文書名とともに表示し、再試行できる。保存状態・実行ログ・選択はワークフロー JSON に含めない。

M1 と同条件の200ノード・500エッジで、内部ノード1個の移動を計測した。headless Chromium 159.0.8154.6、macOS arm64、1280 × 800、DPR 1、ズーム100%。実ポインターの押下後にフレームごとに移動イベントを送り、カードの transform と関連エッジの経路がともに変わること、実ポインターのドロップで座標が確定することを検証した。先頭20フレームを除いた100フレームの間隔は **中央値16.7 ms、p95 16.7 ms**。この値はドラッグ中のフレーム間隔で、ドロップ後の保存時間は別扱い。再現コマンドは `pnpm build && pnpm bench:canvas`。


## M3 Node Creator

「ノードを追加」で登録済みのノードをカテゴリで絞り込み、表示名・型名・説明・タグの部分一致で検索できる。最近使った5種類はエディタを開いている間、使用順に表示する。

出力ポートをクリックすると、そのポートに接続可能なノードを選べる。既存の線を選んで「接続にノードを挿入」を押すと、元の両端のポート種別と番号を維持して配線する。挿入するノードには互換性のある最初の入力・出力を使う。追加と配線を一度の Undo / Redo で戻す・やり直すことができる。

## M4 ノード詳細ビュー

カードをダブルクリックするか、フォーカスして Enter を押すと詳細を開ける。Input・Parameters / Settings・Output を表示し、狭い画面ではタブで切り替える。有効な変更は編集履歴と自動保存に反映し、同じテキスト欄への300ms以内の連続入力をまとめる。Escape は無効な入力を破棄して閉じる。

Set の代入行と If / Filter の条件をフォームで追加・削除できる。入力条件はノード型のスキーマから取得する。基本プレビューには最後に受け取った主入力の先頭 item と core の式評価器を使う。Input / Output の JSON はポートごとに先頭100件を表示する。

Execute step（公開 API は `runNode(id)`）で対象ノードまで実行する。成功した実行の上流データを再利用し、パラメータ・設定を編集したノードとその下流を再計算する。配線変更・文書切替ではキャッシュを破棄し、移動とその Undo は計算結果を保持する。

## M5 Data パネル・ピン・マッピング

NDV の Run は実行時の runIndex、Input / Output のポートは種別と番号で選ぶ。item 番号は画面上では1始まり。Schema は型、Table は全件のキーの和集合、JSON はアイテムの内容を表示する。Table・JSON は検索後の結果を100件ずつ表示する。

Input の「Map from」で現在の入力または上流ノードを選ぶと、選択中のアイテムの由来をたどってフィールドを列挙する。フィールドをドラッグするか、選択して対象欄の Insert を押す。標準は置換。Insert at cursor はカーソルまたは選択範囲への挿入。主入力の数値は `={{ $json.amount }}`、祖先の数値は `={{ $('Source').item.json.amount }}` として保存する。第2入力などでは `itemFrom(port, slot, $itemIndex)` で入力を指定する。入力パスを要求する欄には式記号を含めず、複数パスはカンマ区切りで追記する。

出力が単一の main[0] なら、選択した実行回の全出力をピンに保存できる。空配列もピンとして扱う。解除と Undo / Redo は文書の編集履歴に含まれる。If やエラー出力付きノードではピンを無効にして理由を表示する。

## M8 埋め込みと最終計測

[埋め込み手順](embedding.md)に Web Component と Vanilla API の両方を掲載した。作業用キャンバスのブラウザテストでは、公開された操作で Manual → Set → If を作成し、全体実行の True 出力1件・False 出力0件を確認する。「保存済み」後にページを再読み込みし、全ノード・設定・配線が同一で、再実行結果も同じことを検証する。利用側の strict / NodeNext プロジェクトでは、ソース参照条件やパスエイリアスを使わず、パッケージの exports から解決した宣言を型チェックする。

以下は macOS arm64、headless Chromium 159.0.8154.6、1280 × 800、DPR 1 の本番ビルド計測。50ノードを初めて設定したときは33.0 ms。各サイズで最初の1回を除く再計測と、操作ごとにウォームアップ20フレームを除いた結果を示す。

| 計測対象 | サンプル数 | 中央値 | p95 |
| --- | ---: | ---: | ---: |
| 50ノード／125エッジの描画 | 7 | 33.1 ms | 34.1 ms |
| 200ノード／500エッジの描画 | 7 | 33.3 ms | 34.0 ms |
| 200ノード／500エッジのパン | 100 | 16.7 ms | 16.7 ms |
| 同条件のズーム | 100 | 16.7 ms | 16.8 ms |
| 同条件のノード移動 | 100 | 16.7 ms | 16.8 ms |

50ノードの初回描画と再計測 p95 は100 ms 未満を CI で検査する。操作の目標は60 Hz の約16.7 ms。M1・M2 の計測をもとに、共有ランナーでの計時の揺れを考慮して中央値は18 ms 未満、p95 は2フレーム相当の34 ms 未満を回帰判定に使う。

数値参照と短いテンプレートをそれぞれ新しい ExpressionEngine で検証・コンパイルし、1,000回のウォームアップ後に同じコンテキストで10,000回評価した。

| 式 | 初回コンパイル | キャッシュ済み評価の平均 | 目標 |
| --- | ---: | ---: | ---: |
| `={{ $json.amount }}` | 0.414 ms | 0.00704 ms | < 0.1 ms |
| `=Total {{ $json.amount }}` | 0.051 ms | 0.00719 ms | < 0.1 ms |

配布する JavaScript の gzip サイズは、core を外部扱いとした element が **23.3 KB / 上限120 KB**、デモの配信 JS 全体が **49.9 KB / 上限250 KB**。計測スクリプトの KB は1,024バイト。外部ランタイム依存の追加はない。

## Phase 2.5 P1 自動整列

選択中のノード（未選択なら全体）を、強連結成分をまとめたグラフの最長経路に従って列に配置する。独立成分は別の帯に配置し、部分整列では固定カードと交差するセルを飛ばす。変更座標だけを既存の移動コマンドにまとめるため、1回の Undo で元に戻り、同じ図を再度整列しても履歴や自動保存は増えない。

M8 と同じ本番 Chromium・ビューポート・DPR のローカル計測で、200ノード／500エッジのクリックから配置反映（2回目の requestAnimationFrame）までは **中央値33.3 ms、p95 33.4 ms**。初回を除く7回を採用し、毎回 Undo して元の fixture から測った。パン／ズーム／移動の中央値は各16.7 ms、p95 は順に16.8／16.7／16.7 ms。配布 gzip は element **24.1 KB**、デモ **50.7 KB**（M8 比で各 +0.8 KB）。計測は `pnpm build && pnpm bench:canvas && pnpm size` で再現できる。

## Phase 2.5 P2 スティッキーノート

付箋をワークフローの表示用メタデータとして保存する。キャンバスの全体表示は付箋の外接矩形も含む。本文・色・座標・寸法の確定とドラッグ終了をそれぞれ1編集として履歴と自動保存に通す。[操作と保存形式](embedding.md)

Chromium で日本語・改行・HTML風テキストの表示、位置・寸法・色の編集、ドラッグ、削除の Undo / Redo、再読み込み後の文書全体の一致、360px 幅の閲覧専用表示を確認した。未知の版とホスト独自のメタデータは保存後も一致し、付箋を追加しても直前の実行ログ・出力・ピンを保持し、次の部分実行で上流 HTTP は再利用された。

M8 と同条件の200ノード／500エッジでパン・ズーム・ノード移動はそれぞれ中央値・p95 とも16.7 ms。50ノードの初回描画は33.3 ms。配布 gzip は element 26.7 KB（P1 比 +2.6 KB）、デモ 53.2 KB（+2.5 KB）。
