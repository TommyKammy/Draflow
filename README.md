# Draflow

**Lightweight, fast, zero-dependency workflow automation — embeddable anywhere.**

Draflow is a from-scratch workflow editor and runtime inspired by n8n's interaction
model: a canvas of nodes, step-by-step execution, side-by-side input/output data,
drag-to-map expressions, pinning, partial runs, and execution logs.

The goal is not to reimplement n8n's 1,000 integrations. The goal is to port the
**core loop** — run, inspect, wire, re-run — in a package small enough to embed in
any web app.

> Status: **core engine implemented; editor UI next.**
> 73 tests passing. Core + standard nodes: **43.4 KB gzip**.

## Quick start

```bash
pnpm install
pnpm typecheck
pnpm test

pnpm build
node examples/run-workflow.mjs
pnpm size
```

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
