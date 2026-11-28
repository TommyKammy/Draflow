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

## Parallel batches

Set `draflow.pages.parameters.concurrency` to 2–32 on a terminal root page node to process independent batches on the same page concurrently. The default is 1. Each child uses the direct recorded HTTP contract described under incremental sync. Set the Node host option `maxParallelBatches` or CLI environment variable `DRAFLOW_MAX_PARALLEL_BATCHES` to cap simultaneously executing page batches across imports (default 4, range 1–32).

`orderKey` names a string or numeric source field, default `id`. Adjacent batches with disjoint keys can run together. A repeated key in a later batch waits for the preceding group. Within a batch the HTTP node sends in input order. For ordinary pages, an empty field explicitly declares rows independent. Incremental sync uses `id` and serializes rounds sharing a sync scope. Use concurrency 1 when the receiver requires global input order.

The ledger saves the outcome of each child and commits the cursor after the last successful batch on the page. The total uses source order. A failed group retains its recoverable children until the configured redrive expiry. Use the same `recoveryInfo`, `redrive`, `progress`, and `reconcile` operations as for sequential sync. A canceled import retains confirmed effect keys and exposes outstanding sends for reconciliation.

A 429 or 503 received during parallel page reads or batch writes establishes a durable cooldown for the origin and credential ID (anonymous requests share the origin). Subsequent requests through the host credential-aware HTTP transport observe that deadline, including after restart. Already-dispatched requests may still complete. Page reads enter the retry scheduler. A read deferred before dispatch retains its attempt budget and remains subject to the original deadline. A first write waiting locally for the cooldown remains unsent until dispatch. An ambiguous write uses the recorded delivery policy.

## Compensating a sequence of operations

On a recorded HTTP v2 node in a linear, stop-on-error root workflow, configure a literal `compensation` object, for example:

```json
{"workflowId":"refund-payment","revision":1,"order":10,"onFailure":true,"when":{"field":"refundable","equals":true}}
```

Publish the target child first. It must authorize the original workflow in its callable entry and directly connect that entry to a recorded HTTP v2 node and then Return. Each compensable node has a distinct integer order. Smaller values run first. Matching items within the same step run in their original order. The optional condition tests a top-level field on the original input. Each child receives one item containing `input`, the confirmed original HTTP `result`, and `sourceKey`. Use the receipt ID from `result` to reverse the specific business operation. The child uses its own credential grant and a separate delivery key. The ledger retains the source input and confirmed result independently of execution history.

```jsonl
{"op":"compensate","runId":"<original-run-id>"}
{"op":"compensationInfo","runId":"<original-run-id>"}
{"op":"retryCompensation","runId":"<original-run-id>","failureId":"<failed-step-id>"}
```

An explicit request on a settled run returns the durable compensation ID. Repeating it returns the same ID. If a confirmed matching step has `onFailure: true`, a terminal error starts compensation automatically. An interrupted original run can have an unknown outcome for an unrecorded operation. Check its receipt and the external system before deciding how to resolve it. Automatic compensation requires a confirmed terminal error. Ordinary cancellation preserves the original recorded effects. In-flight original operations require reconciliation before an explicit reversal. Once compensation has started, the original run cannot start another redrive.

The original receipt keeps its outcome. `compensationInfo` returns that outcome, the compensation ID, state (`idle`, `compensating`, `review`, `manual`, or `compensated`), and ordered step records. For `review`, inspect the child’s effect and reconcile its key using the existing CLI. Keyed crash recovery requires the receiver to preserve the key across the recovery interval. Use manual delivery when it cannot. A failed, unsent compensation can be retried by its failure ID; repeated requests return the original retry ID. A completed reversal is never invoked by a later step's retry.

## Shared PostgreSQL ledger and worker roles

The SQLite CLI still takes a database path and runs one exclusive host. Setting
`DRAFLOW_ORGANIZATION` binds that file to the organization on its next open.
Subsequent opens must supply the same ID. Existing unbound files can continue
using the original command.

For shared execution, build the server with its optional `pg` dependency. Point
`DRAFLOW_POSTGRES_URL` at a writable PostgreSQL endpoint and supply a nonempty
`DRAFLOW_ORGANIZATION`. Run the CLI without a filesystem argument.

```sh
pnpm --filter @draflow/server build
DRAFLOW_ROLE=intake node apps/server/dist/cli.js
```

Start additional processes with the same database and organization. Keep CLI
stdin open when supervising the JSON-lines service. Use roles as follows.

| Role | Responsibility |
| --- | --- |
| `intake` | Accept commands and events, query receipts, serve configured webhooks |
| `scheduler` | Advance due schedules, timed waits and retry deadlines |
| `worker` | Claim runs, execute children, renew leases and recover expired owners |
| `all` (default) | Run all three responsibilities in one process |

Use at least two scheduler-capable hosts for timer availability. Supply the
same node registry and organization-bound HTTP grants to replicas. Include
`organization` in the JSON loaded by `DRAFLOW_HTTP_AUTH_FILE`. Each host binds
its ledger session to a single organization schema. Schema creation requires
a trusted database service credential. The CLI and its role setting are
trusted deployment interfaces. End-user authentication and role authorization
are planned for 7.3. Route webhook traffic and signing keys by organization.
Temporary test-webhook listeners are local to the registering session.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `DRAFLOW_LEASE_MS` | 15000 | DB-clock run lease in milliseconds, minimum 500 |
| `DRAFLOW_POLL_MS` | 250 | Worker/scheduler poll interval in milliseconds, capped at one third of the lease |
| `DRAFLOW_ORG_ACTIVE_RUNS` | 32 | Active runs per organization |
| `DRAFLOW_MAX_PARALLEL_BATCHES` | 4 | Concurrent parallel batch children per organization |
| `DRAFLOW_TARGET_CONCURRENCY` | 4 | Concurrent transport permits per destination account |
| `DRAFLOW_RATE_ACCOUNTS` | `{}` | JSON mapping of local credential IDs to shared upstream account names |

Configure the same limits on replicas. Anonymous HTTP requests share a limit
per origin. Credentials are scoped by origin and organization unless mapped to
the same upstream account, for example `{"orders-key":"warehouse-production"}`.
Use that mapping in every organization sharing the account. A 429 or 503
publishes its cooldown for other workers. A permit expires with a lost owner.
An upstream request already in flight can outlive that lease. Choose a lease
that accommodates normal application and database stalls.

### Move a Phase 6 SQLite ledger

1. Stop the original host and pause new admissions. Keep a backup of the closed
   SQLite file. Configure the target organization, PostgreSQL URL, and account
   mapping and concurrency as for the eventual workers. Keep target hosts off.
2. Run `node apps/server/dist/migrate.js /absolute/path/to/ledger.db`. The tool
   reads a consistent snapshot and writes one destination transaction. Keep the
   returned table counts and fingerprint. A retry of the identical source
   returns the same fingerprint. A nonempty destination or changed source
   prevents a fresh import.
3. Verify counts, pinned revisions and in-flight receipts using the intake
   role. Before accepting new work on PostgreSQL, rollback consists of opening
   the original SQLite file. After admitting work there, switching back
   requires reconciliation of the two histories.
4. Switch intake traffic, then enable workers and schedulers. Keep receiver
   idempotency records through the cutover and recovery window.

### Failover and restore

Use synchronous replication for acknowledged-write durability, a single writable
endpoint and a supervisor for the CLI. On primary loss, fence the old primary,
promote a synchronized replica, switch the writer endpoint and restart failed
hosts. Rebuild or rewind the old primary as needed before rejoining it as a
read-only standby. Restore synchronous redundancy before relying on protection
from a further failure. Retrying the same event key recovers an admission whose
commit response was lost. Worker ownership uses database time and a generation
checked on ledger writes. Stable delivery keys protect recorded sends where
the receiver honors them. Reconcile unknown manual sends or expired keys
against the upstream receipt before authorizing another attempt.

Restore backups into an isolated database. Inspect receipts with an intake
process before connecting live traffic or starting any execution roles.
Compare downstream receipts since the backup with the restored ledger,
especially irreversible deliveries and compensations. The physical failover
and isolated backup drill can be run with `node apps/server/test/postgres-ha.mjs`
on a Docker host. The contract and worker process tests use a disposable
database identified by `DRAFLOW_TEST_POSTGRES`.

## Operator API and console

Set `DRAFLOW_OPERATOR_PORT`, `DRAFLOW_ORGANIZATION` and `DRAFLOW_OPERATOR_ACCOUNTS` on the CLI serving operators. Open `/operator/` on that port. The listener defaults to `127.0.0.1`; terminate HTTPS at the reverse proxy for remote operators. SQLite uses one organization-bound host. A PostgreSQL intake can serve the console while separate worker and scheduler processes run the workflows. The first upgraded PostgreSQL process upgrades its organization's schema to version 3. Coordinate the binary rollout per organization: version-2 binaries reject version 3 on startup. The editor, local JSON-lines CLI, and worker protocol keep their existing entry points. The local CLI and direct host API are trusted deployment interfaces; expose only the authenticated HTTP listener to operators.

The account file is a JSON array. For each person and organization, provision a separate high-entropy bearer token (e.g. 32 random bytes encoded as base64url). Store its lowercase SHA-256 hex digest in the file and deliver the token to the operator privately. Each request authenticates against the current file and then checks the organization's ledger policy inside the same transaction as the operation. Removing the token revokes access on the next request. Browser tokens are held in memory until logout or reload.

```json
[
  {"organization":"orders","actor":"oncall","role":"operator","grants":["reconcile"],"sha256":"<64 hex characters>"},
  {"organization":"orders","actor":"release-manager","role":"publisher","sha256":"<different digest>"}
]
```

| Role | Allowed operations within the authenticated organization |
| --- | --- |
| viewer | Session permissions, filtered runs, safe execution details, history summaries, metrics, audit |
| operator | Viewer operations plus starting an active trigger, resuming, canceling and redriving |
| publisher | Viewer operations plus publishing and activating revisions |
| admin | All operations, including membership changes |
| disabled | Access revoked |

An operator can additionally receive `reconcile`, `compensate` (including retry), and `credentials` independently. `membership` sets the policy for an actor in the local ledger and takes precedence over the account's initial policy. Credentials continue to use the host's workflow/node/origin grants. The `credentials` operation enables/disables a granted ID or selects a preconfigured version. To rotate a secret, provision the version on every worker first. The optional `versions` object in `DRAFLOW_HTTP_AUTH_FILE` maps credential IDs to version names to environment variable names, for example `{"orders-key":{"rotation-2":"ORDERS_KEY_V2"}}`. Send `credentialVersion:"rotation-2"` with `enabled:true` to select it, or `credentialVersion:null` to restore the default. The worker rechecks the active credential version and destination grant after lookup and rate-limit waits, just before dispatch. An already dispatched request cannot be recalled. The same ID can resolve to different values in different organizations. Configure separate webhook signing keys for each organization's listener.

### Preview a draft before publication

In Operator Console, sign in as a publisher or admin, open **公開前の影響を確認**,
choose a workflow JSON file and select **影響を確認**. For `examples/order-sync.json`,
both the orders webhook and the 60-second schedule can read `GET /orders`
with `orders-read` and send `POST /totals` with `orders-send`. Conditions and empty
inputs can skip the write. The receipt and execution history describe what actually ran.

Hosts can call `host.previewPublication(workflow)`. The trusted local CLI and authenticated
operator HTTP POST accept `{"op":"preview","workflow":...}`. HTTP requires the current
organization's publish permission. Preview validates the draft using publication-time node
resolution and target checks. It allocates no revision, registers no trigger, resolves no
credential and performs no I/O to the workflow's destinations.

Each trigger reports possible effects, including the owning workflow, pinned revision
(`null` for the draft), node, execution or compensation phase, operation kind, and credential
references. For HTTP, `destination` contains origin and path only. A dynamic URL or method
is `null`; headers, bodies, URL query, fragment, userinfo and expression source are omitted.
Read/write describes the requested HTTP method. The receiver defines its behavior and the
host checks its credential grants at dispatch. A literal template such as `=POST`
reports its fixed value. A statically incompatible authentication mode and credential
binding yields `blocked` with no credential use. Anonymous HTTP requests report
`mayRedirect: true` because the receiver can redirect the request to another destination.
Credentialed requests and page reads reject redirects. Pinned child workflows are resolved in the
current organization's ledger. Preview follows all reachable branches and disabled-node
pass-through without evaluating data or simulating a run.

For a host-defined node, optionally declare `meta.externalEffect` as `read`, `write`, or
`none` on the registered node type. Omission produces `undeclared`; the workflow document
cannot override this declaration. Large previews fail as a whole at 50,000 node visits
or 1 MiB of effect records.

#### Compare a draft with the active revision

Select **稼働版と比較** before **影響を確認**, or send
`{"op":"preview","compareActive":true,"workflow":...}` as a publisher or admin.
Hosts can call `host.comparePublication(workflow)`. The comparison captures the
active revision of the same workflow in the current organization. A newer,
inactive publication does not change the baseline. With no active revision,
`activeRevision` is null and every draft trigger and effect is an addition.

Each entry in `changes` describes one trigger. `before` and `after` describe
its previous and proposed start conditions. A missing side is null.
`removed` and `added` list the old and new effects, including pinned child
revisions and compensation. `addedCalls` and `removedCalls` identify each distinct
caller and its pinned target, including page batches. They also track the source
step, priority, automatic-start flag and applicability of each compensation.
A changed compensation predicate appears on both sides, with its field and value
redacted. A destination or credential replacement appears on
both sides. Trigger and node IDs establish identity, so renaming or reordering
nodes alone produces no change. This comparison covers the preview's visible
fields. Input filters, expressions behind dynamic values, query strings,
headers, bodies and custom implementation details can change behavior without
changing those fields. The comparison is read-only and reflects the reported
baseline revision at the time of the request.

### Requests and recovery

Use `Authorization: Bearer <token>` on `/operator/<encoded-organization>/api`. Read via GET query parameters. Supported read operations are `session`, `list`, `detail` (id), `history` (workflow), `audit`, and `metrics`. The list accepts exact workflow/run IDs, revision, status and inclusive `from`/`to` epoch milliseconds. It returns up to 50 rows ordered by admission time and run ID. Supply the last row's `acceptedAt` as `before` and its run ID as `afterId` for the next page. History and execution details expose metadata; request bodies, upstream results, secret values and wait tokens are omitted. External operation keys are visible for looking up upstream receipts.

Run detail includes `guidance: { reason, actions }` for the authenticated caller.
The reason is independent of permission. Event and timer waits use `awaitingEvent` and
`awaitingTime`, an overdue event awaiting scheduler processing uses `eventExpired`, and
a pinned publication incompatible with the current host uses `publicationUnavailable`.
Pending cancellation uses `cancelRequested`, a retained redrive point uses
`recoverableFailure`, and other reasons use
the operator status or the finished outcome. Each action names an existing mutation
in `op`. A redrive carries its `node` and `failure`, a compensation retry its
`failure`, and reconciliation its `node`, `key`, and available `decisions`.
For example, a viewer and an operator can both see `reason: "awaitingEvent"`;
only the operator can receive resume and cancel actions. A successful detail read
performs no recovery. Use the returned run ID and version when submitting a
decision. Authorization, retention and receiver retry windows are checked again
at submission. Reload detail after a conflict.

Use POST with `Content-Type: application/json` for mutations. Supply a unique `request` (a UUID is suitable), `target`, and a structured `reason` chosen from `receiver-confirmed`, `receiver-absent`, `incident-recovery`, `release`, `access-change`, or `operator-request`. Recovery commands require the `version` returned by a fresh detail read. A repeated identical request from the same authorized actor returns its committed result. A stale or conflicting decision returns HTTP 409; reload detail and inspect the current state. The console does this automatically. An accepted mutation and its organization, actor, reason, target, timestamp and result commit together. Audit rows survive execution-history deletion. Query audit by optional exact `target`. The latest 100 entries are returned. For older entries pass the final row's `stamp` as `before` and its `request` as `afterRequest`. Rejected authenticated ledger mutations record an error status separately from accepted requests. Unknown targets in rejected requests are hashed.

| Operation | Target and additional fields |
| --- | --- |
| publish / activate | Workflow ID and `workflow` / `revision` |
| start | Workflow ID and `trigger`; calls pinned children through the published flow |
| resume / cancel / compensate | Run ID |
| redrive / retryCompensation | Run ID and `failure` from detail |
| reconcile | Run ID, operation `key`, `decision` and optional JSON-object `result` for the upstream receipt |
| membership | Actor ID and `policy`, e.g. `{"role":"operator","grants":["reconcile"]}` |
| credentials | Local credential ID, `enabled` and optional `credentialVersion` |

### Monitoring

The console shows the oldest queued and review ages, the last worker heartbeat, and failed compensation steps. `DRAFLOW_MONITOR_MS` sets the age threshold (default 30 seconds, minimum 1 second). The CLI samples at one quarter of the threshold, capped at one second, emits JSON monitor transitions on stderr, and records the latest active/cleared event per alert kind in the organization ledger. The screen links active and recently cleared alerts to their runs. A missing first heartbeat indicates that worker availability has yet to be observed. An existing review migrated from an older ledger uses its start/admission time until the next review transition. A separate intake process should host monitoring when it must remain available during a worker outage. Service-level monitoring of that intake and the database belongs to the deployment.

Run `node --test apps/server/test/operator.test.mjs` for the SQLite contract; set `DRAFLOW_TEST_POSTGRES` to a disposable PostgreSQL database for the shared contract and worker-loss drill. Run `node apps/server/test/operator-bench.mjs` with the same optional environment variable for the 100,000-history authenticated first-page benchmark. The browser regression is `pnpm exec playwright test operator.spec.mjs`.

## Prood business automation (Phase 8.1–8.2)

The optional Prood worker accepts committed project subscriptions and prepares the two permitted operations (assign a task or set its status). The Prood application owns authentication, rule revisions, delegation, task versions, the transactional subscription outbox and authorization audits. Each organization-bound Draflow ledger keeps a permanent receipt per project/event/rule and pins the generated proposal workflow. The receipt, publication binding and queued run commit atomically. The public rule format cannot introduce executable nodes, URLs, credentials or child workflows. Definitions without an explicit `apply: true` continue to prepare proposals. Phase 8.3 rules may delegate a status or assignee update.

Build both checkouts. With a migrated Prood deployment and its workspace ID:

```sh
PROOD_SQLITE_PATH=/data/prood.sqlite node apps/server/src/prood-worker.mjs /path/to/Prood wks_WORKSPACE_ID /data/draflow-organization.sqlite
```

For PostgreSQL, set `DATABASE_URL` for Prood and `DRAFLOW_POSTGRES_URL` for Draflow (the final path argument may be `:memory:` in shared mode). Run one logical binding per Prood workspace. The bridge claims only business proposals. Normal workers without a Prood callback leave proposals queued for a capable worker. Use separate SQLite files for the bridge and ordinary workers, or share the PostgreSQL ledger. Supervise this process as other Node workers. SQLite mode needs one Draflow writer per file. PostgreSQL supports replicas. Upgrade all Draflow processes per organization for schema v5 before enabling live rules. Offline cutover migrates permanent receipts, attempt counts and immutable publication bindings.

The authenticated Prood page at `/automation/review` previews a rule document and requests explicit delegation. Project managers use the same validation via `POST /api/v1/projects/:projectId/automation/:rule` with `op: preview|publish|stop`, the current revision (zero to create), and their own user ID as `delegate` when publishing. A manual start uses `op: start` and a task ID. Earlier events are not backfilled on publication. Rule edits keep already selected revisions; stopping a rule or changing its delegate invalidates earlier delegations. A later edit to the task conservatively skips a stale proposal.

The cross-checkout test is opt-in: set `PROOD_CHECKOUT` to the built Prood checkout and run `node --test apps/server/test/prood-business.test.mjs`. Set `DRAFLOW_TEST_POSTGRES` to a disposable PostgreSQL database to repeat using both PostgreSQL adapters. The Playwright test `apps/demo/test/prood-rule.spec.mjs` takes the same checkout path.


### Applying and reviewing Prood rules

Use the Automation link for the workspace, or open `/projects/<projectId>/automation` in Prood. Project managers select a template, a visible sample task and a target value, run the trial, and explicitly delegate publication. The review-assignment template matches a real status transition into the selected status while the task has no assignee. Trials use the latest relevant event on the sample; an old task version is reported as skipped. A manual template uses the current task. Project viewers can inspect the task and rule histories. Links ending in `?task=<taskId>` open the corresponding task history. Set `PROOD_DRAFLOW_OPERATOR_URL` on the Prood server to link managers to the Phase 7 operator console.

Each live rule has one operation per run and target. Prood commits the guarded task mutation, receiver receipt and derived Outbox event in one transaction. Replays check current access and the original input. Rules can opt into restoring the previous field value. An approved reversal needs a current delegation, a visible previous value and an unchanged task version. Choosing to keep or reverse an operation records one final decision.

Draflow persists the attempt count and makes up to three dispatches. If the response is still missing, it probes Prood for the receipt. An inconclusive lookup enters operator review. The operator decision “applied” performs another lookup; an authorized keyed retry uses the same run ID. Queued work and retries recheck cancellation before starting the mutation. This connector has no mail or arbitrary network action.

Cross-checkout fault and browser tests require a built Prood checkout with receipt migration 9:

```sh
PROOD_EFFECTS_CHECKOUT=/path/to/Prood node --test apps/server/test/business-effects.test.mjs
PROOD_EFFECTS_CHECKOUT=/path/to/Prood pnpm exec playwright test prood-studio.spec.mjs
```

Set `DRAFLOW_TEST_POSTGRES` to repeat the fault test with real PostgreSQL. For the latency comparison run `node apps/server/test/prood-latency-bench.mjs /path/to/built/Prood /path/to/built/Draflow`, optionally with a disposable `DATABASE_URL`. It measures synchronous task updates and the time from their return to durable admission for bursts of 20, with a 250 ms poll delay.

### Looking up a business receipt without dispatching a write

A host that provides `executeBusiness` can also pass `lookupBusinessReceipt(request)` to
`NodeHost`. Draflow uses this callback after the write retry budget is exhausted, for an
operator's applied-result check, and to settle an uncertain canceled run. With this option
enabled, the write callback receives only dispatch attempts. Existing Phase 8 integrations
continue to receive lookups through `executeBusiness(..., true, canStart)`.

The request contains the original organization, project, event, rule, revision and run.
Use the run as the operation key, verify the remaining identity and current access, and
read the receiver's durable receipt. Return an object with a `status`:

- `applied` or `skipped` records a confirmed outcome. `denied` and `conflict` end the run with an error.
- `absent` means the receiver has established that there is no receipt and no outstanding
  writer can still commit that operation. A canceled run can then finish as canceled.
  An active run stays in review for an explicit decision.
- `review` or a thrown lookup error keeps the outcome uncertain. For example, a missing
  record on a lagging replica is insufficient evidence for `absent`.

The lookup must not apply the business action. It must observe the same operation lock
or equivalent ordering guarantee as the receiver's write path.
