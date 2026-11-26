# REA 証跡 — n8n 2.49.6 の出荷済みエディタ解析

このドキュメントは [n8n 分析レポート](./n8n-analysis.md) の根拠を記録する。
結論の種類を **観察（observed） / 導出（derived） / 推測（inferred）** で区別する。

---

## 1. 対象の同一性

| 項目 | 値 |
| --- | --- |
| Docker イメージ | `n8nio/n8n:latest` |
| イメージ digest | `sha256:a1a9955a4a9e5dd9fa65a62f59e0751351b45b9e5cd2c17e6e330a8d0026cad8` |
| 起動バージョン | n8n **2.49.6**（コンテナログ `Cluster aligned on version 2.49.6`） |
| ソースリポジトリ | `https://github.com/n8n-io/n8n` |
| コミット | `8bef9c8156d0b225672f57da1fc096d7714e2316`（2026-11-25） |
| 抽出した成果物 | リポジトリ外の `n8n-rea-artifact`（例: `../n8n-rea-artifact`） |
| 成果物 SHA-256 | `c62eb932e4f166d0dc1b8d36fbbd5e958a3d05cf836e1be21992c545c869036d` |
| 成果物サイズ | 33 MB（エディタの `dist/`） |
| ファイル数 | 888 アセット、うち JS 535 |

抽出元（コンテナ内）:

```text
/usr/local/lib/node_modules/n8n/node_modules/.pnpm/n8n-editor-ui@*/node_modules/n8n-editor-ui/dist/
```

---

## 2. 実施した分析

### 2.1 ソースリポジトリ

- `packages/workflow`（型・式・グラフ）
- `packages/core`（実行エンジン・トリガー）
- `packages/cli`（Webhook・REST・実行保存）
- `packages/frontend/editor-ui`（キャンバス・NDV・Node Creator・ログ）
- `packages/@n8n/api-types`（手動実行 API）

ソースは **振る舞いの権威** として扱った。成果物は minify されており、ソースほど正確な意図は読み取れない。

### 2.2 実機インスタンス

- Docker で `localhost:5678` に起動。
- オーナーアカウントを作成。
- 手動トリガー → HTTP Request → Edit Fields のワークフローを作成。
- 1 ノード実行、全体実行、Logs、Executions、Command Palette、NDV、式エディタを操作。
- スクリーンショットを `docs/analysis/shots/` に保存。

### 2.3 REA（出荷済み成果物）

```text
rea.analyze_javascript_application({
  input_path: "<absolute-path>/n8n-rea-artifact",
  detail: "summary"
})
```

返却された Evidence:

| Evidence ID | 種類 |
| --- | --- |
| `ev_bc597f21750a0adb8a4ccab455e614107d57ef6d7856e2edeaab683a1e659381` | 親（完全な静的解析結果） |
| `ev_1276596c85a90a9a1cdb339e83da745a70bd7005af4d1b2f2b9c056987198ca2` | サマリービュー |
| `ev_38f6d34e43ab8a7c37df60858e9aea9caa2214c20364a86374f465f8069f1800` | `javascript-facts`（endpoint）ビュー |

続いて `inspect_analysis_view` で endpoint 事実を照会した。

```text
view: {
  kind: "javascript-facts",
  where: { kinds: ["endpoint"] },
  property_keys: [],
  include_available_property_keys: true,
  offset: 0,
  limit: 20
}
```

### 2.4 再現コマンド

```bash
# 1. ソース（Draflow リポジトリの親ディレクトリで実行）
git clone --depth 1 https://github.com/n8n-io/n8n.git ../n8n

# 2. 実機
docker pull n8nio/n8n:latest
docker run -d --name n8n-rea -p 5678:5678 \
  -e N8N_SECURE_COOKIE=false \
  -e N8N_DIAGNOSTICS_ENABLED=false \
  -e N8N_VERSION_NOTIFICATIONS_ENABLED=false \
  -e GENERIC_TIMEZONE=Asia/Tokyo -e TZ=Asia/Tokyo \
  n8nio/n8n:latest

# 3. ビルド済みエディタの抽出
D=$(docker exec n8n-rea sh -lc \
  'ls -d /usr/local/lib/node_modules/n8n/node_modules/.pnpm/n8n-editor-ui@*/node_modules/n8n-editor-ui')
docker cp "n8n-rea:$D/dist/." ../n8n-rea-artifact/

# 4. REA
#    analyze_javascript_application({ input_path: "<absolute-path>/n8n-rea-artifact" })
```

実機の UI 観察は `http://localhost:5678` で行った。ワークフローは Manual Trigger → HTTP Request → Edit Fields の 3 ノード。

---

## 3. REA の観察結果

### 3.1 解析統計（observed）

| 指標 | 値 |
| --- | ---: |
| 対象ファイル | 538 |
| 解析した JavaScript | 535 |
| スキップ | 2 |
| 読み取ったテキスト | 22,950,184 bytes（約 22.9 MB） |
| AST ノード | 3,460,941 |
| 検出した facts | 9,780 |
| モジュール | 6 |
| パース失敗 | 0 |
| 構文解析の完全/回復/失敗 | 535 / 0 / 0 |
| 意味解析の unknown ソース | 106 |
| 調査の完全/制限/未調査 | 509 / 26 / 2 |

**導出**: エディタは単一の巨大バンドルではなく、535 の JS チャンクに分割されている。Vite のコード分割が使われている。

### 3.2 バンドル構成（observed）

`dist/` の実測:

| 項目 | 値 |
| --- | ---: |
| `dist/` 全体 | 33 MB |
| JS 合計 | 23,608 KB（約 23.6 MB） |
| JS ファイル数 | 535 |
| 最大: `vendor-*.js` | 4.3 MB |
| 2 番目: `app-*.js` | 4.0 MB |
| 3 番目: `typescript.worker-*.js` | 3.5 MB |
| `DataTableTable-*.js` | 952 KB |
| `AgentBuilderView-*.js` | 424 KB |
| WASM | `tree-sitter.wasm`, `tree-sitter-bash.wasm` |

**導出**: エディタ単体でも 23.6 MB の JS を読み込む。n8n の「軽量版」を作るには、この 99% を捨てる必要がある。

### 3.3 endpoint 事実（observed / inferred）

REA は 7 件の endpoint 候補を返した。

- 2 件は `observed`（AST 上の fetch/URL 構築）
- 5 件は `inferred`（プロパティ名からのルート候補、confidence: low）

例:

| 種類 | 値 | confidence |
| --- | --- | --- |
| route candidate | `instructions` | low |
| route candidate | `model` | low |
| routine candidate | `parameters.includeTools` | low |
| network partial | `AgentChatPanel-*.js` 内の式 | observed（部分） |

**推測**: minify された SPA では、ルートや API エンドポイントの静的復元は限定的である。REA の endpoint ビューは「アプリの全 API を列挙する」用途には向かない。
**結論**: 実行時の API 形状は、実機の REST レスポンスとソース（`manual-run.dto.ts` など）を権威とした。

### 3.4 REA の制約（observed）

返却された limitations の要点:

- JavaScript と HTML は **不活性テキスト** として解析され、実行はされていない。
- グラフのカバレッジは不完全。未取得の事実を「存在しない」と解釈してはならない。
- ローカルデータフローは制御フロー敏感な到達定義を主張しない。
- リクエスト抽出は `fetch` / `WebSocket` / `node:http` / `node:https` の直接形に限る。
- minify により動的なプロパティ解決は不明のまま。
- 親の結果バジェットを超えたファイルが多数あり、981 件の limitation が省略された（完全なリストは親 Evidence を参照）。
- アプリケーションカバレッジは `partial`。

**重要**: REA の結果は「バンドルの構成と規模」の証拠としては強いが、「UX の意図」や「実行セマンティクス」の証拠としては弱い。後者はソースと実機で補った。

---

## 4. 実機観察の証跡

| 画像 | 内容 | 観察した事実 |
| --- | --- | --- |
| `shots/01-canvas-executed.jpg` | 実行後のキャンバス + Logs | 緑の成功枠、チェック、`1 item` バッジ、ノード要約、下部 Logs、実行時間 |
| `shots/02-ndv-http-request.jpg` | NDV（HTTP Request） | 3 ペイン、`Execute step`、`Fixed/Expression`、出力テーブル、ピン、Item 数 |
| `shots/03-expression-editor.jpg` | 式エディタ | 上流フィールド検索、`Variables and context`、式、Result、Item 切替、Text/Html/Markdown |
| `shots/04-trigger-node-creator.jpg` | トリガー選択 | 「What triggers this workflow?」、7 つの意図、検索、説明文 |
| `shots/05-executions.jpg` | Executions | Auto refresh、実行一覧、読み取り専用キャンバス、Logs、Copy to editor |

補足の観察:

- ノードの `+` は、そのノードの出力に接続された状態で Node Creator を開く。
- 既存の接続の途中にノードを挿入すると、`source → new → target` に付け替えられる。
- 式モードの入力欄には `fx` バッジが付き、下に結果プレビューが出る。
- 出力のピン留めアイコンで、そのノードの出力を固定できる。
- ノードの `Settings` タブに、Duplicate Item / Always Output Data / Execute Once / Retry On Fail / On Error / Notes / Display Note in Flow がある。
- Executions のキャンバスは斜線背景で「読み取り専用」であることを示す。
- Logs は実行中にストリーミング更新される。

---

## 5. ソースから確認した事実

| 事実 | 参照 |
| --- | --- |
| Workflow / Node / Item の型 | `packages/workflow/src/interfaces.ts` L1847, L1961, L3874 |
| 接続の入れ子構造 | 同 L543 |
| 実行ループ | `packages/core/src/execution-engine/workflow-execute.ts` L2480〜 |
| 部分実行 | 同 L272〜（`runPartialWorkflow2`） |
| エラー処理 | 同 `handleNodeExecutionError` |
| Pin / 待機 / リトライ | 同 `getPinnedOutput` / `addWaitingNodeToEmptyStack` / `getRetryParams` |
| データプロキシ | `packages/workflow/src/workflow-data-proxy.ts` L1748〜 |
| 式拡張 | `packages/workflow/src/extensions/*` |
| 表示条件 | `packages/workflow/src/node-helpers.ts` L341〜 |
| パラメータ解決 | 同 L794〜 |
| トリガー起動 | `packages/core/src/execution-engine/active-workflow-triggers.ts` L159〜 |
| Webhook レスポンス | `packages/workflow/src/interfaces.ts` L3513 |
| キャンバスのキーマップ | `packages/frontend/editor-ui/src/features/workflows/canvas/components/Canvas.vue` L540〜 |
| ノード追加と自動接続 | `packages/frontend/editor-ui/src/app/composables/useCanvasOperations.ts` L1186〜, L1455〜 |
| マッピング生成 | `packages/frontend/editor-ui/src/app/utils/mappingUtils.ts` L24〜 |
| Tidy Up（dagre） | `packages/frontend/editor-ui/src/features/workflows/canvas/composables/useCanvasLayout.ts` L1 |
| NDV | `packages/frontend/editor-ui/src/features/ndv/shared/views/NodeDetailsView.vue` |
| 手動実行 API | `packages/@n8n/api-types/src/dto/workflows/manual-run.dto.ts` |

---

## 6. 実機 REST から取得したデータ

### 6.1 ノードタイプ記述

`/types/nodes.json`（認証不要の静的 JSON）:

- 1,004 タイプ
- 25,556 パラメータ
- 18,402,653 bytes（約 18.4 MB）
- うち AI/LangChain 系 189

### 6.2 実行データ

`/rest/executions/3?includeData=true`:

- `mode: "manual"`
- `status: "success"`
- `data` は **flatted** 形式（循環参照を文字列キーで圧縮）
- `resultData.runData` にノードごとの `startTime`, `executionIndex`, `executionTime`, `executionStatus`, `data`
- `executionData.nodeExecutionStack` は実行完了後は空
- `workflowData` に実行時点のワークフロースナップショット

**導出**: 実行結果は「ノード名 → runIndex → TaskData」の二重マップ。UI はこの構造をそのまま描画できる。

### 6.3 手動実行 API

`manual-run.dto.ts` は 3 つのユースケースを判別する。

1. `triggerToStartFrom` あり → 既知のトリガーから全体実行
2. `destinationNode` あり、`runData` なし → 不明なトリガーから destination まで実行
3. `destinationNode` + `runData` あり → 既存データを再利用して部分実行

```ts
{ runData, destinationNode: { nodeName, mode: 'inclusive' | 'exclusive' }, dirtyNodeNames? }
```

**導出**: 「ノードを右クリック → Execute step」は、この 3 番目の API に `destinationNode` を渡すだけで実現できる。

---

## 7. 結論の確度

| 結論 | 確度 | 根拠 |
| --- | --- | --- |
| エディタは 33 MB / JS 23.6 MB | observed | `du`, REA artifact |
| 1,004 ノード / 25,556 パラメータ | observed | 実機 `/types/nodes.json` |
| 実行はスタック + waiting + runData | observed + derived | ソース + 実行データ |
| 式はフル JS + データプロキシ | observed | ソース |
| UX の中心は 3 ペイン NDV とマッピング | observed | 実機 + ソース |
| キャンバスは Vue Flow、Tidy Up は dagre | observed | `package.json` + import |
| n8n のコードは再利用できない | observed | LICENSE.md |
| コアの 10% で 80% の体験を再現できる | inferred | 分析者の判断。実装で検証する |

---

## 8. 未解決の問い

1. n8n の式をどこまで互換にするか（フル JS か、サブセットか）。
2. 本番トリガーをブラウザだけで動かすか、Node ランタイムを必須にするか。
3. n8n JSON の import/export を v1 に入れるか。
4. 資格情報をどこまで内蔵するか（ホスト委譲か、暗号化ストアか）。
5. 1 実行あたりの Item 上限と、実行データの保持ポリシー。
6. コードノードをデフォルトで有効にするか（セキュリティと体験のトレードオフ）。

これらは [Draflow 設計案](../design/draflow-design.md) の「未決事項」で扱う。
