# Mem0 owner-private integration status

Issue #110 is still in progress. This branch introduces the Host-only Mem0
Platform add/search transport, an owner-private Product Input admission
predicate, and encrypted per-owner credentials with separate per-Dot recall and
capture opt-ins. The authenticated owner settings page provides key replacement,
key removal and independent per-Dot switches; the API never returns a key.
Node Durable owner-private inputs now freeze a bounded search
before native submission and replay the encrypted snapshot at the verified
generation source. Completed private Product Inputs can enqueue a capture pair
after an answer binding is committed. With default opt-ins off, the application makes zero Mem0
requests. Live transport validation used user-authorized synthetic data in a random isolated namespace; no private chat content was uploaded.

The transport uses only `POST /v3/memories/search/` and
`POST /v3/memories/add/`. The search filter binds the installation/environment
private app to either the Dot's private user or agent identity; received hits
without matching returned identities are omitted. Add sends a completed
user/assistant pair with the actual Session as `run_id`. An `event_id` with
`PENDING` means accepted for asynchronous extraction, not stored or searchable.
A lost add response is uncertain and is never retried by the transport.

The Product Input predicate derives the owner, profile and Session from Host
tables. It excludes both Group paths, handoff, Goal, channel and Cloud origins.
It also requires the persisted input sender to be the owner and rejects
channel-context, foreign sender and non-private source JIDs inside an otherwise
private Session. These checks apply before either recall or capture.
`root/question/reply/control` member inputs cannot become private turns merely
because their sender is the owner. A native-ack/submitted input cannot qualify
for capture; completion also requires the committed product answer result.

The credential uses the existing Host AES-GCM key with owner/record/purpose
binding. A missing key, disabled owner or Dot, or absent policy fails closed.
The policy has independent recall and capture flags and defaults to disabled.
Only a freshly committed private Product Input searches, once, with a
1.5-second default timeout; set `MINICLAW_MEM0_RECALL_TIMEOUT_MS` to an integer from 100 through 10000 to adjust it for the Host network. Invalid values use the default. Concurrent retries wait for that decision. The Host stores
either encrypted hits or a terminal degraded receipt. Restart and retry read
the same snapshot; a previously admitted/submitted input with no snapshot never
starts a retrospective search. Native generation reads only frozen data and
checks Product Input request/submission identity, current opt-in, key/policy
version and queue edits. Key or policy changes erase reusable encrypted hits
and leave a terminal degraded receipt, so an old input cannot silently requery.
Group and channel inputs never search or inject. Inputs with recognizable API
credentials or private-key blocks are skipped before external search.

For capture, fresh private Product Input admission arms a durable intent only
when that Dot's capture switch is enabled. The completed Product Input and
committed answer binding freeze an encrypted user/assistant pair. Add dispatch
records its state before network I/O; a lost ACK or restarted dispatch becomes
`uncertain` and is never automatically resent. `PENDING` plus `event_id` means
accepted by Mem0, not searchable memory. Explicit 429 rejection may retry after
the persisted delay, with at most three dispatch attempts; credential errors
stop. Revoking policy or rotating the key
cancels unsent work and erases its ciphertext. Failed inputs retire without add.
Recognizable credentials in either side of the pair stop capture before add.

Remaining before #110 is ready: complete Node Durable and Coding product acceptance,
capture/restart acceptance, cache isolation and privacy redaction verification,
real product regression and an opt-in Mem0 API acceptance run. The current tests
exercise the boundary and HTTP shape offline; they do not claim live Mem0
memory persistence.

References: [Mem0 add](https://docs.mem0.ai/api-reference/memory/add-memories),
[search](https://docs.mem0.ai/api-reference/memory/search-memories), and
[entity scope](https://docs.mem0.ai/platform/features/entity-scoped-memory).

Coding recall implementation is now wired through signed runner IPC. The Host
resolves one active, owner-originated Web input from its own registry and checks
its actual session, workspace, profile and audience before searching. Recall is
frozen per input, encrypted locally and attached as untrusted user-turn context.
Ambiguous batches, channel origins, Group, Goal, handoff and Cloud contexts are
excluded. Credential version tombstones prevent an in-flight lookup from being
accepted after a key is deleted and recreated. Coding capture freezes policy at
input admission and requires a Host-observed successful terminal output plus a
persisted matching final answer before it writes an encrypted outbox entry.
Unconfirmed dispatched writes recover as uncertain; only pending or explicitly
rate-limited entries are retried. The final answer and capture projection commit
in one transaction; a projection error rolls back only the optional memory work
so chat can still finish, and may omit that capture. The isolated product HTTP
fixture exercises three sequential Pi Coding turns, one Host restart, private
recall and capture for each turn, and Group/second-Dot isolation with a mocked
Mem0 service. It does not establish live Mem0 behavior or every recovery case.

The retained Claude Runner source contains the owner-checked IPC recall path,
but it is an uncompiled rollback reference: production uses the Pi entrypoint
and explicitly rejects `AGENT_RUNTIME=claude`. It must not be described as an
active or verified Claude integration. Restoring Claude execution would need an
explicit product/runtime decision and independent end-to-end recall and capture
acceptance; #110 remains open for that scope.

Search and capture share a persistent daily owner/Dot request limit (default
100, configurable by `MINICLAW_MEM0_DAILY_BUDGET`). Authentication failures
open a circuit for the current credential/policy version; rate limits honor
the server retry interval, while network failures temporarily pause requests.
Exhaustion pauses optional memory operations without modifying saved settings.

Recall now shares a bounded, process-local 15-second cache and concurrent
searches for the exact owner, Dot, credential and policy versions, Mem0 scope,
query and limit. Each input still gets its own encrypted frozen snapshot and
rechecks its authority before using a result. Add dispatch clears the cache and
fences older in-flight requests from repopulating it. Cached data is not used
across Host restarts. This cache has not yet been tested in the combined tree.

Unsent capture intents expire after 24 hours. The Host checks retention at
startup, periodically and immediately before dispatch; expiration clears
encrypted message pairs and preserves a local cancellation receipt. Work
already dispatched is excluded because its remote outcome may be uncertain.
This retention behavior has not yet been tested.
