# Session continuity

## Current behavior

Existing Pi Coding Agent sessions are backed by JSONL and the agent-runner lifecycle. MiniClaw also has durable inbox, queue, delivery receipt, and scheduled-run recovery mechanisms. Those records can recover admitted MiniClaw work, but they do not reconstruct a Pi model/tool checkpoint. Browser reconnect by itself is not execution recovery.

The complete Pocket implementation and follow-up fixes are combined with Goal/Durable infrastructure on `agent/pocket-integration`. Review covers WebSocket lifecycle, mobile queue/steer entry points, child-scope notification worker, and conservative Tailscale helper behavior. The product browser test starts an actual isolated compiled backend, establishes two independent signed logins, opens the same child Session in desktop/mobile contexts, disconnects/reconnects the mobile context, and checks persisted-history convergence without cross-session leakage or duplicate history. Its messages are database fixtures and it invokes no model. This proves client continuity only. Physical iOS, real Tailscale, closed-application push delivery, and a live model across two devices remain unverified.

The product-session branch routes the normal child-Session input API into Durable and projects persisted user/answer messages through the existing WebSocket/transcript layer. The compiled product browser test now also submits through the real chat input, disconnects the submitting desktop page while generation is pending, and verifies the mobile login receives its result. The provider uses local simulated HTTP responses and the file tool reads an actual isolated workspace file. Existing Pocket reconnect guards still reject old-socket events. The normal Session runtime endpoint now returns a committed Durable `pi.live`/`pi.inbox` presentation alongside one MiniClaw metadata transaction: actual busy state, retained model text, tool names/status, real queued submission IDs/modes, approvals and the owning Goal. It omits raw provider retry errors. The existing Pocket component uses this view for running/queue counts and Steer availability; approvals share the same view.

The existing authorized WebSocket publishes only `{chatJid, agentId, epoch, revision}` invalidations. A serialized per-Session publisher rechecks current ownership, Workspace/Host policy and the existing socket authentication/ACL before delivery. Durable committed-view changes and MiniClaw input/approval/Goal transitions advance the persisted revision. This revision is an invalidation fence: the two databases do **not** form a distributed atomic snapshot, and the later Harness read can be newer than the MiniClaw metadata fence. Clients never apply a raw delta against it.

Every matching update, sequence gap, reconnect, online or foreground transition fetches a full authorized snapshot; visible clients also poll as a fallback. In-flight reads are coalesced, and responses older than an observed fence or from an earlier connection, Session or account are discarded. The process epoch changes on restart. Reconciliation never posts or replays user input. Detaching clients does not remove the server-owned committed-view observer or stop execution. Pocket now exposes the actual Durable control API for queue mutations and current-task abort. Independent branch creation remains pending.

## Required reconnect protocol

The production protocol must provide a server-authoritative snapshot and monotonically ordered committed updates. A client reconnect must fetch the current snapshot, apply updates from its cursor, and reconcile any gap by fetching a new snapshot. Local stream buffers are presentation state, never proof that a task ran or completed.

`detach` ends a client subscription. `abort` requests that the server stop current work. `close` shuts down a runtime owner. `resume` reopens durable state. These operations must remain distinct in APIs and audit records.

## Acceptance still pending

Stable product/runtime mappings, actual executor restart, two independently authenticated browser contexts, Goal creation through the desktop page, mobile artifact approval and desktop result convergence are covered by current tests using a simulated HTTP model provider. Pending: live-model Queue/Steer acceptance, branch creation, real-model/physical-device lifecycle, closed-app push and live Tailscale acceptance. The browser tests and SIGKILL tests establish different boundaries; neither substitutes for the other's assertions.

## Server-side control receipts

The v74 `controls` endpoint applies edit, reorder, Queue-to-Steer, queued-input cancellation and exact-task abort to the same official Durable Inbox/run. It binds a stable request ID and the committed queue digest; stale targets receive rejected receipts. Recovered intents and native receipts are checked before activation. Original input identity is retained, effective queue content comes from applied controls, and shared answer entries project only once. The backend commit provides this protocol; the subsequent Pocket UI commit exposes its controls in the existing chat. Branch creation and live-provider/physical-device acceptance remain pending.

## Pocket control integration

The existing chat displays committed queue content/mode and provides edit, move up (full order), Queue-to-Steer, cancel and current-task abort. The original chat input Stop button uses the same task-bound control protocol. Snapshot busy state also reconciles the existing chat input state; an edited/duplicate user-message event does not manufacture a new execution wait. Applied edits update owned product history without changing original admission evidence. Paused/terminal Goals show their actual state, and an unavailable live Inbox is shown as unknown rather than an empty queue.

A per-account/Session **per-tab sessionStorage journal** saves the exact command, expected queue digest and request ID before POST. Reload retains a lost-response operation; the user can explicitly retry its original receipt. Reconnect never posts it automatically. One unknown operation cannot be overwritten by a new queue action or by Stop. Another tab has its own operation journal. Storage failure rejects before POST. Account/Session changes discard stale UI responses. Receipts and queue/execution state remain server-authoritative.

The compiled product browser case uses two independent signed logins. A phone edits a queued input, loses the actual applied response, reloads and retries the same key; desktop and mobile converge on both the queue and edited history. A desktop chat Stop also loses its response and survives reload with its original task/key; mobile observes actual idle state. It then continues the existing detached-execution, Goal restart, original approval, verified artifact and result-delivery case. The model provider is simulated; this does not establish physical-device or live external-model acceptance.

## Personal Device Tool continuity

Session snapshots now include bounded `device_commands` metadata without file
contents. Pocket renders their persisted state through the same snapshot/update
reconciliation. Detach keeps native execution; Goal pause retains the original
Tool memo/intent and fences Node dispatch/results. Resume/restart reuses it and
reprojects `waiting_for_device`; exact-generation abort cancels only that
generation's commands. See [device-nodes.md](device-nodes.md).

## Cloud Session continuity pilot

Explicit Cloud Sessions now reuse the formal product creation/message/runtime/
control routes. Web, PWA and Electron use one authenticated product Session;
foreground snapshots remain authoritative, while WebSocket updates invalidate
cached state. Node epoch/revision and separate durable Cloud epoch/revision
identify their respective state owners. Client reconnect never submits an input.
The backend may bind a missing receipt from a verified snapshot, preserving its
original request and native ID.

Queue edit/reorder/cancel/Steer and exact Abort use the existing intent/receipt
protocol against that DO. Pending input text is projected from native plain text,
while Node Durable still uses its original structured payload. Abort preserves
unrelated queued input in pinned Pi 1.3.0; a later explicit user instruction
advances that queue. A stale Abort retry cannot stop the newer task.

Closing clients stops their foreground reads, not execution or result delivery.
The DO's bounded result outbox updates the existing message store/status without
a resident Node Session monitor. Expired history reads do not start Lifecycle or
open a Harness. Delivery pending/blocked and expired execution are visible in the
existing Pocket panel. Physical mobile/desktop network switching and actual
Cloudflare hibernation remain Pending; the current two-client test uses distinct
real authenticated Cookies with actual Node/workerd and simulated model output.

## Cloud approval control

Snapshots now include `runtimeWaits` and report `waiting_for_approval`,
`waiting_for_receipt` or `blocked`. The existing Pocket panel renders these
server states. Queue controls remain available during the two waiting states;
receiving another input queues it under its original receipt without resuming
the model. Approval controls reuse the existing authenticated exact-content UI.

A decision commits in Node before the signed Worker wake. A failed wake returns
`runtimePending` without undoing or recreating the decision; the DO Alarm checks
the same original receipt. Product abort uses the exact native control ledger,
including its generation fence, rather than an unfenced direct withdrawal.
Closing a client still detaches only. Concurrent snapshots do not reconcile live
tasks or grant execution. A broken DO stub after interrupted I/O is discarded;
the production router resolves a fresh stub for each request.

## Managed Cloud recovery and stop state

Cloud snapshots now include bounded runtime recovery receipts (run, state, probe
count and next wake) alongside the existing ordered revision and native view.
`recovering` is displayed as waiting for runtime recovery rather than idle.
`suspended` covers paused/exhausted runtime work as well as an expired grant;
its label does not falsely attribute every stop to expiration. Goal pause/cancel
remains the control while runtime recovery disables Session queue mutation.

Detach and historical reads never submit an input or activate a grant. The
managed Cloud stop RPC is distinct from Abort: it closes an owner while preserving
native checkpoints and requires an exact current lease or paused/terminal Goal
revision. Resume reuses the original grant; cancellation permanently fences its
owner. A late old stop, grant or Alarm cannot cancel/reopen a newer execution.
Actual local workerd Alarm/eviction and Node pause integration are recorded in
[evaluation.md](evaluation.md); physical-device/deployed-cloud claims remain
Pending.

## Cloud Handoff control fences

Cloud Handoff lifecycle transport is distinct from client detach and from
business Scheduler grants. Explicit pause/cancel commits a restrictive DO state
with its exact Handoff revision before owner shutdown. Resume requires a live,
currently pending product revision and persists a bounded runtime wake before
opening the original checkpoint. A stale/cancelled control never becomes a new
input. See [Cloud Bot Team integration](cloud-bot-teams.md). Cloud Group admission
and formal progress/association recovery remain gated and Pending.

## Cloud Handoff progress receipts

Cloud Group observation uses the existing local Group snapshot and revision
invalidation. The Worker projects its actual native Input/LiveDoc/Inbox records
through a single coalescing SQLite outbox and the existing Lifecycle projection
job. Node verifies the exact input/Submission/marker and retains the monotonic
observation receipt. A separate control version prevents pre-pause/pre-resume
updates from replacing current state. Group reads do not start another Harness
or poll the Cloud owner for status. Progress is not an approval or completed
answer; those remain separate authoritative product/native receipts. Public
Cloud Group admission and final multi-device presentation remain Pending.

Ordinary same-epoch message/progress invalidations preserve the last authorized
interaction while refreshing its server snapshot. The view separately reports
that new activity is being synchronized. These hints do not starve an in-flight
snapshot under continuous progress. The additive content-free `operation` hint
is conservative: unknown operations, authorization/configuration changes and new
process epochs still require verification; disconnect/revocation retain their
immediate fences. Every write is independently authorized by the backend. A
browser regression holds the next snapshot while another device posts between
the mobile send button's pointerdown/up, then verifies the actual submitted
message, ordered server timeline and existing revoke/restart behavior.

## Team product reconciliation

The Bot-first page consumes an authenticated owner snapshot of Goals, readable
Groups and existing attention records. It revalidates on reconnect, visibility,
Group changes and a finite UI refresh interval. These reads do not submit inputs
or wake another executor. Mutations retain their existing request IDs/revisions;
unknown results offer only an explicit same-request retry. Switching accounts
unmounts owner-scoped state and ignores late old-owner replies. Workspace/Host
revocation changes the next authoritative response and still fences every actual
operation immediately.

The final Team browser scenario covers Goal → two Cloud Handoffs → offline local
node → phone grant → actual CLI file receipt → artifact approval → result, then
page reopening and a stale response during real logout/login. The desktop context
explicitly overrides the runner's default mobile preset. iOS-style hash routing
and touch Chromium are emulation; physical Safari/PWA background survival remains
Pending. See [product convergence](product-convergence.md).
