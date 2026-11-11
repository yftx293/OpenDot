# Cloud Bot Team integration (#34)

Status: **formal Cloud Handoff admission implemented behind a default-off flag;
Goal-driven Group integration remains Pending**. The existing Group API and
Runtime Router can explicitly select Cloud execution. Local production-Node/
workerd/phone-browser acceptance exercises Group→Cloud→Group and original
approval/effect receipts; inference and HTTPS hostname routing are fixtures.
No Cloudflare deployment or physical-device acceptance is claimed.

## Existing capabilities reused

The integration branch combines native Group/Handoff PR #38 with the already
validated Cloud recovery and public Goal work from PR #27/#28. Runtime ownership,
PiHarness, SQLite, Lifecycle/Alarm, business Scheduler, encrypted Provider,
Workspace/Goal ACL, artifact approvals and result outbox remain the original
implementations. The combined branch has exercised real local Node/workerd/
Scheduler/browser Goal execution; Provider responses and hostname routing are
fixtures. `MINICLAW_CLOUD_GOALS` stays opt-in, never enabled by Group membership.

The original worktree's unrelated uncommitted recovery-controls work remains
untouched. Existing private Native/Coding/Cloud identities are not adopted or
moved. Node schema is now 82 for the additive association outbox. Exact package metadata was rechecked on
2026-10-18: Pi Durable 1.3.0 and agents 0.28.1, matching locked dependencies.

## Session mapping and implemented safeguards

The chosen granularity is one explicit target Handoff → one new Product Session
→ one immutable Cloud placement → one DO and Root Conversation. A shared Group
is a business timeline, not a superuser execution owner. Profile is the role;
Workspace scope and expiring tool/model grant are separate. Existing Node
Handoffs cannot silently acquire a Cloud placement. No old private/Goal Session
can become a Handoff. Goal association is still Pending; attaching a Goal ID as
metadata would not satisfy the required Goal-driven execution contract.

Optional new Cloud binding metadata records the Handoff ID, Group ID and frozen
grant digest. Before association, Node verifies the original Handoff already
owns that new Session. Model-step budget, deadline and tool capabilities must
exactly match the reviewed immutable grant. Runtime authorization verifies that
same origin/marker/grant again. A forged marker or internal provisioner that
broadens tools/budget/deadline rolls back the whole association. The permanent
origin marker from #38 remains necessary; deleting it is never a migration.

The existing signed result RPC/outbox can carry the actual answer-producing
Task ID read from the official committed Assistant Entry. Node binds that source
to the original input/answer/message hash in the existing product transaction.
A Handoff answer without native Task proof is rejected; changed replayed sources
conflict. Ordinary old Cloud bindings emit the same legacy result payload bytes
without this field, preserving immutable pending receipts. The Group projector
continues to accept only native-source-ledger results, never caller progress text.

A Handoff binding has an explicit empty-or-reviewed tool list. It cannot inherit
legacy implicit `inspect_text` or Personal Memory access. Explicit inspect_text
is a portable read-only byte/hash computation; controlled private artifacts use
the existing Node approval/effect service, not a Workers filesystem. Ordinary
Cloud bindings retain their legacy inspect behavior. No local file, Shell,
browser or device capability is added to a Cloud Handoff by these foundations.

Progress validators bound native run ID, revision, partial text and tool state;
they reject final-answer/approval/owner fields. Their delivery and original-input
association repair are described below. Formal Goal association remains Pending.
A Node-only pause must never masquerade as stopping a Cloud owner.

## Build and evidence boundaries

Runtime validators stay in each workspace and are compared in Node tests. The
shared wire file contains portable types/crypto only, so a standalone Cloud
install does not depend on Node backend packages. A temporary copy with only
Cloud node_modules typechecks successfully; a negative control importing the
Node validator fails on missing Root zod. No installed dependencies were changed.

Actual workerd tests read committed Submission/Entry/Generation Task and the
existing result outbox, then evict the DO and verify one retained input/no extra
model request. Empty Handoff capabilities expose no tool; ordinary bindings
still expose inspect. Product policy in these workerd cases is **simulated**.
Node SQLite tests cover real association rollback, immutable runtime kind and
frozen grant matching with synthetic provider configuration. A mock-policy
workerd pass is not a real authenticated Group/Node/Cloud acceptance result.
See [evaluation](evaluation.md) for observed counts and remaining gates.
A test-only transform removing the native producer from the result payload
fails on the intended receipt assertion, while generation itself completes;
it does not alter production files or relax any scope.

The first new workerd attempt had two fixture model IDs inconsistent with the
fixture authority, plus an extended `/requests` statistics response that broke
an existing exact assertion. The new tests now use the declared fixture model
and a separate `/request-tools` endpoint. Existing exact assertions, authorization
and timeouts remain unchanged. A NodeNext typecheck exposed an extensionless
portable protocol import; the explicit .js specifier works in both builds.

Once Cloud Handoff admission is implemented, deploy matching marker/Task-aware
Node and Worker versions before enabling it. Do not strip marker/capability
fields to roll back or reinterpret a native checkpoint as a new prompt. Preserve
both product and DO stores, native receipts and artifact effects. Existing old
bindings remain unchanged, and no production data/resource was migrated here.
Live vendor, real Cloudflare deployment/hibernation/billing, physical devices
and live IM delivery remain Pending. These foundations do not complete #34.

## Handoff suspend/resume controls (local implementation)

An exact Handoff ID/revision fence now distinguishes Handoff controls from Goal
revision/claim controls. The signed Node stop policy verifies the registered
placement, immutable origin and frozen grant, and permits only a restrictive
state. Stopping remains possible after Host/model execution rights disappear;
that proof grants no read, model, tool or resume authority. The DO rejects a
Goal fence for a Handoff and retains a monotonically increasing control fence.
A late pause/resume cannot reopen a cancelled owner.

Resume uses the normal live product/Workspace/Host/provider authorization plus
an exact **pending** Handoff revision. A separate signed policy response binds
the fence digest. Stop-only authorization cannot reach this path. Node and
Workers keep independent strict wire validators; no Node dependency enters the
Workers bundle. Private transport remains HMAC authenticated in both directions.

`mc_handoff_lifecycle` is an additive, one-row-per-DO SQLite table. A stop commits
the restrictive runtime state and control fence in the same local transaction,
before cancelling runtime wakes or closing the owner. An explicit resume commits
its identity and a Lifecycle job before opening the original native checkpoint.
The existing Lifecycle/Alarm queue repairs interruption between intent and
activation. Each probe rechecks current product authority, uses persisted
attempts/backoff, and stops at eight probes or the original grant deadline.
An exact retry does not reset its counter or extend authorization. Newer stop
intents cancel pending resume wakes. No business occurrence, prompt, input,
Submission or replacement Task is created by these controls. A read-only paused
Harness is closed before the active owner can reopen.

The existing Group resume command calls this transport only for Cloud-owned
Handoffs; native Node resumes retain the existing reconcile path. These isolated
lifecycle tests alone did not open admission. The later formal opt-in path below
uses them together with progress and association repair. Goal-driven Group
execution remains Pending. No isolated lifecycle test establishes Cloudflare
production hibernation, vendor inference or physical devices.

## Handoff model transport recovery (local implementation)

The existing `ExecutionRecovery` Lifecycle capability now accepts either its
original Goal execution grant or a frozen Handoff recovery subject. A Handoff
subject uses the actual Product Session/runtime/marker/configuration identity,
original model-step budget and deadline. It creates no fake Goal, task, business
occurrence or Scheduler run. The existing SQLite column named `run_id` is retained
for compatibility; a Handoff uses its actual runtime ID as this internal key.
Snapshots label it `kind: handoff` with `runtime_id`/`handoff_id`, never a Goal
`run_id`. Existing Goal grant JSON, job references and snapshot rows keep their
original wire shape. No new Harness, storage adapter or scheduler is introduced.

Handoff model admission moves to the custom fetch boundary, where the native
invocation's abort signal exists. Interrupted/truncated SSE and retryable
transport failures park the original native task, commit a recovery intent and
close its owner outside the invocation. A bounded existing Alarm job rechecks
live product authority before resuming the same checkpoint. Every model retry
consumes the original step budget; the original deadline is never renewed.
Partial model requests may be billed despite interruption. This is a permitted,
charged model retry, not vendor exactly-once billing or a replacement prompt.

A tool whose receipt already committed is not executed again merely because a
later model request failed. The controlled artifact's existing identity,
approval, receipt and uncertain-effect rules remain mandatory. No new tools or
capabilities are granted, and this does not establish generic email/remote-write
replay safety. Explicit pause/cancel also suppresses these recovery wakes;
restoring an old permission cannot reactivate a cancelled owner.

New workerd faults use actual native tasks/SQLite/eviction/Alarms but simulated
product policy, SSE and artifact endpoints. They preserve the original
Submission/GenerationTask through interrupted SSE, preserve a committed tool
effect, stop after a two-step budget, retain the original deadline and fence
revoked/cancelled recovery. Formal public Group progress, association repair and
Goal-driven execution still need their own verified integration before admission.

## Durable progress projection (local implementation)

The existing `project-results` Lifecycle job now also samples Handoff-only
progress from the official SQLite Input/LiveDoc/Inbox records. Sampling opens no
Harness, starts no model and creates no new poller, scheduler or business event.
A single-row `mc_handoff_progress` outbox coalesces snapshots, persists a separate
monotonic observation version, and retries an immutable payload/digest at most
eight times with retained backoff. A newer actual frame supersedes an older
observation; an unchanged delivered/blocked frame schedules no further wake.
Final native result projection remains the only way to publish a completed
Group answer. No Goal/legacy Cloud progress requests are introduced.

The signed product receiver verifies the original Handoff marker, full input
receipt and native Submission against the registered object/owner. It can repair
that original submitted-input receipt, but cannot create another input, supply
an answer, approve an operation or select another Workspace/runtime. Waiting for
approval is derived from actual product approval rows, not a producer claim.
Group clients continue using the existing authoritative snapshot/revision
invalidation protocol. The Group coordinator reads persisted Cloud projection
rather than opening snapshot RPCs on each reader's refresh.

Progress carries the DO's latest control revision as well as its observation
version. Node records its exact dispatch fence before asynchronous suspend/resume
RPCs. Old pre-pause/pre-resume observations are acknowledged without changing
business state. Observation metadata never increments the Handoff control fence
while a resume is pending. Existing terminal-row SQL guards remain unchanged:
late observations acknowledge an ignored terminal outcome without mutating it.
Known duplicate/different-payload versions conflict; old versions cannot replace
new progress. Current Node metadata lives in the existing progress JSON, which
retains its legacy empty initial representation until first observation; Node
schema for the progress-only slice remains 81; the later association slice below
adds schema 82. Malformed nonempty data does not become an empty history.

The progress-only slice did not open public admission. The formal opt-in path
below additionally exercises actual Node policy, public routing and phone
approval. Formal Goal-driven Group execution and remaining multi-device controls
are Pending. The isolated workerd policy/model endpoints and retry-clock fault
injection remain explicitly simulated; actual deployed Cloudflare and
physical-device evidence remain separate.

## Bounded original association repair (schema 82)

`bot_handoff_associations` is an additive Node outbox for marked Cloud Handoffs.
It freezes the existing Handoff/Session/request/payload/grant identity in the same
transaction as Session association. Existing active Cloud Handoffs receive repair
records during migration, without creating a Session or admitting input. Native
Handoffs and ordinary Cloud Sessions retain their existing recovery paths.

The existing Handoff coordinator scans due rows only after the private HTTP
authority is listening. It charges a persisted attempt/120-second lease before
cross-store requests, with eight attempts and 1/2/4/8/16/32/60-second error backoff.
An interrupted process retains its charged lease; duplicate kicks cannot renew
the budget. The older generic Cloud startup loop excludes these marked owners.
No business Scheduler, second runtime owner or model continuation loop is added.

A missing input is admitted only under its original immutable Handoff request.
An already admitted input is reconciled through the existing Runtime Router and
native idempotency receipt. Only an original product input with a committed
positive Submission, bound DO and conversation can settle the association.
Post-submission snapshot failures cannot create a second input. Actual progress
or result receipts may settle admission uncertainty without another transport
probe. Paused/cancelled state is rechecked after asynchronous repair; confirming
a receipt cannot reactivate it or change its control fence.

Exhaustion or unavailable live authority stops automatic repair and is visible
in the existing Group task card. The original receipt/identity remains intact;
`blocked` does not claim that a remote accepted operation never occurred. No
automatic budget reset or replacement prompt is offered. Association attempts
are separate from model-step and final-result delivery budgets. Public Cloud
Group admission is opt-in as described below; formal Goal-driven Group execution
remains Pending.

## Formal opt-in Group API and UI

`MINICLAW_CLOUD_BOT_HANDOFFS=true` additionally requires the existing Groups,
Handoffs and Cloud Runtime flags, valid HTTPS gateway/shared-secret configuration
and an authorized OpenAI-Completions Provider. It defaults off. Only the current
Group Owner may create a reviewed `cloudflare-durable` grant for an owned Bot
Workspace. The existing Group API/provisioner atomically creates the new Product
Session, immutable Cloud placement/origin and association outbox before network
execution. Native/Coding/old Cloud Sessions are never adopted or switched.

The grant freezes 1–12 model attempts, its original expiry and the explicit tool
list. Default tools are empty; Cloud supports only `inspect_text` and separately
enabled `create_approved_artifact`. Native-only `read_workspace_file` is rejected
for Cloud, and `inspect_text` is rejected for Native. Global Cloud Memory/tool
defaults are replaced with this reviewed list; Group membership does not grant
Personal Memory, MCP, Shell or device access. Artifact admission also requires
`MINICLAW_CLOUD_APPROVALS=true`. The form exposes runtime selection and appropriate
tool labels inside the existing Owner grant controls.

Turning off new Cloud Handoff admission does not change existing ownership,
approve operations or cancel work implicitly. Existing original checkpoints and
reviewed approval receipts remain controllable under live policy; revocation
uses the existing restrictive controls. The real phone-browser test turns off
both new Node admission and workerd admission before approving the retained
Tool Task, then reconciles a lost decision ACK against one mode-0600 artifact
with unchanged inode/mtime and one Group result.

This is still a hybrid Node authority + Cloud execution system. Node Gateway
availability is required for current authorization, encrypted Provider proxy,
tool effects and product projections. Group Goal routing and Cloud-to-Local-Node
tools are not enabled by this feature. Deployed hibernation, vendor inference,
physical Safari and external IM remain unverified.
