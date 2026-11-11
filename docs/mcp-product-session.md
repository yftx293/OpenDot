# Node product MCP Session consent

This follows the persistent call service in #113. The actual
`ProductRuntimeService` now registers the governed Durable tools after acquiring
its native database owner lease. Ordinary private chats and active Group member
Sessions use the same catalog, call approvals and dispatch/result ledger. The
product now has owner HTTP/API and Web controls for managed Pi server opt-in, session
startup consent and exact call approval. Coding, serial Group, device and Cloud
MCP are not enabled here.

## Admission and configuration

`MINICLAW_PI_MCP=true` is an explicit deployment gate. Absent/false leaves the
feature off. Saving a server's `pi` policy or enabling a Profile never starts a
process or grants historical Sessions external tools. The existing
system/user scope, administrator-only system policy, user name precedence and
Profile inherit/custom/disabled selection stay in force. The Pi projection
preserves its versioned policy; the legacy Claude transport projection stays
unchanged. Missing secret fields are omitted explicitly before canonical
configuration hashing.

Configuration changes participate in the existing capability mutation
lifecycle. The new Durable participant revokes matching grants and closes its
native owner/MCP clients before a server disable/edit/delete is committed.
Startup consent shares the existing system/user capability locks with those
mutations, so a concurrent start cannot escape cleanup. The original product
Submissions are reconciled afterward, including a failed configuration commit;
no new business input is manufactured. Source-qualified consent prevents a
system-server mutation from revoking an unrelated user server with the same ID.

The owner reviews the existing configured server and explicitly consents to
startup **and restart**, selected original tool names and a bounded TTL. This
record binds owner, Dot, Workspace, actual Product Session, configuration digest,
real working directory/inode, cancel generation and, for members, current
Run/lease/base grant/cancel/control epochs. Pairing and member communication do
not confer this permission. The request schema accepts neither a command nor a
replacement endpoint, cwd, secret or claimed native source.

Discovery is read-only. A confirmed startup may create the product's own empty
managed Workspace directory; it does not create arbitrary missing custom
roots. The MCP server still has the approved process user's privileges: this is
consent and least-environment execution, not a process sandbox.

A new consent for the same server supersedes the older consent, cancels its
unsent calls and leaves dispatched calls uncertain. Unrelated server grants
retain their cancellation generation. Native generation memos prevent an older
ToolTask from borrowing a newer consent. Group consents bind the current lease;
new Runs need a fresh explicit grant. A convenient owner UI for granting future
Runs and its separate capability contract are still pending; the current API
does not silently turn a legacy model-only base grant into that policy.

## Lifecycle and native execution

The initial process/catalog handshake runs only while the owner action's
in-memory admission ticket is present, after Pi's exclusive database lease was
acquired. A restart finding an unfinished `starting` receipt marks it uncertain
without starting a process. A completed catalog receipt may restart only under
the original, still-current startup-and-restart consent. Each actual native
owner instance has its own execution epoch, even when reopened in the same
Host process.

The catalog is frozen for the Session. Changed definitions require a new
Session rather than replacing a tool schema behind old approvals. Reconnection
does not resend tools/call. The combined Session catalog is bounded to 100
tools and the startup consent journal to 20 records.

Updating consent retires the old native owner and its MCP connections, then
uses the existing product `reconcile` path to reattach completion monitors to
original Submissions. Resuming Pi alone was insufficient: a native tool could
complete while the product input stayed `submitted` and the Group never
published its final answer. The regression exercises that actual failure path
instead of manufacturing another input to wake it.

Per-call approval is still required for the exact arguments. Owner-only argument
inspection decrypts the original receipt and verifies its digest; metadata and
normal runtime snapshots omit arguments and results. Denial does not require
starting a server. Approval verifies genuine active native provenance and live
consent immediately before dispatch. Stop, scope changes, revocation and expiry
continue to fence execution. Existing Goal/Handoff/Host checks remain in the
common authority callback; actual MCP-through-Goal/Handoff acceptance remains a
separate test scope.

## Owner API

All paths are below `/api/groups/:jid/sessions/:sessionId` and use the existing
cookie authentication and exact Workspace/Session owner check.

| Method/path                        | Meaning                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /mcp`                         | Available Profile-selected, explicitly Pi-enabled Host servers and this Session's consent receipts; no connection       |
| `POST /mcp/consents`               | Exact `request_id`, server/config digest, tool subset, TTL and `confirmed_startup_and_restart:true`; idempotent receipt |
| `DELETE /mcp/consents/:id`         | Commit revocation before teardown; report `runtimePending` if an authorized owner cannot resume                         |
| `GET /mcp/approvals/:id/arguments` | Inspect this owner's exact original argument object                                                                     |
| `POST /mcp/approvals/:id`          | Decide the exact `parametersDigest` with stable `requestId`; wrong Session/owner cannot approve                         |
| `GET /runtime`                     | Existing snapshot, plus metadata-only `mcp_approvals`                                                                   |

The private Dot panel uses the authenticated runtime snapshot for exact MCP
approval IDs and digests. The Group settings sheet shows owner-only persistent
Node Dot Session scopes, including the active member and any parked member,
without merging their approvals. Opening a Session's tools reads configured
choices without starting a process. The owner selects a subset, duration and
explicit startup/restart consent; each call requires an additional exact
argument review. The Web request journal preserves an unknown outcome's request
ID until a successful ACK. Existing MCP server settings expose optional
Host-only Pi tool names, default off; legacy SSE remains unavailable for Pi.
Managed server credentials and tool arguments are never included in the Group
snapshot.

Schema v94 adds startup/catalog receipts with immutable identity/catalog and
state transition guards. The v93 migration fixture verifies the private backup,
unchanged encrypted call receipt, empty historical startup grants and idempotent
subsequent initialization. The database lifecycle module stays lightweight and
does not load runtime configuration or MCP transports during initialization.

## Validation scope

Fixtures use actual authenticated product HTTP, Pi Durable, SQLite and stdio
services, with synthetic loopback model answers. Private-chat acceptance covers
three complete turns (approve/deny/approve), exact parameter inspection,
wrong-Session denial, duplicate decision ACK, SIGKILL while waiting for approval,
original native identity on restart, ungranted-session isolation and revocation.
Group acceptance covers real artifact waiting, explicit MCP consent on its
active lease, canonical final projection, a subsequent Run with no inherited
MCP tools and fresh consent on the same persistent Session/new lease.

Earlier failures are retained: eager configuration loading during database
initialization, an uncreated managed root, undefined secret fields, the missing
completion monitor, and a synthetic provider that examined previous-turn tool
results. The product process fixtures are run serially: concurrently launching
independent Vitest runs would rebuild the same `dist` while a fixture restarts.
A previously observed backend exit under that overlap is retained as a failed
run, not relabeled as evidence of correct recovery.

The first complete 33-file run retained 156 passes and one five-second metering
test timeout, with 2,100 source files unchanged. That accounting test now resolves
the real lazy OpenAI adapter before its unchanged operation budget, while the
product HTTP tests continue to exercise cold native startup and the production
request deadline. No model budget, timeout, dispatch or settle assertion was
removed. A separate real product fixture also exposed missing Durable process
cleanup after server disable: the HTTP update succeeded while its child remained
alive. The lifecycle participant above fixes that omission; disable/edit/delete
and concurrent startup are covered by a new product regression.

The final exact-source gate passed all 35 selected files and 165 tests (Vitest
reported 45 suites because project selection overlaps). The wrapper's
before/after audit found no changed source among 2,102 files. Root and personal
agent typechecks, formatting and the 109-document check also passed. This
is a fixture-backed product result, not a live provider or browser acceptance.
The subsequent owner UI slice passed Web/root typechecks, authenticated Group
lease and configuration product regressions, and DOM interaction tests for
exact-argument approval and tool-subset startup consent. Its isolated mobile
Playwright fixture also created a private Dot session through the product UI,
granted selected tools, and observed the real managed stdio child start. The
browser fixture uses a temporary application database and does not touch the
running local deployment. No real vendor/model, user application database,
GUI/TCC or Cloud resources are used. Future Group grant ergonomics, Coding
IPC/loader, the shared device channel, #101 Kimi, #110 Mem0 and #111 Langfuse
remain unfinished parts of the full objective.

## Coding Runner and device work in progress

The current branch adds a signed, active-owner-turn Coding IPC adapter using
real conversation and tool-call identities, the common approval store, and an
explicitly selected Host catalog. A completed call is not retried under a new
identity. On a Host restart or session-owner retirement, existing Coding startup
consents become uncertain until renewed. A database-backed, short-lived Coding
execution lease now gates session startup and dispatch, with renewal and a new
epoch on takeover. The new epoch cancels unsent approvals and marks dispatched
calls uncertain; the old epoch cannot release or renew the new lease. This
recovery path and its migration remain untested. Coding device calls now use the
same device command ledger and approval path as Durable calls, but retain their
actual Coding turn/call identity instead of inventing Durable task IDs. Device
polling rechecks the active Coding owner lease and exact approval. The IPC,
device and UI integrations have not been validated at this branch
head; the fixture results above describe earlier commits only.

The paired-device MCP path now has separate grants, command/receipt storage,
node-side execution and a Durable session adapter. Its end-to-end behavior,
resource teardown and migrations are still pending integrated verification.
