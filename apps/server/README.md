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

For `byEvent`, pass `source` (`trigger`, `webhook`, or `schedule`) to look up a specific intake. Omitting it returns the most recently accepted matching delivery.

Use `receipt` with a run ID, `detail` with workflow and run IDs, and `deactivate` with a workflow ID. The CLI loads the standard nodes. An embedding Node application can construct `NodeHost(path, { registry, ...engineOptions })` to use its own node implementations or injected services. The host's `history` implements the P6 ExecutionStore interface used by P7.

## Delivery and recovery

- A successful accept returns the run ID after the SQLite commit. A queued receipt contains its own work item, payload and publication revision. Switching or deactivating the publication affects subsequent intake. Active and queued publications must have their exact node versions installed on restart.
- Defaults are 100 waiting jobs plus one running job, a 24-hour deduplication window from acceptance, and 4 MiB per history detail. Configure these with `capacity`, `dedupMs`, and `maxDetailBytes`. A matching workflow, trigger node, delivery source and key returns the existing ID even at capacity. Queued and running work retains its key through completion. Interrupted work keeps its key beyond expiry so that redelivery returns the original receipt while its external effects need reconciliation. Identical keyless events get separate IDs.
- A restarted worker processes queued rows. A running claim outside a recorded HTTP node becomes `interrupted` and requires reconciliation with the external destination. The error history identifies the interruption and the absence of recovered task data. Completed runs retain their outcome. Deleting browsing history leaves the receipt intact.
- Completion and history are committed together. If that transaction fails, the worker closes intake, reports the fault and leaves the claim for recovery. On EOF, SIGTERM or SIGINT, the CLI closes intake, leaves queued jobs for restart, and waits up to five seconds for the current job before exiting. Programmatic callers can set a deadline with `close(ms)`.
- Receipts retain the acceptance, claim and completion timestamps. Stats expose waiting count, oldest wait, failed and interrupted counts. This first release retains receipt and publication metadata on disk. Detail size and the deduplication window can be tuned independently.

## Durable waits and recorded HTTP

The [approval example](../../examples/approval.json) accepts a signed application with an `applicationId` and an absolute `deadline` in the webhook body. Set the registration URL before publishing. An event Wait requires an absolute deadline and a time Wait requires an absolute wake-up time, expressed as epoch milliseconds or ISO time with a timezone. Waiting releases the worker. The host saves up to 8 MiB of execution state per checkpoint, retains the publication and excludes suspended time from the execution timeout. Completion removes the checkpoint. Deleting history leaves live waits intact.

Use `{"op":"waitInfo","runId":"…"}` on the trusted CLI to obtain the current wait's token, mode and deadline. The application authenticates the approver and authorizes the decision before submitting it. Pass the token in the Authorization header when calling the webhook server, or use the trusted CLI commands below. Tokens are specific to one wait and grant authority to complete it. Keep them out of logs and use HTTPS for remote callbacks.

```http
POST /resume/<runId>
Authorization: Bearer <wait token>
Content-Type: application/json

{"decision":"approved"}
```

An accepted callback returns HTTP 202 and the original run ID. The JSON object (up to 64 KiB) appears in each outgoing item's `json.wait.data`; `json.wait.reason` is `event`, `time` or `expired`. Cancellation terminates the run. Once the deadline is reached it takes precedence over a new decision. A consumed token cannot advance another wait.

```jsonl
{"op":"resume","runId":"…","token":"…","data":{"decision":"approved"}}
{"op":"cancelWait","runId":"…","token":"…"}
{"op":"transitions","runId":"…"}
{"op":"effects","runId":"…"}
```

HTTP Request v2 offers optional recorded delivery. Use `keyed` only when the receiver honors the `Idempotency-Key` header throughout the recovery window. Use `manual` to require reconciliation after an uncertain send. Each input item in each visit gets its own operation key. After a crash the node reuses confirmed outputs. For a keyed operation it retries the same request with the same key. A changed request fingerprint or an uncertain manual operation requires review. Ordinary workflows keep their existing retry behavior.

When a receipt is in `review`, inspect `effects` and check the destination. Confirm a successful external operation with its normalized response, or confirm that nothing was applied and authorize another send. For a receiver that honors idempotency keys, use `retryKeyed` to retry an uncertain operation with the same key and request fingerprint. The CLI returns whether the decision was accepted.

```jsonl
{"op":"reconcile","runId":"…","key":"…","decision":"applied","result":{"id":"external-id"}}
{"op":"reconcile","runId":"…","key":"…","decision":"notApplied"}
{"op":"reconcile","runId":"…","key":"…","decision":"retryKeyed"}
```

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

To authorize an authenticated HTTP node during a CLI test, add a grant for the returned `workflowId`, the HTTP node ID, credential ID and API origin to the configured `DRAFLOW_HTTP_AUTH_FILE`. Keep the environment variable holding the secret in the CLI process environment. Send `{"op":"reloadHttpAuth"}` on stdin, then deliver to the same test URL. This operation replaces the grants and environment-variable mappings for subsequent HTTP requests. An invalid configuration leaves the previous configuration active. Remove the test grant and reload to revoke it.

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

## Published subworkflows

Publish the child first. Give it one enabled `draflow.childInput` with the permitted parent workflow IDs in its `callers` array, and connect that entry to a terminal `draflow.return`. In the parent, configure `draflow.call` with the child’s literal `workflowId` and numeric published `revision`. The host validates permission, return path, nesting depth (default 8) and recursion at parent publication. Each child uses its own HTTP credential grants. Publishing a new child revision takes effect when a new parent revision references it.

The parent waits while the child runs or awaits an event. Its call output contains the returned rows in order with their input lineage. Empty upstream output skips the call under the normal flow rules. A child that filters out all rows returns an empty output. Child errors follow the call node’s error policy. The SQLite ledger records the parent and child run IDs independently of saved execution details.

## Cursor paging and batches

Publish [the order batch child](../../examples/process-order-batch.json), then publish and activate [the scheduled order import](../../examples/order-import.json) with its exact child revision. Replace the example source and destination URLs, configure their credential grants where needed, and use a destination that honors the idempotency key on registration.

The `draflow.pages` node takes the same child target as a call. It sends GET to a fixed URL with `limit` and, after the first page, an opaque `cursor`. The response must contain an `items` array of JSON objects and a `nextCursor` string or null. A null cursor completes the scan. An empty page with a new cursor continues. Use a stable snapshot at the source when the job must account for every row while the source changes.

| Parameter | Default | Meaning |
| --- | ---: | --- |
| pageSize | 100 | Maximum number of rows in one response |
| batchSize | 25 | Maximum number of rows per sequential child run |
| maxPages / maxItems | 10,000 / 1,000,000 | Limits for the entire scan |
| maxBytes | 268,435,456 | Cumulative response byte limit (the server also limits each response) |
| maxAttempts | 5 | Maximum attempts for a throttled page read |
| deadlineMs | 86,400,000 | Time budget checked at page dispatch and when scheduling retries |
| sumField | empty | Optional numeric source field to total over successful batches |

The host saves the current page before starting a batch. Each successful child advances the confirmed count and optional total. The last batch releases the page and commits its next cursor in the same transaction. The parent receives one item with `pages`, `batches`, `items` and `total`. A repeated or expired cursor fails the scan at its last confirmed position. HTTP 429 and 503 use Retry-After or exponential backoff capped at 60 seconds. Other jobs can run between batches and while the scan awaits its retry time.

The trusted JSON-lines CLI accepts the following requests. Use `progress` to inspect counts, retry time, child relations and uncertain effect keys, and `relations` on a child to find its parent. History replay also exposes the progress and related run IDs.

```jsonl
{"op":"progress","runId":"<parent-run-id>"}
{"op":"relations","runId":"<child-run-id>"}
{"op":"cancel","runId":"<parent-run-id>"}
```

Cancellation applies to the run and its unfinished descendants. Confirmed external writes remain effective. An outstanding write with an unknown outcome stays available for reconciliation on the child run. A canceled tree cannot initiate another page or batch after restart.

## Incremental sync

On a terminal `draflow.pages` node of a root workflow, set a stable literal `syncScope` and, for keyed delivery, `keyLifetimeMs` (the receiver's guaranteed idempotency-key lifetime in milliseconds). The child must connect Subworkflow input → recorded HTTP v2 → Return, with stop-on-error. Choose keyed delivery for an idempotent receiver or manual reconciliation for an uncertain non-idempotent write. The source and sink must agree on the meaning of upserts and deletions.

The fixed GET endpoint receives `limit`, optional `cursor` for the next page, and the last completed round's token in `since`. Each item carries a nonempty string `id`, a nonnegative safe-integer `version` increasing per entity, and `op` equal to `upsert` or `delete`. The child receives the entire row. A terminal page supplies a nonempty `syncToken`, even for a round with zero changes. For example:

```json
{"items":[{"id":"order-8","version":3,"op":"delete"}],"nextCursor":null,"syncToken":"round-42"}
```

The source must provide a consistent change feed including tombstones and declare its token expiry. Each confirmed write advances the stored entity version in the transaction recording that write. The host retains the maximum version (including deletions) for the lifetime of the scope. Duplicate and older versions count toward the scan’s maxItems limit. Only confirmed changes contribute to the output count and sum. Duplicate and older versions produce no external call. A round commits its token only after all batches succeed. Distinct overlapping runs wait in SQLite and take turns reading from the latest committed token. The progress operation exposes the blocking run ID as `waitingForSyncRun`. A failed owner holds its scope until redrive or explicit reset. An identical delivery key returns its original receipt within the intake deduplication window.

The scope belongs to the workflow ID, pages node ID and syncScope value, and binds its URL, credential binding and child publication. A changed source/filter/destination contract needs an explicitly provisioned scope and initial import. For HTTP 410, or to abandon a failed round, send `{"op":"resetSync","workflowId":"order-import","nodeId":"pages","scope":"orders"}` before starting the next run. This clears the token, preserves applied versions and invalidates the abandoned recovery point. An active child or an unknown send must be settled first. A full rescan requires the source to include deletions relevant to the receiver; absence of a row does not imply deletion.

## Redriving a failed operation

Incremental pages enable recovery automatically. For a regular terminal pages node with a recorded HTTP child, or a recorded HTTP v2 step in a root workflow, opt in with `allowRedrive: true`. Recovery material is kept independently of detailed history for `redriveRetentionMs` (default seven days). The original receipt ID, pinned workflow revision, page position, child input, successful results and operation keys are reused. The host also records each failure and its subsequent attempt. Deleting execution history leaves the recovery point available until its deadline.

```jsonl
{"op":"recoveryInfo","runId":"<original-run-id>"}
{"op":"redrive","runId":"<original-run-id>","failureId":"<failure-from-recoveryInfo>"}
{"op":"recoveryInfo","runId":"<returned-attempt-id>"}
```

A failure ID admits one attempt, including across a restart. A subsequent failure gets its own ID. Recovery info exposes the failed node, visit, child, reason, expiry, whether data is retained, attempt ID and outcome. A run without a safe saved point has an empty list. Unknown sends remain in review: reconcile them as applied or notApplied, or request retryKeyed within the receiver's valid key window on incremental pages. The host checks that window again after resolving credentials, immediately before transport dispatch. Canceled runs and expired points cannot start another attempt. Credentials are resolved against current grants for the pinned revision.
