# Goals and tasks

## Current execution paths

`MINICLAW_PERSONAL_GOALS=true` enables owned Goal APIs and the existing `/goals` page. With `MINICLAW_DURABLE_RUNTIME=true`, a new Goal without an existing Session in an authorized Host workspace atomically creates its conversation Session, immutable **Node Durable** binding and one managed task definition. Creation commits before the existing Scheduler admits the initial TaskRun. Retries use the same Goal creation receipt and initial run key. Startup repairs an interrupted creation-to-start gap using the managed-task marker, including when rollout flags later change.

Other workspaces and existing manually linked tasks retain the prior Coding Agent path. The two flags default off. Main, Docker execution and existing JSONL Session identities are preserved. This is an experimental Host rollout; live external-model acceptance is still pending.

Explicit Cloud creation is now available behind `MINICLAW_CLOUD_GOALS=true`,
`MINICLAW_CLOUD_RUNTIME=true` and `MINICLAW_CLOUD_APPROVALS=true`, in addition to
`MINICLAW_PERSONAL_GOALS=true`. It requires the current Workspace owner, Host
execution permission and a compatible configured `openai-completions` model.
`POST /api/goals` accepts optional `runtime: "cloudflare-durable"`; the same
existing Goal page exposes the choice after an authenticated Workspace-scoped
availability check. The choice is persisted when the new Session is created.
Missing `runtime` preserves the existing Node path and creation-request hash.
Cloud does not depend on enabling new Node Durable Sessions. Unavailable Cloud
configuration rejects the transaction; there is no fallback or runtime adoption.

Cloud Goals allow at most 100 business runs, within the existing DO input quota.
Their serialized core context must fit 30,720 JavaScript characters, reserving
space within the 32,768-character input limit. Objective, completion criteria,
next action, identity and capabilities are never trimmed. Only prior-result
excerpts may be shortened/omitted with an explicit notice; the original frozen
snapshot and digest remain intact. Creation and content/budget edits validate
these constraints before committing. Status-only pause/cancel remains possible.
These limits do not replace the existing Session history/tool/storage quotas or
provide a currency budget. Retrying a committed creation receipt after admission
is disabled returns the original Goal, Session and task, without creating more.

A managed Session stores its immutable Goal owner in the product runtime mapping. It cannot be reused by another Goal or silently become an ordinary conversation if a link disappears. Legacy manual Session associations do not grant managed ownership or change either runtime.

## One execution owner

The existing Scheduler owns Goal run creation, leases, start markers, run budgets, cancellation and the result outbox. A managed task definition stays paused with no due-time cursor; individual bounded steps are normal persisted TaskRuns, not a second timer or queue. The Goal page displays their actual run receipts rather than calling that internal template an active recurring schedule.

Each occurrence freezes the Goal ID/revision, objective, completion criteria, next action, owner/workspace/Session, allowed tools, remaining run budget, delivery policy and up to three prior results. The frozen context is bound to the Scheduler occurrence and sent through the formal Session's original Durable Inbox input (`goal-run:<TaskRun ID>`). A changed Goal affects the next occurrence; it does not change a pending operation's meaning. A mismatched context or runtime fails closed, never falls back to Coding Agent.

Only a persisted Goal context bound to a Durable Session permits a started TaskRun to be reclaimed after lease expiry. Its original conversation, input, approval and budget charge survive. Existing Coding/script runs retain the no-blind-replay failure boundary. Goal Harness activation is deferred until a current Scheduler claim exists; startup does not independently resume that work. Current owner, Host permission, workspace/provider identity and lease are rechecked during execution. Newly created workspaces resolve from the current database, not an old process cache.

## Cloud Goal execution grants and native handoff

Schema v79 allows the trusted provisioning transaction to create a Cloud runtime
for a new, still-unattached owned Goal. It cannot adopt an existing Node Goal,
change its runtime or repurpose an ordinary Cloud Session. The immutable Cloud
binding includes `goal_id`; old binding bytes remain unchanged. Frozen Cloud
Goal context advertises only `inspect_text` and its actual frozen capabilities,
never Node filesystem/device tools.

`issueCloudGoalExecution` requires the current started Scheduler claim and
persists one immutable grant per TaskRun: Goal/Session/runtime/task identity,
content digest, full frozen-snapshot digest, 12 model attempts and a 24-hour
deadline. A lease takeover retrieves that original grant, including its deadline
and spent budget. It cannot renew an expired grant. Another business occurrence
gets a distinct grant and shares the existing Goal run budget. Alarms cannot
issue grants or create business occurrences.

Private Node policy/model/input/tool callbacks verify the exact grant reference.
Model attempt ID, grant association and both Cloud/Goal counters commit in one
SQLite transaction. Failed or duplicate admission cannot charge twice. A new
occurrence cannot spend an old grant, and its cumulative Session counter does
not reset. Live owner/Workspace/Host/provider authorization remains mandatory.
Historical proof/status reads are separate from permission to continue execution.
Cloud artifact approvals retain the actual Goal/run/task association, so their
real files can pass the existing evidence checks and support later Memory origin
validation.

The Worker now persists the grant, checksum, current execution slot and a
monotonic per-run model counter in DO SQLite. Provisioning a managed binding
requires its full original grant before Lifecycle startup. The backend's existing
Goal executor issues that grant only from its started Scheduler claim; history
and generic backend startup never issue one. A later occurrence can claim the
same Root only after storage-only verification proves that all original tasks,
Inbox entries and submissions have settled. It closes the old in-memory owner,
rechecks quiescence and live authority, then atomically changes the slot and
snapshot revision. A busy handoff returns a typed pending result for the same
Scheduler occurrence. It cannot adopt unfinished work or reset spent budget.

Model, input and tool closures capture their original grant, not a dynamic
current-run lookup. Input/checkpoint/approval/control proofs carry that run;
settled historical proofs remain readable after a later occurrence starts.
Pending controls require current execution authority. Approval waits use the
original grant's deadline and cannot awaken a newer occurrence. The original
input ID remains `goal-run:<TaskRun ID>` through lost submission/grant ACKs.

Actual local Node/workerd HTTP acceptance drives the production Goal step
executor under real Scheduler claims across two occurrences in one Root. It
recovers lost input/grant/control ACKs, queues/edits/Steers/cancels a follow-up,
restarts workerd during approval, creates an actual private file, and completes
the Goal using server-checked evidence. Model replies and hostname routing are
fixtures; Scheduler claims are advanced by the test rather than its background
loop. This is not deployed Cloudflare or vendor-model acceptance.

The formal mobile-page acceptance now creates a Cloud Goal with a lost creation
ACK, lets the real background Scheduler start it, kills the isolated Node process
and restarts workerd, then waits for natural lease takeover of the same TaskRun.
The phone approves the exact artifact; another workerd restart before receipt
reconciliation preserves the input/tool/approval identities and actual file.
Server evidence completes the Goal and the existing outbox delivers its result.
Model HTTP replies and hostname routing are fixtures; this is local workerd,
not deployed Cloudflare, live vendor inference or a physical phone test. An
absent Cloud connection alone is not evidence of runtime recovery. Session
history/input/artifact quotas and the hybrid Node authority dependency remain;
a new grant does not clear history or authorize unlimited storage/model work.

## Bounded progression and evidence

A run spends its shared Goal run budget once at the existing irreversible-start marker. Safe pre-start retries spend none; process recovery and pause/continue do not double-charge the original run. Model credential preparation is additionally limited to 12 attempts per occurrence in persistent state; restarting cannot reset it. The existing duration limit includes queue, approval and paused time. Token/currency accounting remains unpriced and is not a cost budget.

After a step settles, the host reads only completed artifacts bound to that Goal/run, verifies the actual private file hash, and stores evidence references and criterion results. The literal condition `artifact_contains:TEXT` is checked by the program against approved artifact content; it verifies containment, not research quality or truth. When all criteria are such checks and pass, the Goal completes. Natural-language conditions with an artifact become `waiting_for_input` for explicit user confirmation. A model's completion sentence alone cannot complete a Goal. Without sufficient evidence, the Scheduler may create the next occurrence within the remaining run budget; exhaustion or execution failure stops progression. An edited Goal waits for user review rather than completing against stale criteria.

The existing isolated-run completion transaction persists the result outbox together with Goal evaluation and any next occurrence. Default delivery is the same Session plus the owned workspace, with an empty IM channel selection; no new external recipient is inferred. The existing outbox worker records delivery/retry receipts and never reruns model work to repair delivery.

Before a managed Goal result is projected, the worker rechecks its current Goal state, workspace owner/folder, active user and Host grant, and the exact owned delivery scope. Paused, cancelled or revoked scopes receive an explicit skipped receipt instead of a stale notification. Already committed Session results remain subject to normal read authorization.

## Approval and controls

`create_approved_artifact` persists the exact content and operation, owner/workspace/Session, Goal, TaskRun and original tool-task identity. Chat displays its content/digest for approval or rejection. Goal waiting state derives from the real pending intent. Consent is valid only for that active run and its immutable parameters; expiry and cancellation prevent reuse. The private write is exclusive, receipt-bound and hash-reconciled. A partial/mismatched effect becomes uncertain; it is not automatically overwritten. See [durable-runtime.md](durable-runtime.md).

On the public Node Goal path, pause persists a Goal fence and closes its Harness while retaining the original run/checkpoint. Resume claims that same occurrence and consent; it does not submit a fresh prompt. Cancel fences the task, revokes unfinished approvals and closes/blocks execution. Late callbacks cannot reopen a cancelled Goal or reverse a completed effect. An active owned Goal Session cannot be deleted as an alternate stop mechanism; cancel the Goal first. Natural-language completion requires a stopped execution and at least one verified artifact before user confirmation.

The existing page links directly to the execution Session and approvals. It refreshes authoritative Goal snapshots on selection, visibility/network return and at visible-page intervals. This is not yet the full ordered Session update protocol. Follow-up/Steer admission uses the same Durable Session and original request receipts; complete queue editing and progress projection remain pending.

## Reproduction and limits

Configure an existing API-key provider, then start `MINICLAW_PERSONAL_GOALS=true MINICLAW_DURABLE_RUNTIME=true npm run dev:all`. Create a Goal in the Host workspace, open its execution Session, review the proposed artifact and approve it. Review the evidence and confirm natural-language completion when requested. Provider API selection and migration/rollback requirements are in [durable-runtime.md](durable-runtime.md) and [migration.md](migration.md).

`tests/product-runtime-http.test.ts` starts the real backend, creates Goals through signed HTTP, kills/restarts the actual executor and exercises original-run recovery, pause/continue, approval, literal criterion evaluation, human confirmation, model-step limits and outbox receipts. Its local HTTP provider is simulated. `product-session-continuity.spec.ts` creates a Goal through the actual desktop page and approves/reads its artifact from an independent mobile browser login. Neither proves a live model or physical device.

The historical `npm run demo:personal-goals` remains a provider-free metadata/Scheduler-fence demo, not this execution acceptance. Ordered controls are described in [session-continuity.md](session-continuity.md). The signed GitHub workflow uses this Goal path; see [proactive-workflows.md](proactive-workflows.md). Explicit promotion of verified completed-Goal excerpts to [Personal Memory](personal-memory.md) is implemented, with current-owner checks and revision-bound workspace grants. General external write tools, physical devices and real-model acceptance remain pending.

## Device wait projection

A managed Run with queued/dispatched device reads projects `waiting_for_device`
(unanswered approval takes priority). It remains the same Scheduler occurrence
and budget charge through pause, resume and restart. Existing duration budget
continues during offline time; the engine never silently chooses another device
or copies data to another execution location. See [device-nodes.md](device-nodes.md).

## Internal Cloud interruption and pause recovery

Managed Cloud requests admit model attempts at the fetch boundary, where the
native invocation abort signal exists. A transport failure, timeout/5xx/429 or
incomplete SSE stream parks the original native task: persist a runtime recovery
intent/wake, then close the in-memory Harness outside that invocation. It does
not settle the input as a model error or send a replacement prompt. Compatible
complete `finish_reason` frames may end without `[DONE]`, matching pinned Pi
1.3.0; partial JSON/SSE frames cannot fabricate a completed reply.

The Alarm resumes only the same accepted grant after fresh Node policy and
native reopening checks. Recovery probes are persisted, back off to 60 seconds,
and stop after eight checks or the original grant deadline. Model requests still
spend the same twelve-attempt quota. A model read may be requested again from
its native request checkpoint and incur another provider charge; this is not
resume of a vendor-side HTTP stream. Tools retain their existing intent/approval/
receipt policies and are not replayed by this recovery mechanism. Exhaustion
is observable as suspended with recovery metadata. Reads do not resume it.

Cloud stop uses the captured Scheduler lease owner/token, or an exact persisted
paused/terminal Goal revision. Worker serialization and a fresh Node callback
reject stale stops; a cancelled owner cannot be activated by a late grant or
Alarm. A stop-only callback remains available after Host revocation or a runtime
block, while granting no execution or content-read rights. Explicit pause keeps
the original task/submission/checkpoint; resume uses its same grant and budget.
Queue controls remain disabled during runtime recovery; the owning Goal's pause
and cancel controls stop that work. Explicit Cloud admission is now implemented
as described above. Live vendor inference, deployed lifecycle and physical-device
acceptance remain Pending.

## Partial updates preserve the reviewed budget

Status-only pause/resume/cancel and partial content edits preserve omitted
`budget_max_runs` and `next_action`. Creation still uses its documented defaults;
PATCH strips those creation defaults before making fields optional. Explicit
budget changes and an explicit empty next action remain supported under current
Owner/revision checks. A pause/resume does not renew exhausted Goal quota or
change the frozen content digest by erasing a next action. Existing Scheduler
reservation and model-step guards remain unchanged.

## Goal Teams

New Goals may explicitly associate an existing Group and reviewed Bot membership
IDs under `MINICLAW_GOAL_TEAMS`. The existing Scheduler now coordinates one
Handoff per occurrence; native-verified results and actual approved artifact
receipts drive bounded progress. The coordinator Session cannot execute a model.
See [controlled Goal Teams](goal-teams.md) for exact admission, current serial
selection, product links, limits, evidence and remaining UX/device work.
