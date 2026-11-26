# Phase 2 実装計画 — ブラウザ埋め込み型ワークフローエディタ

Phase 2 の到達点は、ホストアプリに埋め込んだエディタで、空のキャンバスから Manual → Set → If を作り、条件を編集し、分岐結果を確認し、保存したワークフローを再度開けること。最初の PR で Manual → Set の実行と出力表示までつなぎ、以後はこの経路に編集機能を加える。

基準は Phase 1 マージ後の `main`（`4e1b1ba`）。TypeScript 7.0.2、既存テスト140件。ビルド後の core + nodes は現行のファイル別 gzip 合計で **46.6 KB**。Phase 2 でも外部ランタイム依存ゼロを維持する。[全体設計](design/draflow-design.md)・[Phase 1 の実装](implementation.md)・[現行のサイズ計測](../scripts/size-report.mjs)

## 提供範囲

| 領域 | Phase 2 でできること |
| --- | --- |
| キャンバス | 固定サイズの DOM カードと SVG エッジ、パン・ズーム・フィット、選択、移動、接続・切断、削除・複製、コピー・貼り付け、Undo / Redo |
| Node Creator | トリガーまたは次のノードを選ぶ。カテゴリ・部分一致検索・最近使ったノード、選択した出力への接続、既存エッジへの挿入 |
| ノード詳細ビュー（NDV） | Input・Parameters / Settings・Output の3ペイン。狭い画面はタブ表示。パラメータ編集、式プレビュー、部分実行 |
| データとマッピング | Schema・Table・JSON 表示、検索、件数、単一出力のピン、フィールドのドラッグまたは選択による式挿入 |
| 実行と Logs | 全体・指定ノードまで・上流のみの実行、停止、ノード別の時間・入出力・エラー、現在の実行データのクリア |
| 埋め込みと保存 | Vanilla API、Web Component、Shadow DOM、ライト・ダーク・自動テーマ、日英表示、閲覧専用、Memory / localStorage アダプタ |

**Phase 2.5** に Tidy Up、グループ、スティッキーノート、実行一覧・履歴・リプレイ、コマンドパレット、式オートコンプリートを送る。Phase 3 以降で本番 Webhook・cron、資格情報・OAuth、バイナリアップロード、Code ノード、サーバー保存を扱う。React ラッパー、n8n JSON インポート、大規模なノードカタログの統合も後続フェーズとする。

## パッケージと公開 API

- `@draflow/element` は core の型・レジストリ・エンジンを利用し、ノード型はホストが注入する。内部を store、canvas、creator、ndv、logs に分ける。ルート import は副作用なし。`@draflow/element/define` で要素を登録し、SSR 環境での import と重複登録をテストする。
- `@draflow/storage` は `WorkflowStore` の型と Memory / localStorage 実装を提供する。element はポートの型だけを参照し、アダプタをバンドルに含めない。
- `apps/demo` は Vite を使い、パッケージの公開エントリから読み込む。esbuild・Vite・Playwright は開発依存。HTTP デモはホストから mock fetch を渡す。

埋め込みの「1行」は、登録とノード型注入を行うホスト内での要素宣言を指す。以下を M0 のブラウザテストに使う。デモは `/workflow.json` に Manual → Set のサンプルを用意する。

```html
<draflow-editor theme="auto" locale="ja"></draflow-editor>
<script type="module">
  import '@draflow/element/define';
  import { standardNodes } from '@draflow/nodes';

  const editor = document.querySelector('draflow-editor');
  editor.nodeTypes = standardNodes;
  editor.workflow = await fetch('/workflow.json').then(response => response.json());
</script>
```

Vanilla API は `createWorkflowEditor(host, options)`。両エントリで `workflow`、`nodeTypes`、`theme`、`locale`、`readonly`、`ports`（fetch・storage・clock）を共有する。`getWorkflow` はスナップショットを返す。`setWorkflow` は別文書の読込として選択・履歴・実行表示を初期化する。操作は `run(options?)`、`runNode(id)`、`stop`、`focusNode`、`fitView`、`undo`、`redo`、`destroy`。実行系は core の `RunHandle` を返す。

Web Component は `draflow-ready`、`draflow-change`、`draflow-selection`、`draflow-run-start`、`draflow-node-start`、`draflow-node-finish`、`draflow-run-finish`、`draflow-toast` を公開する。Vanilla の `onChange` と `onRun` も同じ変更・実行を通知する。閲覧専用では移動・ズームによる閲覧と詳細確認を許可し、ワークフロー編集、実行、自動保存を無効にする。

## 編集・実行の契約

### 文書、Undo、非同期保存

`EditorStore` はワークフロー、選択・ビューポート、実行結果を区別して保持する。文書変更は追加・削除・移動・配線・パラメータ変更・名前変更・無効化・ピンのコマンドを通す。エッジ挿入や複数選択への操作は一括で Undo 可能にする。ドラッグはドロップで1操作、同じ欄の連続入力は300msでまとめ、履歴は100件。選択、パン、ログ閲覧は履歴に積まない。

`WorkflowStore` の契約は `load(id): Promise<Workflow | null>` と `save(workflow): Promise<void>`。storage 指定時はエディタが500msの debounce 後に保存する。ホストが保存を担当する場合は storage を渡さず、変更通知とスナップショットを使う。保存対象は workflow と明示的な pinData。実行ログ・UI 状態は分離する。

保存は文書 ID ごとに直列化し、文書 ID・版・スナップショットを要求時に固定する。保存中の編集は次回分にまとめる。`dirty` は現在の文書内容と最後に保存成功した内容の差で決める。失敗は表示して再試行可能にし、未保存中は離脱を警告する。A の保存待ちに B を開いた場合も A の保存を A に完了させ、その結果で B の dirty 表示を更新しない。遅延・失敗を制御できるアダプタでこの順序を検証する。

### キャンバスとフォーム

- ドラッグはカードで移動、背景で矩形選択、Space＋ドラッグまたは中ボタンでパン。ホイールによるズームとキーボードの拡縮・フィットを用意する。移動は16pxスナップ、描画は ID 単位で更新し、ドラッグ中はカードと接続中のエッジを同じフレームで更新する。
- 接続端は `{ node, port, index }` として保持する。追加・挿入では選択中の出力と接続先の入力を使う。If の False → Merge の第2入力にノードを挿入して Undo し、元の両端が完全に戻ることを確認する。[接続型](../packages/core/src/types.ts)
- フォームの優先順位は標準ノードの実スキーマで決める。Manual は設定なし、Set は select・boolean・JSON と入れ子の `fixedCollection`（assignments）、If / Filter は専用の `filter`（左右値・演算子・AND / OR）、HTTP は string・select・JSON・number。Merge の表示切替も確認する。共通フォームは text・multiSelect・collection・notice / callout・hidden に対応し、resourceLocator 等の拡張 UI は後続扱いとする。[ノード型](../packages/core/src/node.ts)・[標準ノード](../packages/nodes/src)
- 表示条件は core の `getVisibleParameters` を使い、既定値、必須、数値範囲、式構文を検証する。Settings は Execute Once、Always Output Data、Retry とその回数・間隔、On Error、Notes / 表示を実データに対応づける。型バージョンを表示し、複製は編集コマンドとして扱う。未対応の型を含む既存文書も、ほかの欄の編集で値を失わない。

### マッピング、プレビュー、ピン

単独の値をマッピングした保存形式は `={{ $json.amount }}`。数値は数値のまま扱う。文字列中の挿入は `=合計 {{ $json.amount }} 円`、祖先参照は `={{ $('Source').item.json.amount }}` とする。スペース・引用符を含むキーやノード名をエスケープし、`requiresDataPath` の欄は指定形式のパスを受け取る。Fixed / Expression 切替と追記・置換は元の入力を失わず Undo できる。フィールドを選んで「挿入」する操作もドラッグと同じ生成処理を通す。

NDV の Input は対象タスクが実際に受け取った入力を表示する。runIndex・ポート・item を選べるようにし、Table はキーの和集合を列にして100行単位でページングする。式プレビューは core と評価コンテキストの生成を共有し、選択した item の由来をたどる。必要な由来情報は現在の実行と一緒に保持し、データ不足時は「プレビュー用入力なし」と表示する。**Filter 後の2件目を選んで祖先の数値を Set にマッピングし、プレビューと実出力の値・型が一致する**ことを確認する。[式の保存形式](../packages/core/src/expression/template.ts)・[実行コンテキスト](../packages/core/src/engine.ts)

Phase 2 のピン対象は有効な出力が単一の `main[0]` のノード。core の `pinData[nodeId]: Item[]` で表現できる範囲に合わせる。If の複数出力やエラー出力を持つ設定では理由を表示する。空配列のピンと解除を区別し、ピン・解除・Undo 後の部分実行をテストする。

### 部分実行と Logs

全体実行は新規実行。Execute step は `destinationNodeId` と成功済みの `runData` を渡し、対象ノードに加えて前回の実行以降に編集されたノードを `dirtyNodeIds` に含める。core がその下流を無効化する。Execute previous nodes は `destinationMode: 'exclusive'` で対象の手前まで実行する。配線・名前参照の変更は初版ではキャッシュを全破棄してよい。位置・選択変更では計算結果を再利用する。ピン・設定変更と Undo / Redo にも同じ無効化規則を適用し、部分実行で再計算されなかった枝の古い成功表示を消す。

同時に表示する実行は1件。実行開始時の文書スナップショットと `runId` を記録し、編集後の文書に過去の結果を混ぜない。Stop は `RunHandle.cancel()`。文書切替・破棄でキャンセルと購読解除を行い、古い完了イベントを無視する。Logs は実行中からノード・runIndex ごとの状態、入出力、件数、時間、エラーを表示し、Clear execution でキャッシュと表示を消す。

## 実装順と PR の出口

| PR | 実装 | 受け入れ条件 |
| --- | --- | --- |
| M0 | element・storage・demo の足場、公開エントリ、実行イベント、Playwright、サイズ計測 | 埋め込み例から Manual → Set を実行し、Set が作った値を1件表示。SSR import、二重登録、破棄を検証。Phase 1 の実測値を実装状況文書に反映 |
| M1 | 読み取り用キャンバス、選択、パン・ズーム、フィット | サンプルの接続と M0 の実行結果が見える。200ノードの操作別ベースラインを記録 |
| M2 | 編集、履歴、自動保存 | 接続・移動・削除・Undo・再読込が一致。遅延保存、保存失敗、文書切替を再現 |
| M3 | Node Creator、検索、最近使ったノード、ポート指定の自動接続・挿入 | 空の文書から UI で Manual / Set / If を追加。False 側への挿入と Undo が通る |
| M4 | NDV、標準ノードのフォーム、設定、基本プレビュー、編集後の部分実行 | 空から assignments と If 条件を作り、保存・再読込後に両分岐を確認。Set の値を編集 → If の Execute step → 分岐変更 → Undo → 再実行で元の結果 |
| M5 | Data パネル、ピン、マッピング | Filter 後の祖先参照でプレビューと Set 出力が一致。ドラッグ・キーボード・タッチで同じ式を挿入できる |
| M6 | 上流のみの実行、停止、エラー、Logs の完成 | mock HTTP の呼び出し回数で上流再利用を検証。停止後や文書切替後に旧実行が画面を書き換えない |
| M7 | テーマ、日英表示、モバイル、操作性・アクセシビリティ | キーボードだけで追加・接続・編集・マッピング・実行可能。NDV の開閉でフォーカスが戻り、日本語変換中の Enter / Delete がキャンバス操作にならない |
| M8 | デモ、埋め込み文書、公開型・サイズ・性能の最終検証 | 公開エントリだけでサンプルを実行でき、下記の機能・性能・品質条件をすべて満たす |

標準は M0〜M8 の **9 PR**。M1 と M2 をまとめる場合は8 PR。原案の3〜4週間は暫定見積もりとし、M0 の実行経路と M1 の実測後に更新する。

## 検証と性能予算

- **単体・公開 API** — 編集コマンドと逆操作、接続の端点、座標変換、保存順序、マッピング生成、キャッシュ無効化を検証。公開型は利用側の TypeScript プロジェクトで型チェックする。
- **ブラウザ CI** — Chromium の Playwright ジョブを M0 から追加する。各 PR で対象の受け入れ操作を加え、M8 では空の文書から作成・実行・保存・再読込までを通す。`typecheck`・全テスト・`build`・`size` も継続する。
- **描画** — 固定 Chromium、同一ランナー・ビューポート・DPR、ビルド済みデモで測る。50ノードの初回描画はモジュール読込後の workflow 設定からカードとエッジが描画されるフレームまで100ms未満を目標とする。200ノード / 500エッジではパン・ズーム・ノード移動を分け、ウォームアップ後のフレーム間隔を記録する。60Hz 環境の約16.7msを目標に中央値・p95を残し、M1 の再測定でばらつきを確認して CI の許容幅を決める。
- **式評価** — 数値フィールド参照と短いテンプレートを固定 fixture とし、コンパイル済みの反復評価で1回あたり0.1ms未満を目標とする。初回コンパイルは別に記録する。
- **配布サイズ** — M0 で本番ビルドの埋め込み fixture を固定し、gzip 後の element 部分（core は外部扱い）≤120 KB、標準デモが読む element + core + nodes + 使用する storage を重複なしで合算して ≤250 KB とする。CI は予算超過で失敗させる。現行のファイル別 gzip 合計は Phase 1 との比較用に併記する。
