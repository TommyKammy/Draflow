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

## Webhook intake

Add a `draflow.webhook` v1 trigger with a literal `parameters.path` such as `orders`. Use 1–100 ASCII letters, digits, hyphens or underscores. Publishing saves the document. Activating it registers its enabled Webhook nodes as `POST /webhook/<path>`. Activation replaces the document's routes atomically. A duplicate path rejects the entire activation and leaves the previous routes serving. Deactivation removes its routes. Active production routes survive restart. An upload must finish within the same activation. Deactivation or a revision switch invalidates pending uploads, including when the original revision is later restored. Repeating activation of the current revision preserves them.

Enable the CLI listener by setting `DRAFLOW_WEBHOOK_PORT` and `DRAFLOW_WEBHOOK_SECRET` before starting the host. The listener binds to loopback by default; `DRAFLOW_WEBHOOK_HOST` changes the bind address. The CLI uses one signing key for its senders. Embedders can call `createWebhookServer(host, { signingKey, maxBodyBytes })` with a key or a function that selects a key by exact request path. The listener resolves the signing key after the bounded body has arrived, so a rotation applies to deliveries still uploading. Management operations remain on the trusted CLI or host API.

For a test delivery, send the CLI operation `listenTest` with the draft `workflow`, its `triggerNodeId` and optionally `ttlMs` (default 60 seconds, maximum one day). The returned `path` is a unique `/webhook-test/<token>`. Its `workflowId` identifies the isolated test snapshot for history and credential grants. Arming a test does not activate the draft or inherit production grants. Test URLs expire on timeout or restart. Already accepted test jobs retain their snapshot for recovery.

Sign the exact raw UTF-8 JSON bytes. With Node's `createHmac` from `node:crypto`, a sender can use:

```js
const bytes = Buffer.from(JSON.stringify({ order: 42 }));
const path = '/webhook/orders';
const delivery = 'order-created-42';
const signature = createHmac('sha256', signingKey)
  .update(path + '\n' + delivery + '\n').update(bytes).digest('hex');
const response = await fetch(origin + path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Draflow-Delivery': delivery,
    'X-Draflow-Signature': 'sha256=' + signature,
  },
  body: bytes,
});
```

Use the returned test path verbatim when signing test requests. The optional delivery ID is 1–256 printable non-space ASCII characters. To send an independent event, omit its header and sign with an empty delivery field. The workflow receives a single item with `json.body` containing the verified JSON value. Signatures and HTTP headers are excluded from the workflow.

A committed acceptance returns HTTP 202 and `{"runId":"…"}`. Redelivery of a signed event ID follows the host's deduplication window. Both intake modes share the bounded worker queue and use independent deduplication scopes. Invalid JSON or delivery headers return 400, failed signatures 401, unknown or expired routes 404, unsupported methods 405 and oversized bodies 413. The raw body limit defaults to 1 MiB and can be changed with `DRAFLOW_WEBHOOK_MAX_BODY_BYTES`. Queue or storage unavailability returns 503.

## Scheduled triggers

Add a `draflow.schedule` v1 node and activate its published workflow. The Node host starts the timer automatically. Each accepted run starts at its own schedule node with one item, `{ "scheduledAt": "<UTC ISO timestamp>" }` in `item.json`. The timestamp is also the delivery key used by `byEvent`.

| Mode | Literal node parameters | Timing |
| --- | --- | --- |
| Interval | `{"mode":"interval","intervalSeconds":60}` | Whole seconds from 1 to 31536000. The first occurrence is one interval after activation; later occurrences retain that phase. |
| Cron | `{"mode":"cron","cron":"30 9 * * 1","timezone":"Asia/Tokyo"}` | Every Monday at 09:30 in Tokyo. The five fields are minute, hour, day of month, month and weekday (Sunday = 0). |

Cron v1 accepts a numeric minute (0–59); each other field accepts one number or `*`. Choose either a day of month or a weekday when restricting the day. Use interval mode for recurring sub-hour periods. A named IANA zone is required. A nonexistent local minute is skipped at a forward clock change; a repeated local minute has one firing at its first occurrence. Invalid schedules reject activation and preserve the previous revision.

Scheduled delivery keys stay reserved with their receipts across deactivation and restart, including when the wall clock moves backwards. The deduplication window for ordinary incoming events still applies to those events. The next due instant is persistent. Advancing it and admitting work share one SQLite transaction. After downtime, each active schedule admits only the **latest** missed occurrence and resumes its original cadence. A full queue retains the cursor and retries, coalescing newly missed times by the same rule. Repeating activation of the same revision preserves its schedule. Switching revisions or reactivating after deactivation starts a new schedule from that activation time. Previously accepted jobs keep their original revision.
