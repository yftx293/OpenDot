# Node Durable observability: first execution-point slice

The Host starts Langfuse export only when an administrator explicitly saves an
enabled project configuration. With no configuration file, model execution and
all business receipts run as before. `sampleRate: 0` keeps the connection
configured but emits no observations. The Host stores project keys in its
AES-GCM private store, with a purpose/record bound to Langfuse, and writes only
the sealed value to a mode-0600 config file. The browser, Runner, model and
span attributes never receive the key. A bad or unavailable configuration
disables export at startup without blocking the service.

An administrator can open **设置 → Langfuse 观测**, enter the HTTPS project
origin and project Public and Secret Keys, enable export, and save. Restart
the Host to apply the change. The page never redisplays saved keys; leave both
key fields empty to retain them, or enter both to replace them. It also offers
removal of the stored configuration and keys. Export stops after the restart.
The page shows whether the exporter has started and its successful, failed and
dropped span counts for the current process. A successful export means the
collector accepted the request; it does not confirm data is visible in the
Langfuse console. With sampling at zero, no observations are expected.

For a local installation, the CLI is also available after building the backend:
pass a private JSON file on stdin to `node scripts/configure-langfuse.mjs`. Its
fields are `enabled`, `origin` (HTTPS project origin), `sampleRate` (0–1),
`publicKey` and `secretKey`. Do not place credentials on the command line or
in repository files. Restart the Host to apply the change. Neither method
creates a Langfuse project.

The Node adapter binds the real Pi generation task ID, attempt, conversation
and placed product input request IDs at `beforeRequest`. It matches the same
normalized message digest used by member accounting, without consuming the
member frame twice. Sampling is deterministic for an installation, owner,
Session and original input set, so each attempt for that input is selected
consistently. Distinct concurrent Sessions do not use a global active trace.

`meteredModelApi` records admission wait separately. Budget `dispatch` still
runs once before the SDK call. A model generation observation begins when the
SDK invokes the supplied HTTP transport; SDK errors before transport have a
separate `no_transport` span. Visible output timing is labeled as an observed
SDK event, not provider TTFT. Abort, error and done reflect the original
settlement. The integration does not change authorization, model deadlines,
admission, provider retry settings, usage ledger or native receipts.
The admission and provider spans use their corresponding callback timestamps
for both start and end. Capacity wait therefore cannot be counted as provider
latency even when the two stages settle in the same event-loop turn.

Exports start metadata-only. Names and fields use a fixed allowlist: opaque
Session ID, hashed owner and input references, native numeric task/attempt,
runtime and state. Prompt and answer text, hidden reasoning, tool arguments,
screenshots, local paths and credentials are omitted before the queue. SDK
usage is currently marked unknown, even if its result structure contains zero;
the configured `cost=0` placeholder is marked unpriced and never exported as a
real free cost. A later slice must prove provider-reported token provenance
before exporting token counts.

The official Langfuse 6.0.2 tracing/OTel processor runs on a scoped Host
provider. The custom OTLP exporter uses the official JSON serializer to cap
queued **and in-flight** uncompressed bytes at 64 KiB, with at most 64 batches,
one request at a time, a two-second transport deadline and bounded official
retry behavior. It records exported, dropped and failed counts. Export
failures do not change model/approval/Stop results. Shutdown gives flushing a
three-second budget. SIGKILL can lose in-memory telemetry; original business
receipts remain authoritative.
An in-flight batch that never receives a collector callback is failed after
three seconds so its byte reservation and flush wait are released. A late
callback for that batch cannot count or acknowledge it a second time.

Native ToolTask hooks now emit a sampled metadata-only observation after the
tool returns and before its result is committed. Native generation and tool
task IDs connect it to the business record; arbitrary external tool names are
replaced by `other`. Arguments, results and diagnostics are not exported.
This observation is not a committed-effect receipt: blocked calls, aborted or
interrupted tasks, and executions recovered without the before hook are not
covered. Observer failures leave tool execution unchanged. The implementation
has not yet been validated after this change.

The shared MCP ledger now emits separate Node Durable and Coding decision and
execution observations from committed timestamps and states. Replayed decision requests
and completed result reads do not emit a second observation. Server, tool and
call identifiers are hashed; arguments, results and approval details remain
local. These are independent trace segments, not fabricated cross-wait parent
spans. Coding uses its actual business-turn and tool-call identities, with no
invented Durable task IDs. When an owned Runtime recovers dispatched calls,
the committed uncertain receipt is also observed. Other recovery paths remain
pending.

This slice does not yet observe the complete native ToolTask/effect lifecycle,
Coding and Claude Runner, Mem0, feedback export, eval or Cloud internals.

Private Session assistant messages now have a compact helpful/not-helpful
menu action. The Host verifies the workspace, owner, Session and exact stored
message before saving a local versioned feedback record. Request IDs make
identical retries idempotent and stale versions conflict. Group member Sessions
are currently excluded. Actual model transport spans now retain a local mapping
to their Host-owned input and native generation task. Feedback can report an
association only when the committed answer's exact Task resolves to a single
trace; missing or ambiguous attempts remain unavailable. Association does not
prove collector delivery. An enabled Host queues a numeric score only for a
unique project-bound association, using the official Langfuse client. The local
queue has at most 256 pending/dispatching entries and one request in flight;
it never sends comments or message content. An accepted response means only
the service accepted the request. An ambiguous response is not retried, and
an interrupted dispatch remains unresolved. Local feedback remains available
when export is disabled, full, rejected or unavailable.
On Host startup, pending unsent scores are discarded if export is disabled or
they belong to another configured project. Local feedback is preserved;
previously dispatched scores remain unresolved rather than being resent.
Trace references are also bound to a hash of the configured project origin and
public key. Rotating to another project cannot attach an old trace to it;
legacy references without that binding stay unavailable.
The feedback route, UI and schema migration are not yet tested on this branch.
It is not a complete resolution of #111. No real Langfuse project or user
conversation was used in the local tests.

Local validation used the pinned published modules on Node 24, root and
personal-agent typechecks, and a real authenticated Product HTTP fixture with
two concurrent Node Durable Sessions. Both used an isolated synthetic model
over HTTP; the Host sent OTLP to an isolated HTTPS collector with a test-only
certificate. Exactly two model requests and two generation spans occurred,
with distinct trace IDs. The received OTLP contained neither prompt, response,
request ID nor project secret. Unit tests cover the genuine parent relation,
pre-transport failures, separate retry attempts, sampling zero, encrypted
configuration, exporter queue pressure and observer failure isolation. Actual
Langfuse Cloud/self-hosted ingestion, model billing, Coding Runner, ToolTask,
feedback and eval are pending.

Owner-private Mem0 recall now emits an isolated Host observation with hashed
owner, Dot and input references, scope version, cache state, result count and
success/failure. It contains no query, result text or credentials. Each recall
is sampled from its input identity; a future generation that combines several
inputs may use a different sampling decision. The span records the recall
operation, not proof that the resulting context was injected or used. Coding
observations do not claim a native generation parent. Mem0 add now emits a separate span after the local capture receipt commits.
It records the attempt and accepted, failed, rate-limited or uncertain state;
an accepted event remains marked as extraction unconfirmed. Payloads and raw
event identifiers are excluded. Recovery without a live hook and live export
validation remain pending.
