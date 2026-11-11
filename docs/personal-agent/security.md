# Security boundaries

Device Nodes reuse existing Cookie owner identity for pairing and explicit approval.
A separate hashed node-token verifier only authenticates heartbeat/poll/result.
Finite declarations confer no rights until an owned-workspace, path-subset, expiring
grant exists. Every dispatch/result/Tool return checks current identity, Host policy,
Workspace/runtime binding, Goal claim, native active task/memo and exact grant.
Revocation cancels pending commands; old mutation receipts cannot reactivate grants.
Only `files.read` is implemented; no local writes, Shell, apps or browser. See
[device-nodes.md](device-nodes.md) for read limits, private local state, audit and
revocation limits. Already authorized reads/history cannot be retroactively erased.

Personal Memory uses the existing actual-owner Home Memory ACL and revision
lineage. Only an authenticated user can confirm a save/edit/forget; no model
write tool is added. Verified Goal promotion additionally requires current Host
privilege, original runtime fingerprint, completed Goal evidence and actual
artifact hash/substring verification. Personal origin is immutable. Additional
workspace reads require explicit grants to that exact revision; changes through
the ordinary Home editor invalidate old grants. Runtime reads check current
Session/Home/destination authority before returning bounded facts, and their
audit receipts store IDs, revisions and digests without raw fact text. Forget
blocks new recall, while earlier authorized transcripts retain their history.
See [personal-memory.md](personal-memory.md).

GitHub event admission is opt-in and separately authenticated with exact-byte
HMAC-SHA256. Knowing a subscription ID or having a Cookie grants no event access.
Signing references require an explicit deployment-controlled
`owner_user_id / workspace_jid / secret_variable` capability declaration. An
administrator cannot enumerate or use another owner's references. Missing or
malformed grants fail closed; intake, existing Goal execution and delivery all
recheck current grants and Host/workspace ownership. Owners retain cancellation
access after a grant is revoked. Signing secrets remain local deployment secrets,
never API payloads or persisted registry values. Payloads are bounded, filtered
and treated as untrusted data; arbitrary webhook text/URLs never enter model
context. See [proactive-workflows.md](proactive-workflows.md) for the implemented
limits, receipt retention and cancellation semantics.

## Existing boundaries to preserve

MiniClaw owns authentication, user/session and workspace ACLs, authorized tool selection, workspace mount policy, scheduler policy, channel account binding, and workspace-memory provenance. Pi Durable must execute only capabilities deliberately installed in its registry and environment. Importing its general coding tool bundle without a MiniClaw policy adapter would bypass product constraints and is prohibited.

The pilot's snapshot, submit, watch, and submission-recovery operations call an injected authorization callback; watch delivery rechecks read authorization on each frame. Input submission invokes a required host admission hook and independently commits a persisted request/payload digest before calling Pi Durable. It has no direct HTTP route and registers no tools. The Harness does not resume on open; submit is gated until an explicit activation callback verifies recovered ownership. Its SQLite database file is set to mode `0600`; the parent directory is created with mode `0700` subject to existing directory permissions. Online backup/restore is implemented; production ownership mapping remains pending.

Guarded adapter instances additionally hold a private local SQLite coordinator lock before opening Harness storage. Competing processes are denied; canonical symlink aliases cannot create a second owner. No stale-file deletion or timeout takeover is used. This protects cooperative local executors, not untrusted code with filesystem access or a second runtime that bypasses the adapter. The session-to-runtime mapping and ACL verification of every recovered conversation remain required before activation.

## Replay and side effects

On the product-session branch, persisted v71 mappings bind a real owner, workspace, conversation Session, runtime and provider identity. The formal HTTP input path and dispatcher use that mapping rather than recomputing runtime choice. Recovery checks all conversations/tasks and input receipt digests before scheduling; one invalid Session is isolated from valid Sessions. Host role/user/workspace revocation and duration exhaustion close the actual in-flight executor. A bounded workspace read reuses the existing path validator and rechecks authorization before/after reading. The approval follow-up adds only exclusive private-artifact creation, with immutable exact-content consent, current authorization checks and file-hash reconciliation. No arbitrary write, shell, MCP or device permission is granted. Product snapshots recheck current authorization after awaiting runtime reads.

Legacy WebSocket admission, queue mutations and resets cannot silently bypass the Durable admission/control path. Session deletion first stops its Runtime before removing metadata/history. The full ordered view/queue-edit protocol and general external write reconciliation remain pending. Exact artifact approvals survive restart and reject changed parameters, conflicting decisions and cross-owner access. Partial/mismatched effects become uncertain; no automatic overwrite or approval override exists. Private orphan files from deleted Sessions remain inaccessible through the API and need an operator retention policy.

Managed Goal execution additionally requires a frozen Goal/TaskRun binding, a started run with a live Scheduler lease, and the same claim owner/token registered in the local executor. Startup defers these Harnesses until the Scheduler safely reclaims them. A stale executor loses authorization even before its heartbeat notices a takeover; the storage coordinator still prevents simultaneous owners. Coding/script work without that proof is never reclaimed after starting. Paused work cannot obtain new consent; cancelled/expired grants cannot execute. Completion checks read actual artifact hashes, and natural-language completion requires explicit user confirmation and existing verified evidence.

The product runtime's Goal owner is immutable independently of mutable task links. Missing managed scope blocks execution rather than falling back to ordinary conversation behavior. Existing manual links are not promoted. Model selection, Session execution and Goal delivery reuse `canExecuteOnHost`, including its in-progress privilege-revocation fence before the role change commits.

Goal outbox delivery rechecks current Goal state, active owner/Host permission, workspace identity and the exact owned result route. Ownership transfer or a pause/cancel fence suppresses pending delivery with a skipped receipt; it does not send old private text into a newly owned workspace or rerun the model to repair delivery. Product completion receipts ahead of unsettled Durable inputs also block recovery before activation, so inconsistent cross-database snapshots cannot silently replay a completed run.

Pi Durable returns the prior submission for a repeated request ID without checking if the content changed. MiniClaw must bind an input request ID to a payload digest and reject mismatches before submission. Input request IDs prevent duplicate admission only. Before a non-idempotent external write, persist a MiniClaw authorization/intent record and an operation idempotency key. After the call, persist the provider receipt. If a crash leaves the outcome unknown, surface `uncertain` and require reconciliation or approval; do not replay the raw prompt or blindly repeat the tool.

Read-only tools may be replayed only when their scope and workspace authorization are revalidated. File writes/deletes, email or message sending, and remote changes must remain approval-gated according to existing policy and use receipts. Logs and notifications must not include credentials or private tool output by default.

## Tests pending

The optional Personal Goal API requires the existing authenticated user, current workspace ownership, workspace ACL, and host execution permission. An administrator cannot read another user's Goal by bypassing ownership. Store reads recheck active user/workspace ownership; queued starts recheck task ownership, execution type, and frozen workspace scope before charging the shared run budget in the same transaction as the execution-start marker. Legacy task claiming excludes Goal-linked tasks so it cannot bypass these checks. Disabling the feature hides its API/UI but retains execution fences for already-linked tasks.

Goal creation binds an owner-scoped request ID to its payload digest; edits use revision checks. Run retries return the existing Scheduler receipt. Pause/cancel persists a start fence before stopping active runs; a failed stop reports `GOAL_STOP_PENDING` and retains the paused fence. This does not revoke effects a tool already committed. Goal waiting states are metadata, not an implemented approval or device authorization service. No new tools, device grants, cross-workspace memory access, or execution environments are granted by linking a task.

Covered locally: Goal cross-user denial (including an administrator), expired login, workspace ownership revocation, task-scope changes, revision conflicts, budget exhaustion, and stop failures; read-ACL revocation stops subsequent Durable watch deliveries; changed/concurrent/restarted Durable request payloads fail closed; an unverified old submission cannot acquire a new trusted binding; Durable backup/restore preserves private permissions. Pending: production Durable session cross-user/workspace isolation; tool capability deny; real unsafe-tool reconciliation; approval wait/restart; notification/log credential handling under real provider traffic; device grant revoke. SIGKILL tests use a simulated provider and idempotent local effect service and do not establish real external-tool authorization.

## Session control checks

Queue controls require exact Session ownership even for another administrator. Every control binds strict fields, actual product input request IDs, expected committed Inbox content/order, current capabilities and the active Goal run. User content cannot replace sender, origin or execution metadata. Native receipt manifests and effective queue payloads are checked before resuming. Applied controls retain immutable original admission evidence; stale operations are rejected instead of affecting a later run. Abort retries target one task ID. The existing socket authentication and Workspace ACL still filter revision invalidations; snapshots recheck current authorization after asynchronous reads. Provider retry error strings are not exposed in the presentation DTO.

Temporary actual-HTTP tests cover another signed-in administrator, a wrong Workspace route, forged fields, stale queues, changed retry payloads and retrying an old abort during a new run. Actual OS SIGKILL tests cover the native-edit/product-receipt gap. All model responses in these automated cases are simulated. No credentials were committed and no external sensitive write was executed.

## Opt-in Cloud product execution

Cloud Session creation still requires the existing owned, authorized Host
Workspace and configured Provider. It does not grant the Worker filesystem or
shell access. Runtime placement and full input/control payload identities are
immutable, and a local Harness rejects Cloud ownership. Private callbacks bind
owner, Workspace, product Session, runtime, fingerprint, DO ID, exact path/body
and short-lived HMAC authority. Browser Cookies are never machine authority.

Recovery validates all product/native inputs and all native control receipts
before enabling the Harness; actual Inbox bytes/modes must agree with the
verified ledger. Acknowledged checkpoint loss fails closed. Native result
callbacks bind the original submission and answer; duplicates cannot overwrite
a committed result. Transport failure retries that same idempotent product
projection, with a finite retry budget and observable blocked state. This does
not authorize external email, remote writes or another side effect.

Expired execution grants do not allow new model/tool calls. Current authorized
history and delivery access remain distinct: reads use public storage APIs and
never open another Harness or start the scheduler. Provider credentials remain
in the Node encrypted store, redirects and client-selected endpoints are denied,
and current Workspace/Host/profile policy gates reads, model/tool use and result
callbacks. The configured HTTPS Node business authority must remain available.

The opt-in Cloud Memory bridge reuses existing per-item/revision consent and
read auditing; its frozen tool capability grants no memory writes or additional
Workspace access. See [tool-execution.md](tool-execution.md). Cloud Goal and Device Node paths remain closed. Local simulated-provider acceptance and real
Cloudflare/physical-device acceptance must not be conflated.

Cloud private artifacts require a new frozen capability, current live authority
and an exact-content approval bounded by the execution deadline. Their Node
digest binds runtime/generation/call/parameters, while native intent and approval
memos bind the same operation. A pending Abort fences writes before native ACK.
Effect reconciliation uses existing exclusive creation and hash verification;
partial/unknown effects never overwrite data or receive a fabricated success.
An uncertain effect or checkpoint mismatch blocks automatic execution. Waiting
closes the native executor; Queue/control transactions cannot start another
owner. Late approval/Alarm requests use current state and cannot revive a
cancelled task. No generic external write or local device permission is granted.

Schema v79's Cloud Goal grant ledger is an additional backend fence, not another
login or public grant-issuing endpoint. Only a current started Scheduler claim
can mint its immutable run binding; takeovers cannot renew deadlines or reset
model budgets. Managed model/input/tool calls carry the original Goal/run/context
reference. The private model envelope is stripped before calling the configured
Provider. Counter/attempt association commits atomically; duplicate attempts are
refused even after SIGKILL. A partially observed model response is never treated
as a completed checkpoint or permission to reuse its attempt ID. History reads
and approval status can use historical grants but cannot authorize effects.
Cloud Goal creation/Worker ownership is still closed until its handoff is
implemented and verified. Existing Host policy and per-item Memory grants remain.

## Managed Cloud Goal grants

New managed bindings freeze their Goal/Session/runtime ownership before native
execution. Each started Scheduler occurrence issues a nonrenewable grant with
the complete frozen-context hash and twelve model attempts. The DO verifies its
live Node authority, stores the immutable original grant, and captures its run
in model/tool closures and native intents. Slot changes require idle native
Root/Inbox/tasks and a fresh policy check; old receipts authorize historical
verification, never new work. Grant/slot/quota updates use local transactions;
transport failure retains original IDs rather than resubmitting under new ones.

Queue controls retain their original Goal run and must match it in the signed
Node proof. Settled native controls may reconcile historical ACKs after a newer
run; an unsettled control cannot borrow that newer run's authority. Explicit
Cloud Goal creation requires the separate default-off `MINICLAW_CLOUD_GOALS`
flag, current owned Host Workspace permission, compatible model and exact-artifact
capability. Creation and edits reject oversized core contexts or budgets above
100 runs transactionally. Runtime selection cannot adopt an existing Session or
change through a Goal patch. Scoped availability returns no model credential or
deployment secret. Existing Node Goal control semantics are unchanged.

## Shared Bot Group boundary (schema 80)

[Bot Groups](bot-groups.md) have explicit live membership and immutable identity.
A Group member is not a private Workspace member or tool grant holder. Only the
Owner configures owned Bot/Profile scopes; Moderator cannot expand execution
scope. Existing Workspace mirror/ownership and Host revocation are rechecked,
including before Group broadcasts. Another administrator cannot subscribe to
or read the shared timeline without membership. Revocation notifications contain
only IDs/version; message bodies come from fresh authenticated snapshots.
Browser generation fences prevent pre-revocation responses restoring private
content. Previously authorized data already seen by a recipient cannot be
remotely erased from that recipient's own records.

All Group writes are strict-schema, authenticated-author operations with durable
request receipts. Client-supplied Bot/runtime/source identity is rejected.
Membership and mentions alone authorize no model/tool execution. Optional
[Handoff](bot-handoffs.md) uses separate Owner grants, live Native authorization
and exact approval digests. Group API/UI do not expose private memory, Profile
prompts or provider secrets or adopt pre-existing native tasks.
Workspace/Owner deletion follows explicit FK cascade; existing destructive-delete
confirmation includes the Group history impact. Disabling new admission retains
history and authorized revocation, and never downgrades the schema marker.

## Explicit Bot Handoff authority (schema 81)

Only Group Owner requests may spend Owner credentials/tools in this rollout.
An invited user or another administrator cannot create a grant, inspect private
approval contents, delegate or control the Owner's task. The grant binds the
current Bot member revision, actual owned/effective Profile Workspace, runtime,
provider fingerprint, tool list, bounded model attempts and deadline. Rotation
revokes old bound tasks; role, Workspace, Profile, grant and model changes are
checked again before generation/tools/projection/approval. Late events cannot
revive cancelled/uncertain tasks. Origin markers outlive Group deletion so a
remaining native Session cannot become an unrestricted private Session.

One source request owns one dedicated native Session; generic queue edits and
extra private Session inputs are rejected. Native exact-run abort keeps the
existing Task/queue-digest/control receipt checks. Source context and explicitly
confirmed Chief results are user data, never privileged instructions. Bot output
containing @ names does not launch another task. Model usage remains attempts,
not a currency guarantee; a failed network generation can incur another vendor
charge on recovery. Bounded retries do not promise arbitrary external writes
exactly once. Partial/unconfirmed artifact effects are uncertain and require
reconciliation. Only actual committed native answer/Task provenance can produce
a Group Bot result. Controlled private artifact contents remain Owner-only
until a Bot explicitly includes data in the shared result.

## Stop-only authority and recovery

The signed `stop-policy` endpoint verifies the registered DO/Session/Goal owner,
frozen scope and original execution reference. A Scheduler stop carries its
captured lease owner/token; a user stop carries the exact persisted paused or
terminal Goal revision. Claim takeover and later Goal changes reject stale
operations. Cancelling a run permits its immediately preceding claim's stop,
but not an older claim from before a takeover. The Worker serializes this proof
with grant activation and never downgrades cancelled state to suspended/active.

This endpoint intentionally does not require current Host/provider execution
permission: a revoked/blocked owner must still be stopped. It returns only a
stop plan; it cannot authorize models/tools, read content or create work. Existing
execution and history endpoints retain their stronger authorization checks.
Runtime recovery always repeats current execution policy before reopening the
original checkpoint. Failure/backoff/exhaustion is persisted and does not renew
model, Goal-run or time budgets. No tool replay permission is inferred from a
model transport error.

## Cloud Handoff stop versus resume

An authenticated, exact origin/placement/revision proof can stop an already
registered Handoff owner after Host/model access was revoked. It can only
suspend/cancel that owner. Resume uses the full current product authorization,
Workspace and Host checks, immutable model/grant identity and a currently
pending Handoff revision; its policy response signs the fence digest. The DO
also maintains a monotonic revision and permanent cancellation fence. Neither a
Goal claim nor a stop-only proof grants Handoff execution. Bounded persisted
runtime wakes never synthesize new submissions. Cloud Group admission remains
closed while progress/association/model-recovery integration is Pending.

## Cloud Handoff model recovery authority

A stored Handoff recovery subject is checkpoint identity, not a new grant. Every
wake rechecks current product/Workspace/Host/model authorization against the
original frozen marker, step budget and deadline. Safe model retries are charged
again and can incur provider cost; their budget is not renewed by eviction.
Committed tool receipts retain their original task/effect identity. Revocation,
explicit pause and permanent cancellation fence later wakes. No extra tools,
Personal Memory, local filesystem or device capability is inherited by recovery.

## Cloud Handoff observation authority

The private progress RPC requires the signed registered object/owner scope,
original input receipt, native Submission and frozen Handoff marker. Repeated
policy checks bracket the Node transaction. Progress cannot create another
input, provide a completed answer, select a runtime/Workspace or approve a tool.
Pending approval state comes from actual product rows. Stale control versions
cannot reopen paused/resuming work. Known same-version/different-payload updates
conflict; older observations cannot overwrite the high-water receipt. Existing
terminal-row guards are retained and terminal observations do not mutate them.

## Cloud Handoff association repair authority

Schema 82 freezes the original Handoff/Session/request/payload/grant binding and
guards its monotonic attempt budget. Each automatic cross-store attempt checks
current product authority and the original execution grant before transport.
Paused/cancelling/terminal Handoffs cannot obtain a claim. Restrictive state is
rechecked after asynchronous work; a late validated native receipt cannot change
a pause/cancel revision. No repair claim authorizes model/tool replay or a second
input. There is one association coordinator, activated after HTTP readiness;
generic startup recovery does not compete for marked Cloud Handoffs.

Eight charged attempts survive crashes and lease expiry. Exhaustion blocks
automatic transport while retaining admission uncertainty. A matching committed
receipt can settle that uncertainty without spending another attempt. Attempt
failure codes are fixed, content-free values; shared task views omit lease tokens
and private binding metadata. No grant deadline, capability, Host policy or
Workspace access is renewed by retry. Public Cloud Group admission defaults off
and additionally requires the reviewed opt-in path below.

## Formal Cloud Group admission boundary

Cloud Handoffs require the separate explicit default-off admission flag and all
existing Group/Handoff/Cloud Runtime prerequisites. Creating a new grant and
provisioning its new Session both check admission. Live Owner/Workspace/Host/
Profile/Provider authorization remains mandatory and is rechecked by signed DO
policy calls. Group membership, moderator status or another administrator never
authorize spending the Owner's model/tool budget.

New Cloud bindings replace global tool defaults with the exact reviewed list:
empty, read-only `inspect_text`, or separately enabled approved artifacts.
Native file reads are rejected for Cloud, and Cloud inspection is rejected for
Native grants. No Personal Memory, MCP, Shell or local device capability is
inherited. The original expiry and model quota are retained across admission
rollback, process death and runtime recovery. Turning off admission is not an
implicit ownership switch or approval; restrictive controls remain available.

## Controlled Goal Team authority

An explicit Group owner binds a new Goal to one existing Group, active Chief and
one or two reviewed scoped Bot memberships. The immutable Team/step origins
survive Group removal. Every Bot model/tool call needs its existing Handoff grant
plus the original occurrence's current Goal/lease/source authority. There is no
membership-to-tool escalation and no execution on the coordinator Session.
Pause/cancel fences later steps and effects; an expired claim cannot be reused
to dispatch new work. Exact native result and approved artifact receipts, not
model statements, authorize Goal evaluation. Shared results remain subject to
the original Group grants; owner Goal APIs are not granted to Group observers.

## Explicit Cloud Team device requests

With the separate default-off Cloud device flag, a reviewed Goal-owned Cloud
Handoff may request one declared local file. The Cloud grant is an immutable
original-request grant, not a generic Workspace capability: it binds Goal/Run,
Handoff/Session/native task, owner/Workspace, node/resource, operation hash and
deadline. Ordinary Cloud Sessions cannot acquire this tool. Generic device
grants cannot satisfy it, and Cloud grants are excluded from generic local
lookup/listing. Owner confirmation uses the existing device grant endpoint;
proof RPCs read committed native memos without opening another Harness.

Dispatch/result acceptance checks current authority before and after remote
proof. Exact pending checkpoints retain the original command, while revoke,
wrong scope, terminal native tasks and cancellation deny further reads. Device
and Cloud result receipts are immutable; duplicate events cannot reset retry
budgets. User-facing request/progress metadata contains no file body; only the
authorized Tool result/native storage and existing private node cache contain
read text. Hash-only auditing does not erase previously delivered data. Goal
completion also checks confirmed device receipts independently of model text.

## Product projection and declared material

The Team overview is private/no-store and derives identity from the existing
Cookie middleware. It separately checks current Workspace access and canonical
Host revocation, then reuses the original runtime/Group approval authorization.
Shared Group access never grants private Goal/device/approval access. The page
clears failed or revoked snapshots and fences late old-account responses. Attention
is discovery; existing revision/request/grant checks still authorize each action.

A v85 `device_resources` declaration is immutable Goal intent, never a device
grant. Admission verifies paired owner/device/manifest and a reviewed selected
Cloud read capability. Tool requests are confined to the declared resource;
completion requires its actual committed read receipt even when report text
matches all keywords. Manual completion also cannot skip it. Read-only declaration
metadata enters the existing frozen step context, not a new authority token.
