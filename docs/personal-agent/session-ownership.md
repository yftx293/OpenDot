# Session ownership across runtimes

Existing Coding Agent/JSONL and Node Durable Sessions retain their persisted
runtime. An opt-in Cloud Session uses the same product Session and authenticated
message/snapshot/control APIs. `MINICLAW_CLOUD_RUNTIME=true` permits an explicit
`runtime: "cloudflare-durable"` on new Session creation; it does not change the
default selector or reassign historical Sessions. The Web/PWA sidebar shows its
Cloud creation action only when the owner can use that configured option.

## Persisted association (introduced in schema v78)

```text
owner_user_id → workspace_jid → product session_id
  → local-pi | node-durable | cloudflare-durable
  → runtime_id → Durable Object (v1:session_id) → native conversation 1
  → provider_id / model_id / config_fingerprint
```

`RuntimeSelection.cloud` writes an immutable `product_cloud_sessions` placement
inside the existing Session creation transaction. The stored Harness kind stays
`pi-durable`; `productRouterKind` and the API's `runtime_router` distinguish its
execution owner without rebuilding the old runtime table. Creation idempotency
includes an explicit runtime selection. A retry preserves the original Session
even after new admission is disabled; changing that selection under the same
creation key conflicts.

The placement freezes the trusted HTTPS gateway, runtime UUID, model/profile
fingerprint, instructions, deadline and step budget. Current public Cloud grants
are bounded to 24 model attempts and 24 hours for the Session; this is a pilot,
not an unlimited renewable execution grant. Existing Host/Workspace/owner
requirements remain in force. Only the configured OpenAI Completions Provider
is currently supported; its vendor credential stays in the encrypted Node store.

Schema v79 adds an internal managed-Goal variant. Its new binding freezes
`goal_id`; each existing Scheduler occurrence receives a separately immutable
execution grant and model-attempt associations. Public Goal creation remains on
Node while Worker/Scheduler handoff is unfinished. Ordinary Cloud bindings keep
the limits above and cannot acquire this variant by sending a Goal reference.
See [goals-and-tasks.md](goals-and-tasks.md) and [migration.md](migration.md).

## Recoverable provisioning and admission

A first valid signed product-policy callback binds the actual DO ID with
compare-and-set. The create response must independently match the product
Session, immutable object and native Root 1 before Node marks it `ready`.
Both SQL and the store API forbid a different Root. Missing acknowledgments
remain `provisioning`; input/model authority requires `ready` and exact Root 1.
A retry uses the same binding. There is no Node SQLite/DO global transaction.

Node Harness activation and every local execution authorization reject Cloud
placements. After its HTTP authority starts listening, Node startup retries only original
unacknowledged product handoffs; an unavailable gateway leaves them pending, never opens a local
Harness or reassigns their owner. Already accepted work resumes through the
DO's persisted Lifecycle/PiHarness jobs. No local Harness file is created for a
Cloud Session. All Node executors must receive this fence before Cloud admission
is enabled; mixed-version old executors have not been validated.

Each input is stored with its complete product payload digest before transport.
The DO checks sender, text, queue/steer mode, request ID and original native ID/
terminal status against the live product ledger. Recovery verifies every input
before enabling work; an acknowledged native checkpoint cannot be replaced by
resubmitting a prompt. Only an original admission gap with no native receipt may
be submitted by its persisted wake after Lifecycle startup.

## Controls, history and result receipts

Existing Queue editing/reordering/cancellation/Steer and exact-task Abort now
route to the Cloud owner. The product intent and native control document retain
one immutable ID/digest. Recovery verifies all control proofs and rejects
orphaned native control documents before applying pending intents. Queued bytes
and modes must match the original admission plus verified controls. A lost
control ACK is reconciled by retrying that exact operation, including after a
workerd restart. Pi 1.3.0 Abort leaves unrelated follow-ups queued; a new explicit
user instruction advances that Inbox. Retrying an old Abort never targets a
newer generation.

History uses the official public storage adapter without opening a second
Harness. Even a paused `Harness.open()` reconciles running tasks; a regression
test reproduces why that is unsafe beside an active executor. A dedicated read
adapter captures the public Root ConversationView in a DO storage transaction,
checks input/control policy and repeats current access authorization. Reading
an expired Session neither schedules work nor prevents its history being read.
Unsupported document versions, forked roots and any extra native conversation/
foreign task scope fail explicitly rather than inheriting authority or guessing
new SDK semantics. History is bounded to 10,000 active entries/4 MiB transport.

Native completions create immutable DO result intents. A Lifecycle outbox posts
the original input/native answer identity to Node; product completion, answer
binding and message projection use the existing transactional stores. Duplicate
results cannot replace an answer or create another user-visible result. A lost
ACK retries the same result, including after execution expiry. Eight failed
delivery attempts stop at observable `blocked`; oversized results remain blocked
with the native execution retained. There is no unbounded model loop or IM
notification claim. Node epoch/revision and separate Cloud epoch/revision are
returned with full authoritative snapshots; existing foreground reconciliation
and WebSocket invalidations reuse that product state.

Managed Cloud Goals have a per-TaskRun grant/ownership handoff;
see [goals-and-tasks.md](goals-and-tasks.md). Exact-content approvals and scoped
Personal Memory are implemented in the Cloud tool gateway. New Cloud Goals can
be explicitly selected behind `MINICLAW_CLOUD_GOALS`; missing selection retains
the existing Node behavior. Fenced mid-model pause/cancel and checkpoint recovery
are implemented. Cloud Local Device tools remain unfinished. Real
Cloudflare deployment/hibernation and real model/device acceptance remain Pending;
see [evaluation.md](evaluation.md) and
[cloudflare-deployment.md](cloudflare-deployment.md).

## Managed Goal execution slots

A new managed binding freezes its Goal ID before any native admission. The
product database owns TaskRun creation and immutable execution grants. DO SQLite
owns the accepted run slot, its native Root and per-run model budget. There is
no cross-database transaction: a prepared grant survives failed/busy handoff and
a lost grant ACK retries that exact grant. No history read creates either grant
or Root. A new slot requires idle native storage before and after disposing the
old owner, followed by a second live Node authorization and a compare-and-set.

All old terminal inputs/controls are verified with their original grant. An
unsettled input/control requires the current grant and active Scheduler claim;
a late request cannot relabel old work as the new occurrence. Model/tool
closures retain the opening grant, and model charges compare against the current
slot. The cumulative Session counter is never reset by a new occurrence.

## Group Handoff origin (v81)

An optional [Bot Handoff](bot-handoffs.md) binds Group + Owner + source message

- target Profile/member + expiring grant to one newly created Product Session.
  This is a business association to the existing Native owner, not another Inbox
  consumer. Its immutable Session-origin marker is created before any native
  input and cannot adopt a ready/historical Session. The source marker survives
  Group deletion and rejects orphan access; it disappears only with the existing
  Product Session itself. Runtime flags cannot move its persisted owner. Current
  Group Handoffs retain their selected owner. New Cloud Handoffs require the
  separate default-off Cloud admission flag and a reviewed Cloud grant; there
  is no fallback or flag-driven switch for a running Session. Existing JSONL/
  Node/Cloud Sessions retain identity and authority.

Schema 82 adds an original-association outbox for internally marked Cloud
Handoffs. It retains the same product Session, request/payload/grant and native
Submission while repairing a missing acknowledgement. It does not choose a new
owner, acquire a second Harness or create Goal ownership. Its bounded coordinator
starts after authority HTTP readiness; the generic Cloud startup loop excludes
these records. Native Handoffs keep their previous recovery path. Public Cloud
Group admission is now explicitly opt-in; formal Goal-driven Group association
remains Pending.
