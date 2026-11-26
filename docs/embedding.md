# ブラウザへの埋め込み

## デモを動かす

リポジトリのルートで Node.js 22.13 以降と pnpm を使う。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Vite が表示した URL を開く。「ワークフローを選択」で選び、「開く」を押す。

| 文書 | 操作と結果 |
| --- | --- |
| Manual → Set | 「実行」で `{"message":"Hello Draflow"}` を1件出力する。 |
| 作業用キャンバス | 初回は空。編集内容はこの文書専用の ID に保存され、同じ URL を開くと復元される。 |
| Manual → HTTP（モック） | 「実行」で `{"amount":42}` を1件出力する。ホストが注入した fetch が `https://example.test/items` に固定応答を返す。この例で他の URL を指定すると 404 を返す。 |

### 空のキャンバスから分岐を作る

1. 作業用キャンバスで「ノードを追加」から **Manual Trigger** を選ぶ。カード右端の出力を押し、**Edit Fields (Set)** を選ぶ。
2. Set をダブルクリックし、「行を追加」で名前を `color`、値を `green` にして閉じる。Set の出力から **If** を追加する。
3. If を開き、条件の行を追加する。左辺に `={{ $json.color }}`、演算子に「等しい」、右辺に `green` を指定して閉じる。
4. 「実行」後、If の詳細にある出力ポートを確認する。True の `main[0]` が1件、False の `main[1]` が0件になる。「保存済み」が表示されてから再読み込みすると、同じ配線と設定で再実行できる。
5. Set の値を `blue` に変更して If まで実行すると False が1件になる。「元に戻す」後に再実行すると True に戻る。

「自動整列」は選択したノードを左から右へ配置する。全体を整えるときはキャンバスにフォーカスして Escape で選択を解除してから押す。閉路は同じ列にまとめる。整列は1回の「元に戻す」で取り消せる。

「付箋を追加」で、キャンバスに説明を書き込める。本文をクリックするか Tab でフォーカスして Enter を押すと、本文・色・座標・寸法を編集できる。位置は上端をドラッグしても変更できる。フォームで「保存」した後は、ノード編集と同じように自動保存・Undo・Redo が働く。閲覧専用でも付箋を開いて全文を読める。

付箋は文書の `meta.draflowEditor` に `{ version: 1, notes: [...] }` として保存される。各付箋は `id, text, color, x, y, width, height` を持ち、位置・寸法はキャンバス座標で表す。ホストが文書を変換・保存するときは、この領域もそのまま引き継ぐ。対応していない版を開くと付箋編集は無効になり、他の編集を保存してもその領域は保持される。

### 式の入力を補完する

ノード詳細で、式欄の `{{ }}` の内側に `$json.` と入力すると、入力パネルで選んだ実行回・ポート・アイテムにあるキーが最大20件表示される。`$('` の引用符まで入力すると祖先ノード名を選べる。祖先を挿入してからピリオドを入力すると、そのアイテムの由来に対応するフィールドを選べる。数値の後で `.rou` と入力すれば `round()` が候補になる。

上下矢印で候補を選び、Enter で挿入する。Escape は式を変更せずに候補を閉じる。すでに書いた式ではカーソルを合わせて Ctrl+Space または「補完」で再表示できる。タッチ画面では候補をタップする。

### コマンドパレットから操作する

「コマンドパレット」を押すか、エディタにフォーカスした状態で Ctrl+K（Mac は ⌘K）を押す。日本語・英語のどちらでも操作名の一部を検索できる。上下矢印で候補を選び、Enter で実行する。タッチ画面では候補をタップする。Escape または「閉じる」で元の操作に戻る。

「ノードを追加」は Node Creator を開く。エッジを選択しているときの「接続にノードを挿入」もツールバーと同じように使える。操作できない候補は無効表示になる。閲覧専用では「全体表示」、実行中は「全体表示」と「停止」を選べる。

### ノードをグループにまとめる

キャンバスでノードを選び、「グループ化」で名前を付ける。グループ名をドラッグすると所属ノードが一緒に動く。キーボードではグループ名にフォーカスして矢印キーで移動できる。「折りたたむ」「展開」は Enter または Space でも操作できる。折りたたむと境界をまたぐ配線だけが外周に表示される。名前の変更とグループ解除はグループ名から行う。

所属と折りたたみ状態は `meta.draflowEditor.groups` に保存される。各グループは `id, label, members, collapsed` を持ち、`members` は所属ノードの ID の配列。閲覧専用での展開・折りたたみは表示中だけ有効になる。

## Web Component をホストする

このリポジトリ内のホストでは、利用する `@draflow/core`、`@draflow/element`、`@draflow/nodes`、`@draflow/storage` を `workspace:*` で依存に追加する。先にルートで `pnpm build` を実行し、Vite などの ESM バンドラーから各パッケージの公開エントリを読み込む。デモのホスト実装は [main.ts](../apps/demo/main.ts) にある。

```html
<draflow-editor locale="ja" theme="auto"></draflow-editor>
<script type="module" src="./editor.ts"></script>
```

```ts
// editor.ts
import '@draflow/element/define';
import { createWorkflow } from '@draflow/core';
import { standardNodes } from '@draflow/nodes';
import { LocalStorageWorkflowStore } from '@draflow/storage';

const editor = document.querySelector('draflow-editor')!;
const storage = new LocalStorageWorkflowStore('my-app');
editor.nodeTypes = standardNodes;
editor.ports = { storage };
editor.workflow = await storage.load('draft') ??
  createWorkflow({ id: 'draft', name: '作業用キャンバス' });

editor.addEventListener('draflow-run-finish', event => {
  console.log(event.detail.runId, event.detail.result.status);
});
editor.addEventListener('draflow-toast', event => {
  console.warn(event.detail.workflowId, event.detail.message);
});
```

- 同じ origin、名前空間、文書 ID を使って保存済み文書を読み込む。編集後500 ms で自動保存する。保存失敗は画面に表示され、「保存を再試行」で再送できる。メモリ内だけで使うときは `MemoryWorkflowStore`、独自の保存先には `WorkflowStore` の `load(id)` と `save(workflow)` を実装する。
- 実行ボタンに相当する呼び出しは `await editor.run().done`。部分実行には `runNode(id)` または `runPreviousNodes(id)`、中断には `stop()` を使う。`workflow` の読み取りはスナップショットを返し、代入は文書の切替として扱う。切替後に古い実行が完了しても表示には反映されない。
- `theme` は `light`・`dark`・`auto`、`locale` は `ja`・`en` に対応する。`readonly` 属性で閲覧専用になる。ノード型とポートを初期化時に渡す。これらを後から差し替えるとエディタを再マウントする。

## 通常の HTML 要素に埋め込む

カスタム要素を登録せずに使う場合は、空のホスト要素を渡す。ホストを取り除く際に `destroy()` を呼ぶ。

```ts
import { createWorkflow } from '@draflow/core';
import { createWorkflowEditor } from '@draflow/element';
import { standardNodes } from '@draflow/nodes';

const host = document.createElement('div');
document.body.append(host);
const editor = createWorkflowEditor(host, {
  workflow: createWorkflow({ name: '新しいワークフロー' }),
  nodeTypes: standardNodes,
  locale: 'ja',
  onRun(event) {
    if (event.type === 'run:finish') console.log(event.detail.result.status);
  },
});
// ホストアプリのアンマウント処理で呼ぶ
const unmount = () => { editor.destroy(); host.remove(); };
```

## 実行履歴を有効にする

ホストが `ports.executions` にストアを渡すと「実行履歴」が表示される。デモはページ内だけで共有するメモリストアを使用する。ワークフローの自動保存とは個別に設定できる。

```ts
import { MemoryExecutionStore } from '@draflow/storage';

const executions = new MemoryExecutionStore({ maxRecords: 20, maxDetailBytes: 4 * 1024 * 1024 });
editor.ports = { ...editor.ports, executions }; // Web Component の初期設定時に渡す
```

文書の設定 `settings.saveExecutionData` が `none` の場合は記録を停止し、`error` の場合はエラーで終わった実行だけを保存する。省略時または `all` ではすべて記録する。

一覧は現在の文書の実行を開始時刻の新しい順に表示する。部分実行は開始・終了の指定と終点を含むかを表示し、今回開始したタスクと再利用したタスクの件数を分ける。「実行結果をクリア」後も履歴は残る。履歴の「削除」はその1件だけを消す。閲覧専用でも一覧と状態フィルターを使える。

永続化するホストは `@draflow/storage` の `ExecutionStore` を実装し、ストアの保持期間・容量を決める。

| メソッド | 契約 |
| --- | --- |
| `append(summary, detail)` | 完了または停止した実行を保存する。同じ文書 ID・実行 ID は1件にまとめる。詳細には実行開始時の文書と、その実行が実際に訪れたタスクを順に格納する。 |
| `list(workflowId, status?)` | 新しい順のサマリーと `hasDetail` を返す。一覧取得にタスクの入出力は不要。 |
| `get(workflowId, id)` | 対象の詳細を取得する。存在しない場合や容量超過で省略した場合は `null` を返す。 |
| `delete(workflowId, id)` | 指定した文書の実行を削除する。すでに削除済みでも呼び出せる。 |

同梱ストアの既定値は全ワークフロー合計20件、詳細合計4 MiB。詳細を JSON にしたときの UTF-8 バイト数で計算し、件数・容量が超過すると開始時刻が古い記録から削除する。単独で容量を超える詳細は省略して、サマリーを残す。ページの再読み込みでメモリ履歴は消える。ストアへの書き込みは非同期で、実行結果の表示は保存完了を待たない。

### 記録をリプレイし、独立した文書として編集する

「実行履歴」の行で「リプレイ」を選ぶ。「前のタスク」「次のタスク」で記録順に移動し、入力・出力のポートとアイテムを選ぶ。「記録時のワークフロー」には当時の配線と文書全体、「記録時のタスク」には入出力・由来・エラーを含む保存済みデータが表示される。リプレイは履歴ストアの詳細を読み、ワークフローのノードは実行しない。Escape または「閉じる」で作業中の文書に戻る。

「エディタへコピー」は記録時の文書に新しい文書 ID を割り当て、ノード ID・配線・付箋・グループ・ピンを引き継ぐ。コピー先の実行結果、部分実行キャッシュ、Undo 履歴は空から始まる。ワークフローストアがあればコピー直後から新しい ID で保存する。閲覧専用のホストではコピー操作は表示されない。

埋め込みホストは `draflow-change`（関数 API は `onChange`）の `source === 'replay-copy'` で新しい ID を取得できる。デモはコピーの ID を URL の `copy` に、元のサンプルを `example` に保持する。再読み込み時はコピーをストアから開き、「元の文書に戻る」で元の作業を再開できる。[デモの文書切り替え](../apps/demo/main.ts)

## 再検証

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
pnpm size
pnpm bench:canvas
pnpm bench:expression
```

公開型は独立した [TypeScript 利用例](../apps/demo/consumer/embed.ts) を NodeNext・strict でコンパイルする。型の参照先はビルド済みの宣言ファイル。ブラウザテストと描画ベンチマークは本番ビルドを使用する。
