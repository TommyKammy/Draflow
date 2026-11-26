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
