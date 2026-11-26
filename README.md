# Draflow

**Lightweight, fast, zero-dependency workflow automation — embeddable anywhere.**

Draflow is a from-scratch workflow editor and runtime inspired by n8n's interaction
model: a canvas of nodes, step-by-step execution, side-by-side input/output data,
drag-to-map expressions, pinning, partial runs, and execution logs.

The goal is not to reimplement n8n's 1,000 integrations. The goal is to port the
**core loop** — run, inspect, wire, re-run — in a package small enough to embed in
any web app.

> The embedded editor can run a Manual → Set workflow and display its output.
> See the [Phase 2 plan](docs/phase2-plan.md) for the editing milestones.

## Quick start

```bash
pnpm install
pnpm typecheck
pnpm test

pnpm build
node examples/run-workflow.mjs
pnpm size
```

Run `pnpm dev` to open the demo at the URL printed by Vite. Select **実行** in the
Manual → Set example to display one item containing `{"message":"Hello Draflow"}`.
To test the production embed in Chromium, run `pnpm build`,
`pnpm exec playwright install chromium`, then `pnpm test:browser`.

Pan the canvas with Space + drag or the middle mouse button. Use Ctrl/Cmd + wheel
to zoom around the pointer, or use the zoom and fit buttons. Click a node to
select it, Shift-click to toggle another, or drag the background to select a region.
With the canvas focused, `+` / `-` zoom, `0` restores 100%, and `1` fits the graph.

Choose **ノードを追加** to search the Node Creator by name or browse by category.
Click an output dot to add a connected node on that branch. To insert a node,
select an edge, then choose **接続にノードを挿入**. One Undo restores the original edge. Drag cards to move them on a
16-unit grid, or drag an output dot onto an input dot to connect nodes. Select a
card or an edge and press Delete to remove it. The toolbar supports Undo and Redo;
Ctrl/Cmd+D duplicates a selection and Ctrl/Cmd+C/V copies and pastes a subgraph.
Double-click a card or focus it and press Enter to open its details. Edit parameters
or settings, then choose **Execute step** to run through that node. Input and Output
show each port separately. Choose a run, port, and item to inspect its data in
Schema, Table, or JSON. Table pages contain up to 100 rows.

Use **Execute previous nodes** to run only the selected node’s ancestors. Both
partial execution actions reuse clean upstream results. **Run workflow** starts
fresh. Open a row in **Execution log** to inspect its input and output by node
and run index. **Stop** cancels the active run. **Clear execution** removes
displayed results and the partial execution cache while preserving edits and pins.

For keyboard editing, Tab to **Add node** or **Connect nodes**. The connection
dialog lists output and input ports with their slot indices. Press Enter on a
node card to edit it, select an input field and use **Insert** to map it, then
choose **Execute step**. Closing the details dialog returns focus to the card.
On narrow screens, use the Input, Node and Output buttons to switch panes.

In **Map from**, choose the current input or an upstream node. Select a field,
then use **Insert** at the destination parameter, or drag the field onto it.
**Insert at cursor** embeds a value in text. **Replace value** preserves the
source type. For example, `={{ $('Source').item.json.amount }}` follows the
selected item's lineage through a Filter. **Pin output** saves a single main
output (including an empty array) in the workflow for subsequent runs.

The demo saves edits in localStorage after 500 ms and restores them on reload.
Embedded hosts can supply their own `ports.storage` or listen for `draflow-change`.

After building, run `pnpm bench:canvas` to measure rendering, panning, zooming and node dragging
in the production embed. [M1 baseline and measurement conditions](docs/implementation.md#m1-canvas-baseline).

## Documents

| Document | Contents |
| --- | --- |
| [n8n analysis](docs/analysis/n8n-analysis.md) | What n8n does, how its engine and UX work, what to port and what to drop |
| [REA evidence](docs/analysis/rea-evidence.md) | Static analysis of the shipped n8n editor, with evidence IDs and limitations |
| [Draflow design](docs/design/draflow-design.md) | Package layout, data schema, node SDK, expression engine, runtime, UI, budgets, roadmap |
| [Implementation status](docs/implementation.md) | What exists today, API examples, tests, size, and what is next |

## Direction

- TypeScript 7.0.2 (`tsc -b`, project references)
- Zero runtime dependencies
- Shadow-DOM web component, like [Nobita](https://github.com/TommyKammy/Nobita)
- Safe expression engine by default; host-injected code execution as opt-in
- Plain JSON workflows and run data
- Host adapters for storage, credentials, HTTP, scheduling, and webhooks

## Non-goals for v1

AI agents, 1,000 integrations, forms, evaluations, RBAC/SSO, queue mode,
collaboration, version history, and enterprise features.

## License

Draflow is released under the [MIT License](LICENSE).

### n8n notice

n8n is licensed under the Sustainable Use License, not an OSI license.
Draflow is a clean-room implementation based on observed behavior and public
interfaces. No n8n source code, CSS, or assets are copied.
