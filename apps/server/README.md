# Draflow Node host

Run `pnpm install`, `pnpm --filter @draflow/server build`, then `pnpm --filter @draflow/server start /path/to/draflow.sqlite`. Use a local filesystem and Node 22.13.0 or later. The process owns the database exclusively. It starts one FIFO worker and restores intake and queued work on startup.

The trusted local CLI accepts one JSON object per line on stdin and returns one JSON response per line on stdout. Keep stdin open while the worker runs. To publish, send `{"op":"publish","workflow":...}` with a complete Draflow document. The response contains its revision. For example, with document ID `orders` and trigger node ID `incoming`:

```jsonl
{"op":"activate","workflowId":"orders","revision":1}
{"op":"accept","workflowId":"orders","triggerNodeId":"incoming","event":{"key":"order-42","items":[{"json":{"order":42}}]}}
{"op":"byEvent","workflowId":"orders","triggerNodeId":"incoming","key":"order-42"}
{"op":"stats"}
{"op":"history","workflowId":"orders"}
```

Use `receipt` with a run ID, `detail` with workflow and run IDs, and `deactivate` with a workflow ID. The CLI loads the standard nodes. An embedding Node application can construct `NodeHost(path, { registry, ...engineOptions })` to use its own node implementations or injected services. The host's `history` implements the P6 ExecutionStore interface used by P7.

## Delivery and recovery

- A successful accept returns the run ID after the SQLite commit. A queued receipt contains its own work item, payload and publication revision. Switching or deactivating the publication affects subsequent intake. Active and queued publications must have their exact node versions installed on restart.
- Defaults are 100 waiting jobs plus one running job, a 24-hour deduplication window from acceptance, and 4 MiB per history detail. Configure these with `capacity`, `dedupMs`, and `maxDetailBytes`. A matching workflow, trigger and key returns the existing ID even at capacity. Queued and running work retains its key through completion. Interrupted work keeps its key beyond expiry so that redelivery returns the original receipt while its external effects need reconciliation. Identical keyless events get separate IDs.
- A restarted worker processes queued rows. A durable running claim becomes `interrupted` and requires reconciliation with the external destination. The error history identifies the interruption and the absence of recovered task data. Completed runs retain their outcome. Deleting browsing history leaves the receipt intact.
- Completion and history are committed together. If that transaction fails, the worker closes intake, reports the fault and leaves the claim for recovery. On EOF, SIGTERM or SIGINT, the CLI closes intake, leaves queued jobs for restart, and waits up to five seconds for the current job before exiting. Programmatic callers can set a deadline with `close(ms)`.
- Receipts retain the acceptance, claim and completion timestamps. Stats expose waiting count, oldest wait, failed and interrupted counts. This first release retains receipt and publication metadata on disk. Detail size and the deduplication window can be tuned independently.

## Verification and timing

`pnpm --filter @draflow/server test` exercises real database files and SIGKILL at four boundaries. CI also runs the compiled tests on Node 22.13.0. The browser suite opens recovered completed and interrupted records in P7.

Run `node apps/server/test/latency.mjs` after the build to measure 100 serial events against a fresh local file. With a two-node workflow and one item on the development machine, p95 admission was 1.03 ms, queue wait 1 ms, and engine time 1 ms. Use 5 ms p95 for each stage as the initial local regression budget for this unloaded fixture. Queue and engine timestamps have millisecond resolution. Disk, load and workflow costs affect these values independently.

## HTTP credentials

Publish an HTTP Request node with `typeVersion: 2`, `parameters.authentication: "credential"`, and a reference such as `credentials: { "httpAuth": "orders-read" }`. Place only the reference in the workflow. To disable authentication, remove the reference and select None. A conflicting reference or unknown mode fails before provider lookup. The browser can edit and export the document and inspect server history. An editor run that requires this credential fails before fetching.

For the CLI, set `DRAFLOW_HTTP_AUTH_FILE` to a server-local JSON file and populate the named secret in the server process environment. This example grants one node access to one API origin:

```json
{
  "grants": [
    { "workflowId": "orders", "nodeId": "api", "origin": "https://api.example.com", "id": "orders-read", "kind": "apiKey", "header": "X-API-Key" }
  ],
  "environment": { "orders-read": "ORDERS_READ_KEY" }
}
```

Use `"kind": "bearer"` for an Authorization bearer token. Embedded hosts can pass `httpAuth: { grants, resolve(id) }` to NodeHost. The transport checks the workflow, node, slot and exact origin before calling the provider. Authenticated requests use HTTPS (loopback HTTP is supported for local services), reject conflicting credential headers and disable redirects.

The server limits each standard HTTP response to 1 MiB by default. Configure `maxHttpResponseBytes` or `DRAFLOW_HTTP_MAX_RESPONSE_BYTES` to override it. Both v1 and v2 count streamed body bytes and cancel oversized responses, including error bodies. A successful response supplies its ordinary business data to subsequent nodes and the existing execution-history policy. A response reflecting the credential value in text or a decoded JSON key/value fails before reaching workflow output. Server-side failures retain the HTTP status or a diagnostic category; upstream error bodies, status text, response headers, transport exceptions and provider exceptions are excluded from history.
