# Durable runtime

## Pinned API

The pilot pins `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` to 1.3.0. Pi Durable declares Node `>=22.19.0` and documents its API as experimental. The repository CI and container use Node 24. The existing MiniClaw Pi Coding Agent is still pinned to 0.84.2; Pi Durable is a different runtime API, not a drop-in adapter.

The adapter uses `Harness.open(openNodeSqliteStorage(path), { models, registry }, context)`. It does not resume work during `open`: the caller validates recovered ownership before `activate()`. Submission is rejected until activation succeeds. The product-session service now supplies the persisted mapping and real authorization/admission callbacks; the original standalone pilot tests remain useful. Input bindings include queue/steer mode when supplied, so changing control parameters under the same ID is rejected.

## Formal product Session rollout

Enable `MINICLAW_DURABLE_RUNTIME=true` only for this opt-in Host rollout, configure an explicit API-key provider/model in the existing settings, and create a new conversation in an owned Host workspace. Provider advanced configuration `MINICLAW_MODEL_API=openai-completions` selects that API; the default is `anthropic-messages`. OAuth-only configurations are rejected. Existing conversations, main sessions and Docker work keep Coding Agent. Disabling the flag later affects only new Sessions. Server-owned Group Dot Sessions are the documented exception: their runtime grant may select Node Durable on the owner's container Workspace, which is the default Docker deployment path, while private and Goal Durable Sessions still require an authorized Host workspace.

The existing Session creation APIs accept a stable `requestId` (or `Idempotency-Key`) and return the same object on matching retry; changed creation parameters conflict. The browser persists a hashed pending-request journal until acknowledgement, including across reloads. No automatic TTL turns an unknown outcome into a new execution. Storage-unavailable fallback preserves only the current page lifetime.

Formal `/api/messages` requires a stable request ID for Durable Sessions, binds the complete content/mode/author payload, and returns the persisted message/submission receipt. Attachments and `/clear` are explicitly rejected until supported. Legacy WebSocket send commands cannot bypass HTTP admission. Existing channel dispatch adopts original stored message identities after its existing routing checks. `GET /api/groups/:jid/sessions/:id/runtime` exposes owned runtime/receipt/context state; the owner abort endpoint and existing virtual-JID interrupt route reach the Durable executor. Abort withdraws queued inputs as well as aborting the current conversation scope. Legacy queue mutations and resets are rejected for Durable rather than changing only the Coding Agent queue.

Each Session has one Harness/root in `data/db/durable-sessions/<session-id>.sqlite`. A provisioning mapping precedes root creation. Recovery reuses an existing root when binding is committed; missing bound storage/root, changed ownership/configuration or unmatched input receipts block that Session. All historical input bindings are checked before activation, including recovery from a skewed multi-database backup. Other valid Sessions can recover independently. Input and answer projections use stable IDs, with product result state and message persistence in the same transaction. Reconnect uses the existing transcript/connection layer; a full ordered runtime-view protocol remains pending.

The installed read tool reuses MiniClaw's workspace path validation, permits only regular UTF-8 files up to 64 KiB and rechecks authorization. Model requests recheck the active user, Host grant and frozen model/profile/workspace identity. A watchdog closes revoked or duration-exhausted Sessions; the existing container duration limit includes queued/approval wait time and is not reset on restart. Full Skills/MCP/context/environment support and arbitrary sensitive write tools remain pending. Unpriced SDK costs are excluded from product billing; the usage page explicitly marks that incomplete coverage.

### Exact-content artifact approval

New formal Sessions expose `create_approved_artifact`, which proposes a private UTF-8 artifact up to 64 KiB. Schema v72 binds the original tool-task ID, Session/owner, exact content, operation and parameter digest. The authenticated mobile/desktop chat UI displays that content and digest before explicit approval or denial. Decision requests have payload-bound IDs; conflicting decisions fail, while two approvals converge on one intent.

The tool waits with the Harness invocation's cancellation signal. Restart resumes the original tool task and approval; no consent is inferred from a client connection or model text. Only an approved intent can create `data/db/private-artifacts/<approval UUID>.txt`, using exclusive creation, private permissions, fsync and a completion receipt. It cannot choose a path, overwrite a file, send email or modify a remote resource. A crash after file creation but before receipt reconciles the existing content hash without rewriting; a partial/mismatched/linked file becomes `uncertain` and requires operator inspection. Each Session is capped at 20 intents and 1 MiB of proposed content. Duration limits still apply while waiting.

The Goal follow-up additionally binds consent to its frozen Goal/TaskRun and original tool task, with a 24-hour intent expiry (the existing runtime-duration limit can stop execution earlier). Expired, rejected and revoked resolutions are recorded; cancellation prevents consent reuse. A Goal Harness is activated only by the process holding the current started Scheduler claim, never by an ordinary chat request or startup recovery alone. See [goals-and-tasks.md](goals-and-tasks.md) for bounded progression and evidence rules.

Owned artifact reads verify the actual file hash before returning content. Chat shows completed artifacts through this authenticated API. Backup/restore includes private artifact files; stop executors for a coordinated snapshot. Session deletion stops execution before removing metadata and revokes artifact API access; orphaned private files are retained for operator retention/reconciliation, not automatically deleted. This implements one controlled local effect, not general external exactly-once writes or Goal completion evaluation.

For an explicitly configured OpenCode Zen endpoint, `src/personal-agent/zen-model.ts` constructs a Pi AI `openai-completions` provider with model, endpoint, and key supplied through `MINICLAW_ZEN_MODEL`, `MINICLAW_ZEN_BASE_URL`, and `MINICLAW_ZEN_API_KEY`. The endpoint validator requires HTTPS and the `opencode.ai` host. Run `npm run test:durable-zen-real-model` only after supplying those values securely and enabling the environment's HTTPS proxy for that host. It performs one no-tools request through a Durable SQLite-backed Harness, prints only booleans/timing, and deletes its temporary database. The command enables Node 24's environment proxy support; it does not bypass TLS verification.

## Semantics and safety

- Upstream Pi Durable reuses an input `requestId` without comparing content. MiniClaw now binds the ID and content to a SHA-256 digest in a versioned, Session-scoped document family keyed by conversation ID and hashed request ID. Binding commits serialize concurrent requests; changed content fails with `DURABLE_INPUT_CONFLICT`, including after restart. Only digests are stored in the extra record. IDs must be nonblank and at most 256 UTF-8 bytes.
- Binding and upstream admission use two commits. A crash after binding permits retry of the same payload, while an already admitted input retains its original submission ID. An old Durable submission without a verified binding fails closed on resubmission and remains available for explicit inspection/recovery; the adapter never retroactively trusts a caller-supplied payload. Legacy JSONL sessions are unaffected. Request bindings are not copied into forked conversations.
- Submission idempotency does not provide exactly-once tool effects.
- Task state, task checkpoints, and memos commit on the Durable storage line. A tool effect that may have happened before a crash must use a durable receipt/idempotency key or enter an uncertain state; it must not be blindly repeated.
- Pi Durable distinguishes safe and unsafe tool replay. This pilot has no MiniClaw tools registered, and therefore makes no claim about their replay classifications.
- A single process must own a given Harness storage. The adapter canonicalizes the existing database or its parent directory and holds an SQLite writer transaction on a separate private `<database>.owner.sqlite` coordinator for the Harness lifetime. Competing adapter opens fail with `DURABLE_DATABASE_OWNED` before opening Harness storage. File/directory symlink aliases use the same identity; hard-linked database files and linked coordinators are rejected. A clean close or OS process termination releases the lock. This is cooperative ownership on a local filesystem, not distributed leader election; code that directly opens the upstream Harness can bypass it.
- Pi Durable scheduling is Harness-wide. Product Sessions therefore use independently guarded files, validate all recovered input receipts before activation, and isolate invalid work. The standalone adapter still requires its caller's explicit ownership checks.
- The SQLite adapter's WAL with `synchronous=NORMAL` is documented to survive process crashes for committed data, not guarantee the newest transaction through host/power failure.

## Fault evidence

`tests/pi-durable-runtime.test.ts` runs the official Harness against a temporary SQLite database, commits a task memo representing an effect, closes the Harness before the next task checkpoint, reopens the same file, and waits for the task. It verifies completion at step 3 and exactly one occurrence of the step-2 simulated effect. `tests/backup-restore-safety.test.ts` also verifies that an open Durable SQLite WAL is snapshotted, restored with its committed checkpoint row, and restored without sidecars at mode `0600`. This validates Harness close/reopen and backup/restore behavior, not SIGKILL, real model request interruption, real MiniClaw tools, or external side effects.

The same test file verifies host-hook ordering and a conversation watch that stops delivering frames on read-ACL revocation. `tests/pi-durable-input-ledger.test.ts` verifies the adapter's persisted digest protection independently of the host hook: restart, conflicting concurrent inputs, invalid IDs, and legacy unverified inputs.

`tests/pi-durable-process-recovery.test.ts` forks actual Node processes and sends SIGKILL at five fault scenarios: before an effect, after an effect but before its next checkpoint, after the checkpoint, during a simulated provider request, and between input-payload binding and admission. A fresh process reopens the same SQLite file. It verifies the original task/submission identities, one user entry, and completion. The effect service is simulated with a separate SQLite database and a unique operation receipt; after-effect recovery makes two service attempts but only one effect row. The provider is Pi AI's scripted faux provider. These tests establish real OS-process recovery of local committed state, not live model/provider or real external-write semantics.

`tests/pi-durable-ownership.test.ts` tests competing real Adapter processes, SIGKILL release followed by a fresh Adapter process, stable coordinator identity across restart, canonical file/directory aliases, hard-link rejection, initialization-failure release, and coordinator symlink rejection. A separate fault case discards an activated Adapter and forces garbage collection in a still-live process: ownership must remain held until explicit close or process death. It opens real Harness storage but runs no model or tools.

Formal product tests now cover current owner/workspace checks, Goal dispatch, approval wait/restart and actual private-artifact receipt reconciliation. Pending: a live provider request/interruption, general external-tool effects, physical devices and production recovery acceptance. The real-model command is wired but the secure key binding and currently available authorized model remain unresolved; public Zen metadata is reachable.

## Operational constraints

The formal service derives paths under the configured data directory. `make backup` snapshots the optional pilot `data/db/personal-agent.sqlite` and every recognized per-Session database through the existing online snapshot helper; restore validates each and hardens its permissions. Legacy backups remain valid. Online snapshots of separate databases are not one distributed transaction: restore mismatches are isolated by product receipt checks and require reconciliation. Stop executors for a coordinated recovery point. Goal/approval infrastructure has simulated-provider end-to-end coverage; live-model and production acceptance remain pending.

The coordinator stores no conversation/checkpoint data and is not part of the application backup. Preserve its file identity while processes may be running: never delete/rename it to force takeover, and do not move, replace, restore, or relink a live runtime database. Stop all executors before restore or relocation. SQLite releases OS locks after SIGKILL, so a leftover coordinator file alone does not indicate a stuck owner. A stopped or suspended owner continues to hold its lock; there is intentionally no timer-based lease stealing. Shared/network filesystems and multi-host execution are not supported by this ownership mechanism. An older pilot binary lacks the lock: all executors must use the same guarded adapter before activation.

The process retains a strong reference to each live coordinator. Accidentally dropping an Adapter reference cannot let JavaScript garbage collection surrender ownership while its Harness scheduler may remain alive. Such a leaked Adapter fails closed and requires process shutdown if the caller can no longer close it explicitly.

## Durable Inbox control protocol

The authenticated Session `controls` endpoint validates current owner/workspace/Host/model identity and, for managed Goals, the exact Scheduler execution. A stable control ID binds the complete strict command, expected queue digest and server-owned input request identities. Inbox edits/reorder/steer/withdrawal use the **public Pi Durable 1.3.0** `Conversation.commit`, `InboxDoc` and `Tx.submissionByRequest`; no private submission mutation API is assumed. Internal writes remain pinned and cannot be user-edited. A stale digest or placed/settled input gets a persisted rejected receipt. Control receipts remain retained for deduplication; reorder commands accept at most 500 input IDs.

The official commit stores the control receipt together with its Inbox mutation. Reopening validates the native control manifest against MiniClaw intents, verifies all applied/rejected receipts and the current effective queued payload, reconciles pending acknowledgements, then activates execution. The original input payload is immutable; effective edits are derived from applied controls. A cancelled queued input retains a terminal failed submission receipt and exposes `disposition: cancelled`; it produces no fabricated assistant answer. Goal evaluation waits for pending controls and accepts intentionally cancelled follow-ups without treating them as model failures.

`abort` controls bind one actual `pi.live.run.taskId`. The native control commit records the intent before the official Harness task abort mark; a receipt-gap retry marks only that task. A completed product abort receipt ahead of an unmarked live task blocks recovery. This leaves queued inputs intact. The compatibility Conversation-scope abort API retains its older documented semantics.

Several inputs can share one `AssistantEntry`. Completion atomically binds each input to the canonical message of that answer entry rather than projecting the same answer multiple times. Existing completed projections are backfilled before activation without rewriting history.

Goal completion also checks pending controls and newly admitted inputs in the same MiniClaw transaction as settlement. A late admission defers completion through the existing Scheduler retry path with the original run ID, lease fencing and single budget charge. Controls from an older Goal run can reconcile a committed receipt; absent native operations are explicitly rejected rather than executing under a new run. An applied edit updates the existing owned product user-message projection with its acknowledgement; original immutable admission data remains available for audit. Imported external channel messages are not rewritten, and external-channel control/history acceptance remains pending.

## Paired read-only device Tool checkpoints

New roots optionally use `read_device_file`. The native first-writer Task memo
commits immutable operation identity before its product dispatch receipt; the
transport verifies the actual active Task ancestry/memo and current owner/claim
before every dispatch/result. Local Node receipts retain original read bytes
across response loss/restart. Only safe file reads are implemented. This does
not provide replay safety for remote writes. See [device-nodes.md](device-nodes.md).

## Cloud result wake handoff

The result outbox upserts its stable projection job on native commits and
Lifecycle startup, including when an older instance of that job is still
finishing. A get-if-missing check loses the wake when a native input completes
between the last projection scan and the old Lifecycle outcome commit. The
public SDK's same-ID push supersedes that outcome; the Session operation lock
keeps projections serialized. Existing retry backoff, result IDs, product
deduplication and finite blocked state remain. Per-result `next_attempt_at`
persists that backoff even when another native commit wakes projection early.
Repeating this metadata delivery
does not resubmit an input, rerun a model or execute another tool effect. The
workerd regression injects an actual native completion in that exact gap and
verifies delivery with one model request.

## Cloud approval wait lifecycle

`mc_approval_waits` is an additive DO SQLite table with immutable tool/approval
identity and payload digest. Wait/receipt state is independent of client lifetime.
Both original native memos and Root task ancestry are checked before resuming.
Opening the official paused Harness is permitted only as the sole control owner;
ordinary snapshots continue to use Storage without a Harness.

A pending approval disposes in-memory execution and leaves its safe tool task
recoverable. Approval decisions use the existing product store/UI; their signed
wake is retriable and the persisted one-minute runtime Alarm covers lost delivery.
The resume transition uses a state CAS so concurrent/late wakes cannot activate a
cancelled wait. A runtime guard persists across Pi generation handover until the
Root is idle; it never submits the original prompt again. Existing Scheduler
business definitions/occurrences are unchanged.

The Node private artifact service confirms effects using the original approval
and exact content digest. Partial effects or missing trusted associations block
automatic execution. This increment does not add Cloud Goal execution or Local
Device authority. Real Cloudflare deployment/hibernation remains Pending.

## Cloud managed-request recovery

The managed Cloud model transport now keeps the native request checkpoint when
its HTTP/SSE stream is interrupted. The request boundary supplies the original
Task abort signal; credential resolution does not block on an unabortable wait.
Runtime metadata and the Lifecycle wake are installed before closing the active
Harness. Closing occurs outside the parked invocation, avoiding a self-join.
The next Alarm authorizes and reopens the same native task; no new input or
business TaskRun is created. Native partial output is retained under Pi's own
recovery semantics. A repeated model read consumes another original-grant
attempt and may incur another vendor charge.

A recovery attempt can itself fail after policy succeeds but before Harness
activation. That path restores the waiting intent and backoff instead of leaving
an acknowledged `resumed` row with no executor. A deterministic isolated negative
control reproduces that lost wake; the repaired test retains the original native
task/submission across a second eviction. Permission denial cannot advance work.
Eight persisted recovery probes or the fixed deadline suspend further automatic
checks. A fresh authorized explicit resume preserves all existing counters.

Native tool/approval receipts remain authoritative. Recovery never reconstructs
prompts, adopts another run, clears quota, or indiscriminately repeats tools.
Ordinary Cloud Sessions keep their earlier transport/lifetime behavior. Explicit
Cloud Goal admission is now available behind a separate default-off flag; see
[goals-and-tasks.md](goals-and-tasks.md) for permission and context-size limits.

Private authority JSON requests have a complete-response deadline as well as
the existing header bound. Native model/tool authorization propagates its abort
signal into that request and its bounded reader, so a stalled response body
cannot retain an obsolete policy promise after stop. The actual workerd fault
observes the original authorization promise ending and the placed input staying
unsettled. It does not assume the remote service immediately cancels computation.

## Cloud Handoff interrupted model requests

Cloud Handoff bindings share the existing Goal `ExecutionRecovery` capability
without pretending to own a Goal run. Frozen recovery subjects carry the actual
runtime/Session/marker, model budget, configuration identity and original
deadline. A transport interruption parks the original native task and persists
an Alarm wake before closing the owner. Current product authority is checked on
wake; charged retries consume the same budget. Receipt-bearing tools retain
their original task identities and effect rules. See
[Cloud Bot Team integration](cloud-bot-teams.md) for wire/storage compatibility
and the still-closed public admission boundary. Local workerd lifecycle faults
use simulated models/policy; they do not prove deployed Cloudflare acceptance.
