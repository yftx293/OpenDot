# Migration and rollback

## Quick creation: v85 → v86

Startup retains the existing private, integrity-checked SQLite backup before
upgrading. Version 86 adds nullable `agent_profiles.avatar_shape` and an
owner-scoped `quick_bot_requests` table. Existing Profile/workspace/Session,
Team, approval and runtime identities remain unchanged. Profile, first assistant
workspace and creation receipt commit in one transaction; failed creation rolls
back all three, and a repeated request returns the original owned conversation.
Legacy avatars keep their existing fallback.

A v85 binary refuses v86. Preserve the current database and Session stores before
rollback; do not lower the schema marker or delete creation receipts to retry.
Restoring a pre-upgrade database is a separate operator action that requires
reconciling subsequent writes. No Worker namespace migration is introduced.

## Current rollout

The independent `apps/cloud-agent` M0/M1 PoC has its own lockfile and SQLite DO
migration `v1`; it changes no Node schema or existing Session runtime. Admission
defaults off and no Cloudflare deployment has been performed. Disabling PoC
admission affects new identities only; retain its DO namespace and native data
if one is deployed later. See [cloudflare-deployment.md](cloudflare-deployment.md)
for explicit staging authorization, secret setup and rollback boundaries.

PR #2 remains open and unmerged. `agent/pocket-integration` combines its complete fix branch with the existing Goal/Durable integration, under Draft PR #3; main is unchanged. The stacked product-session branch adds opt-in formal Host Session routing described below. Existing JSONL files and runtime identities are preserved.

The Durable dependency set is pinned to 1.3.0. Pi Durable is experimental and requires Node `>=22.19.0`; the repository CI and container use Node 24. The package engine and README now declare the same `>=22.19.0` minimum, including startup imports of built-in SQLite; the flag does not make Node 20 compatible. Use Node 24 for the validated deployment.

## Formal Cloud Session pilot

Cloud placement was introduced in v78; the current product schema is v86. Version 80 added the opt-in [Bot Group domain](bot-groups.md); version 81 adds [native Handoff](bot-handoffs.md) grants/origins and immutable answer-producing Task provenance. Existing native Runtime bindings and version-79 Cloud grants remain unchanged.
New Node Sessions may explicitly select Cloud
only with `MINICLAW_CLOUD_RUNTIME=true` and trusted gateway/provider settings.
The default selector and historical JSONL/Node mappings are unchanged. Cloud DO
startup adds `mc_results` and `mc_controls` with immutable payload guards; no
native checkpoint is rewritten or imported. The Durable Object class/namespace,
Wrangler `v1` migration and pinned SDK versions remain unchanged.

The projection-wake repair adds `mc_results.next_attempt_at` through an
idempotent metadata-column upgrade. Existing receipt payloads/states, original
input IDs and native Root history are retained; completed legacy receipts start
with retry time zero and are not delivered again. Pending legacy receipts keep
their IDs and use idempotent product reconciliation. Keep the repaired outbox
code to preserve per-result backoff; reverting code must never rewrite/drop
native state or resend prompts. The Wrangler namespace migration remains `v1`.

Disable both product and Worker new admission to roll back a pilot. Keep the
Cloud-aware Node execution fence/private authority available for existing Cloud
Sessions and retain their namespace, placement, native receipts and outbox.
Reverting to a pre-fence Node binary while placements exist is not a safe rollback;
those versions do not know the Cloud execution owner. No old Session should be
retagged or receive a new prompt as a migration. See
[session-ownership.md](session-ownership.md) for association/failure boundaries.

## Safe activation sequence

1. Merge and deploy the separately validated Pocket continuity work.
2. Preserve any pilot database at `data/db/personal-agent.sqlite` and the formal per-Session databases at `data/db/durable-sessions/<UUID>.sqlite`; backup tooling snapshots both when present. Keep storage private.
3. Deploy schema v71 and its immutable owner/runtime mapping. Existing JSONL sessions remain assigned to Pi Coding Agent.
4. The formal path exposes a guarded replay-safe workspace read tool and the controlled private-artifact approval flow. General external writes remain unsupported.
5. Configure an existing API-key model provider and enable `MINICLAW_DURABLE_RUNTIME=true` for a small set of new Host Sessions. The flag defaults off; Docker and existing Sessions retain their runtime.
6. Run process-restart, provider interruption, side-effect, duplicate submission, approval, ACL, and multi-device tests before considering broader activation.

## Cloud Goal grants schema v79

Startup first creates the normal private, integrity-checked pre-migration
backup. The additive `product_cloud_executions` and
`product_cloud_execution_attempts` tables freeze each existing Scheduler run's
grant and associate model request receipts with it. Identity triggers prevent
rewriting a grant/attempt; a monotonic counter cannot be reset. Foreign keys keep
each attempt on the same Session and occurrence. Existing Cloud JSON, DO IDs,
Root IDs, model counters, native databases and JSONL references are unchanged.
No existing Goal is assigned to Cloud and no grant is fabricated at startup.

During the v78 upgrade, the original Cloud admission trigger is replaced only
after backup. Its new exception permits an explicitly selected Cloud runtime
inside initial Goal provisioning, while the owned Goal still has no Session.
Attached Node Goals, admitted Sessions and ordinary Cloud Sessions cannot be
adopted. A second startup on v79 retains the current trigger and creates no
additional migration backup. The Worker namespace/migration remains `v1`;
this backend increment adds no DO checkpoint migration or Cloud Goal UI flag.

Before deploying this binary, preserve the Node database, private artifacts and
all native stores. A v78 binary refuses a v79 database. Reverting requires
stopped executors and an explicitly reconciled restore, or a compatible forward
fix; never reset the schema marker/drop grant rows to force a downgrade. A Node
backup is not an atomic backup of deployed DO storage. No production database
was migrated and no Cloud resources were deployed during this work.

## Rollback

Before user sessions are routed to Durable, rollback is to leave `MINICLAW_DURABLE_RUNTIME` unset/false and continue using the Pi Coding Agent runner. Do not delete Durable state. After routing begins, rollback must stop new Durable admissions and drain or explicitly fence active Durable work; switching a live session to JSONL would lose ownership/checkpoint semantics. Preserve the Durable database for later recovery/export. No automated live-session rollback or conversion is implemented yet.

Legacy JSONL is not converted by this migration. A Durable fork or import needs an explicit reviewed migration with provenance; replaying an old prompt is not checkpoint restoration.

The adapter now writes `miniclaw.input-request` version-1 digest documents in the same Durable database. No legacy JSONL data is rewritten. Inputs admitted by an older pilot without a digest binding cannot be resubmitted under that ID: inspect/recover their existing submission explicitly. Never assign a fresh request ID automatically to bypass a conflict. After deploying the ledger, preserve the database and adapter together; reverting to an older adapter removes its payload-conflict enforcement even though the documents remain stored.

The ownership guard adds a private `<database>.owner.sqlite` coordinator with no task data. Deploy it to every executor before enabling any Durable production session. Stop all executors before moving/restoring the runtime database, changing its path, or rolling back to a binary without the guard. Do not remove the coordinator to steal ownership from a live process; stopped/crashed processes release OS locks automatically. Backups restore task state without this disposable coordinator, but restoration is permitted only while all executors are stopped.

## Goal Engine schema v70

The stacked Goal Engine branch makes an additive v69→v70 migration in the existing MiniClaw database. Startup first creates and verifies the existing automatic private pre-migration backup. Tests verify that this snapshot remains v69, has no Goal tables, and preserves original tasks/session IDs. Existing tasks are not linked automatically. The feature defaults off; `MINICLAW_PERSONAL_GOALS=true` enables API/UI creation. Persisted Goal execution fences remain enforced when the UI flag is turned off, so disabling the UI cannot bypass budgets or revive cancelled work.

Before a binary rollback, stop/fence Goal-linked executions and preserve the current database. An older schema-v69 binary intentionally refuses a v70 database. Restoring the pre-v70 backup is a separate operator action and loses later writes unless reconciled; do not silently reset the version marker or drop tables. No production database was migrated during implementation tests.

## Product Session schema v71

The product-session branch adds immutable Session/runtime/provider bindings and payload-bound input receipts in the existing database, with automatic private pre-migration backup. Existing owned conversation records are assigned to Coding Agent regardless of the feature flag; JSONL IDs are retained. Unowned/invalid legacy metadata does not gain an executable Durable mapping. No production data was migrated during implementation.

New authorized Host Sessions may select Durable at creation when the flag is true. Their storage is `data/db/durable-sessions/<UUID>.sqlite`; root creation/binding can be retried after a crash without admission or prompt replay. Bound storage must already exist on recovery. Provider/workspace/profile identity changes, missing checkpoints and mismatched product/Durable receipts block that Session rather than silently selecting another runtime. Current blocked-state resolution requires operator reconciliation or an independent new Session; no automatic unlock/conversion is implemented.

Turning the flag off does not stop or convert existing Durable work. Before binary rollback or restore, stop all service executors, preserve the product DB and every Durable Session DB, and retain coordinator identity while a process may still own it. A v70 binary refuses a v71 DB. Restoring the pre-v71 backup loses later writes unless separately reconciled and requires operator approval; never change schema markers or discard checkpoints to force compatibility. Individual online snapshots are validated but may represent different moments; receipt mismatch isolation is deliberate. A stopped, coordinated backup is recommended before rollout/rollback.

## Artifact approvals schema v72

The next additive migration records exact tool intents and payload-bound approval decision receipts. A private pre-v72 backup is created before schema changes; tests preserve existing runtime identities in that backup. Preserve `data/db/private-artifacts` along with all databases. Approval wait time counts toward the existing duration limit; expiry blocks execution rather than granting approval or silently restarting a task. Mismatched effects require manual reconciliation and have no automatic override. A v71 binary refuses v72; any rollback requires stopped executors and an explicit, reconciled restore. No production migration or restore was performed.

## Goal execution schema v73

An additive Goal context table freezes each existing Scheduler occurrence and its Durable Session/owner binding. An immutable `goal_id` on the product runtime records managed execution ownership at Session creation. Losing a Goal/task link cannot turn that Session into an ordinary conversation. Existing Goal/task links default to unmanaged; neither startup nor a manual run automatically changes their execution engine. New managed links are marked only inside atomic Goal/Task/Session provisioning. New approval columns bind Goal/run/task, expiration and resolution; old v72 intents retain their original bindings and runtime-duration restrictions.

The Scheduler can reclaim started work only with the persisted Durable context proof. Coding/script started runs retain their original fail-without-replay behavior. Harness activation also requires this process to hold the matching current Scheduler claim. Ship schema and dispatch/recovery logic together; do not deploy the reclaim rule without the Durable dispatcher. Pause retains the original run; cancel revokes unfinished consent and fences late results.

Tests strip a disposable database to v72, verify its private pre-migration backup and unchanged Goal/Session IDs, then check that old links are not auto-started. No production database was migrated. A v72 binary refuses v73. Before rollback, stop executors and preserve all product/runtime/artifact storage; an explicit restore must reconcile later writes. Rollout flags affect new admissions and UI availability, not the identities of persisted tasks.

## Session control schema v74

The additive upgrade creates immutable `product_queue_controls` intents and `product_input_results` answer-message bindings. Existing runtime/conversation/input identities and JSONL data are retained. Control receipts are retained for deduplication; individual reorder commands accept at most 500 input IDs. No lifetime receipt quota prevents a user from stopping or cancelling work. v73 migration tests verify a private, integrity-checked pre-upgrade backup and original pending input identity.

A control is first persisted in MiniClaw, then committed with its receipt and Inbox mutation in Harness. Recovery validates known control IDs/digests before activation and reconciles interrupted product acknowledgements. Current-task abort commits an intent bound to one task ID, then persists the native abort mark; recovery can only mark that original task and rejects a product acknowledgement ahead of its checkpoint. Multiple answered inputs can reference one actual product message.

A v73 binary refuses v74. Disabling the creation flag does not change persisted owners or undo controls. For rollback to PR #8, stop all executors, preserve the current MiniClaw database, every Durable Session store and private artifacts, and restore a coordinated pre-upgrade snapshot of **all** stores after reviewing later effects. Do not restore only the automatic pre-migration MiniClaw backup against later edited Durable queues. Resume is blocked on unmatched receipts; resolve uncertain writes explicitly. No production migration or restore was performed.

## GitHub event schema v75

This additive migration creates subscriptions and immutable event admission
receipts after the existing Goal/runtime tables. The normal private, verified
pre-migration backup is required before DDL. v74 migration tests strip the new
tables, preserve the original Goal/Session/run identities, and inspect the v74
backup's integrity and mode. Older migration fixtures also strip these tables,
so they continue to represent their claimed historical schemas.

`MINICLAW_GITHUB_GOALS` defaults off. Its deployment-local signing secret is
separate from outbound Provider credentials. No public endpoint is registered
or production data migrated by tests. Disabling intake does not cancel already
committed Goals; pause/cancel through the authorized APIs before stopping a
deployment. Cancel retains receipts and completed evidence, revokes unfinished
consent and suppresses pending source delivery.

A v74 binary refuses v75. To roll back the binary, stop every executor, preserve
the product DB, all Durable stores and private artifacts, then reconcile later
effects before an explicitly authorized coordinated restore. Restoring only the
pre-migration product DB alongside later Durable checkpoints is unsafe. Do not
change the version marker or delete event receipts to bypass downgrade/replay
protection. No production rollback/restore was executed.

## Personal Memory schema v76

The additive migration adds personal entry lineage, exact-revision workspace
grants and digest-only read receipts. Content remains in existing Home Memory
items with native versions/provenance/tombstones. Existing facts are not promoted
or shared automatically. The v75 migration test inspects the private verified
backup and preserves original Home content and revision history.

`MINICLAW_PERSONAL_MEMORY` defaults off. Explicit saving permits Home use;
additional owned Web workspaces require current-revision grants. Existing Home
editor changes invalidate those grants without changing the editor API. Unknown
mutation outcomes retain their original receipt and require explicit retry.
No JSONL or existing Harness checkpoint is converted; create an independent new
Durable Session to use the newly registered read capability.

Before rollback, stop executors and preserve the product DB, Durable stores and
artifacts. An older binary refuses v76. Any approved coordinated restore must
reconcile later model/tool reads and facts already committed into conversation
history; revocation/forget does not retroactively erase transcripts. Restoring
only an older product DB against newer checkpoints is unsafe. No production
migration, data erasure or rollback was performed.

## Reproduce formal-page live acceptance

Bind the authorized model key as the environment secret `MINICLAW_ZEN_API_KEY`; keep it out of shell command text and repository files. Set the explicitly chosen endpoint/model and run:

```sh
MINICLAW_ZEN_BASE_URL=https://opencode.ai/zen/go/v1 \
MINICLAW_ZEN_MODEL=cat-jam-free \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
npm run test:personal-agent-live
```

The Chromium path is optional when Playwright's browser is installed. The command builds fresh product artifacts, configures the real provider through the existing encrypted API in a private disposable instance, and drives production pages. It waits for the real Scheduler lease after SIGKILL, so allow several minutes. Missing binding exits **2 / Pending**, failed assertions exit **1**, and only a fully verified scenario exits **0 / passed**. It does not replace the selected model; absent public metadata alone is not treated as an authenticated generation failure. Review an explicitly authorized alternate model before changing that variable. This scenario does not verify physical devices, external IM delivery, general sensitive writes or memory reuse across a new Session. No production state is used.

## Device Nodes schema v77

Additive tables hold purpose-bound pair tickets, device identity, expiring
workspace/path grants, immutable mutation receipts, Tool dispatch/results and
digest-only audit. Existing user/Workspace/Session ownership stays authoritative.
The existing startup migration verifies a private pre-upgrade SQLite backup before
changing the schema. The v76 fixture removes all v77 tables before upgrade and
checks the backup has Personal Memory tables but no device registry.

Default `MINICLAW_DEVICE_NODES` is off. Enable only on an already authorized Host
Durable/Goals rollout. Turning it off stops new admissions, not checkpoint recovery
or revocation controls. Previously saved roots retain their original tools; create
a new independent Session/Goal to use node tools. No JSONL conversion is performed.
First pause/cancel affected Goals, revoke grants/nodes and stop local node processes
for operational rollback. Older binaries refuse v77; binary/data rollback requires
an explicitly approved coordinated pre-v77 product/Harness backup restore. Do not
simply lower the version marker or copy a live WAL database. Node-private SQLite
contains its bearer and original file read receipts: retain securely for retries,
or remove deliberately only after revocation. No production migration or restore
was executed for this milestone.

## Cloud placement / model authority schema v78

The additive migration creates immutable Cloud placement and model-attempt
receipt tables. Historical runtime kind, Node checkpoint paths, Goal ownership
and JSONL are preserved; an absent Cloud placement continues to mean the original
Node execution owner. The internal selection is committed in the existing
Session creation transaction. Public Cloud admission is not exposed yet.

A private verified pre-v78 backup is created before migration. The v77 test
preserves an original product Session and native Memory item, verifies backup
integrity/mode and confirms no automatic Cloud adoption. Earlier migration
fixtures remove these two new tables before representing their historical schema.

A v77 binary refuses a v78 database. Before any rollback, stop/fence every executor,
preserve the product DB, Node Durable stores, artifacts and any DO namespace,
and reconcile later effects before an explicitly authorized coordinated restore.
A Node backup is not a DO snapshot. Never delete placements/receipts or alter the
schema marker to force an executor switch. No production migration, deployment or
restore occurred in this increment.

Cloud association progresses from `provisioning` with no native Root to `ready`
with Root 1. The v78 trigger prevents binding another conversation. Object-policy
bootstrap may bind the expected object; input/model authorization stays closed
until the product Root receipt commits. A lost response can be retried under the
original immutable binding; no other runtime takes ownership of the gap.

## Cloud Memory capability increment

No database schema bump or existing binding rewrite is required. New opt-in
bindings carry an optional `tool_capabilities` field; absent fields preserve the
original serialized binding/digest and tool configuration. Disable
`MINICLAW_CLOUD_MEMORY` to stop further Cloud recalls and keep the capability-aware
Worker/Node authority while retaining those Sessions. Older strict Worker
versions reject the added field: a code downgrade does not convert those native
checkpoints or safely remove consent metadata. Keep the namespace, product DB,
read audit and native receipts; never edit bindings or adopt them into Node.

## Cloud approval increment

The Node schema remains v78. The optional Cloud execution scope only participates
in new Cloud approval hashes; existing Node approval digests/behavior retain their
original bytes. New Cloud bindings can declare the artifact capability; old
bindings do not change. The DO constructor creates additive `mc_approval_waits`
records without rewriting Pi checkpoints, binding identity or migration tags.

Disable `MINICLAW_CLOUD_APPROVALS` to fence Cloud tool calls, and retain the
capability-aware Worker/Node code, product approvals, private artifacts, native
memos, control records and wait table. An older strict Worker cannot interpret
these new capabilities; deleting fields is not a rollback. Quiesce owners and
coordinate both stores/effect files before an explicitly authorized restore.
A Node-only backup cannot prove a corresponding DO checkpoint. Ahead effects,
missing receipts or uncertain files require reconciliation; there is no public
automatic unblock API. No production resources/data were migrated here.

## Internal Cloud Goal execution handoff

The Worker adds `mc_goal_executions` and `mc_goal_owner` metadata tables through
idempotent initialization. No Pi checkpoint, old binding JSON, Root identity,
Wrangler class/namespace or `v1` namespace migration changes. Existing ordinary
Cloud Sessions retain their lifetime budget and plain provisioning protocol.
Only a new product-managed Goal binding uses the grant envelope. The Node schema
stays v79; no existing Goal or conversation is adopted.

At the handoff milestone, public creation still selected Node Durable. The later
explicit admission rollout is described below. Retain the grant-aware Worker and Node authority for
any internally provisioned managed Sessions and their immutable ledgers. Do not
revert such Sessions to an older Worker that cannot verify grant references,
rewrite their binding to an ordinary Session, delete native tasks to force a
handoff, or repost their original prompt. Stop business admission and retain
history/data while repairing the compatible owner. Public activation awaits
lossless pause/stop, full Scheduler/browser and context-size acceptance.

## Bot Handoff v80 → v81

Startup uses the existing verified mode-0600 SQLite pre-migration backup before
creating the three Bot Handoff tables and `product_input_task_sources`. Existing
Groups/receipts, JSONL and native runtime ownership remain unchanged; old inputs
are not converted to checkpoints. Committed Task-source rows can be backfilled
only from the existing official Storage receipt, never inferred from text.

Set `MINICLAW_BOT_HANDOFFS=false` to stop new message/delegation/grant admission.
Retain v81 code and both product/native stores for existing owners, historical
receipts and restrictive pause/cancel/revocation. Disabling admission does not
move tasks to another executor. A complete stop requires pausing/cancelling
owned tasks before stopping the service. Do not delete a Group to unblock a
Session: immutable origin markers intentionally leave an orphan fail-closed.

A v80 binary rejects v81. A code/data downgrade requires quiescing writers and
explicitly restoring a consistent pre-upgrade product DB, per-Session native
SQLite files and private artifacts, with post-backup data-loss review. Never
lower `schema_version`, drop tables in a live deployment, or restore only one
side of an effect/checkpoint. Legacy test-fixture DDL only reconstructs private
old schemas; it is not a production rollback command. No production migration
or restore was performed for this increment.

## Cloud execution recovery metadata

Managed Cloud initialization adds `mc_execution_recovery` with the original grant,
probe count, next wake and state. No Node schema version, Pi native table, Root,
input/receipt identity or Wrangler v1 namespace migration changes. Existing
ordinary Sessions keep their model behavior. Existing Goals retain their runtime.

Retain grant/recovery-aware Worker and Node stop authority for internally created
managed Sessions. Disabling new admission is not a reason to drop their recovery
rows or replace prompts. Preserve pending native tasks and immutable approval/
effect receipts during rollback; an older Worker without these semantics must
not take execution ownership. A suspended/exhausted original grant can only
resume under live policy and its remaining fixed quota/deadline. Real deployed
migration, backup/restore and physical-device acceptance remain Pending.

## Explicit Cloud Goal admission

`MINICLAW_CLOUD_GOALS=true` enables only explicitly selected new Cloud Goals,
alongside the existing Cloud runtime, Personal Goals and artifact approval flags.
It defaults off. Missing `runtime` retains the legacy Goal request hash and Node
selection. Creation atomically persists the Goal, immutable runtime mapping and
paused Scheduler template before any background execution starts. Existing
Sessions cannot be adopted or patched to another runtime. Cloud core-context and
100-run limits apply only to Cloud; existing Node limits stay unchanged.

There is no schema bump beyond v79, new Wrangler migration or rewrite of stored
Pi checkpoints. Roll back admission by disabling `MINICLAW_CLOUD_GOALS`; retain
the grant/recovery-aware Node authority and Worker for already-created Goals.
Idempotent retries still reconcile committed creation receipts after that flag
is disabled. The local mobile acceptance verifies that an already-started Goal
survives a Node/workerd restart with new admission disabled. Do not downgrade its
executor, delete DO storage or repost an original prompt. A code rollback alone
is not a cross-store restore. Production restore/backup remains unverified.

## Cloud Handoff lifecycle storage

The optional Cloud Handoff control transport adds `mc_handoff_lifecycle` inside
its existing DO SQLite database; Node schema remains 81. It records only the
latest control revision, restrictive/resume intent, bounded attempts and wake
backoff. No legacy JSONL, Node Durable checkpoint, Goal claim or historical
Cloud Session is converted. Stop state and control fence commit atomically
within that DO; there is still no Node/DO cross-store transaction. Cloud Group
admission stays disabled pending cross-store association repair and formal
execution verification. Rollback may disable/revert this gated transport while
retaining DO data; do not delete binding, checkpoint, receipt or control tables
or reinterpret these Sessions as Node-owned. No production migration was run.

## Cloud Handoff recovery subjects

Handoff transport recovery reuses `mc_execution_recovery`; there is no SQL table
rewrite or Node schema bump. Existing Goal grant JSON and references are retained.
New Handoff rows use the actual runtime ID in the historical local `run_id`
column, and an explicitly typed Handoff subject. Node snapshot decoding must be
upgraded before a Worker emits the new typed summaries. An older Node decoder
rejects these rows rather than assigning them another execution owner.

Before downgrading a Worker that understands Handoff recovery, use the current
control transport to suspend affected owners and disable admission. Retain a
protocol-compatible Worker/Node pair to resume them: an old binary must not
reinterpret a Handoff runtime key as a business Goal run or move its checkpoint
to Node. Preserve bindings, native tasks, receipts and recovery rows. This is an
upgrade/operational rollback boundary, not a reverse data migration. Public Cloud
Group admission remains closed and no production Handoff data was migrated.

## Cloud Handoff observation outbox

The progress follow-up adds one coalescing `mc_handoff_progress` row inside an
existing DO SQLite database, with immutable payload per observation version,
retained retry/backoff and eight-attempt bound. Node stores its observation
high-water receipt and exact control-dispatch fence in the existing Handoff
progress JSON; Node schema remains 81. The original empty initial progress string
is supported. Terminal-row SQL guards remain unchanged: terminal observations
are ignored/acknowledged without updating the row. Control dispatch updates only
its JSON key with a revision guard, preserving a concurrent newer receipt.

Deploy a compatible Node progress receiver before enabling the new Worker
projection. Disable admission and retain existing native ownership/checkpoints
for rollback; an older Node without the receiver cannot consume new observations.
Retain the outbox and metadata rather than resetting versions or adopting these
Sessions in Node. This is additive gated code, not a production data migration.

## Cloud Handoff original association outbox (v81 → v82)

Node schema 82 adds `bot_handoff_associations` and immutable identity/monotonic
budget guards. The existing fail-closed migration backup runs before changes;
the private migration test checks a mode-0600, integrity-checked v81 backup.
Active marked Cloud Handoffs are backfilled from their existing Session/request/
payload/grant binding. No input, DO, checkpoint, model call or ownership selection
is created by migration. Reopening the database preserves attempts and leases.
Legacy JSONL, Node Durable Sessions and ordinary Cloud recovery are unaffected.

Upgrade the Node association coordinator together with its schema. Keep public
Cloud Group admission off until formal-path acceptance. For operational rollback,
suspend affected owners and retain a v82-compatible Node/Worker pair and data.
Older Node binaries refuse v82; do not edit `schema_version`, delete the outbox
or point Cloud Sessions at Node. Restoring a v81 backup is a separate quiesced
data-restoration operation, not a code rollback: it loses later Node receipts
and must reconcile them with retained Cloud ownership before accepting work.
Actual deployed backup/restore remains unverified; no production data changed.

## Formal Cloud Handoff admission

The public Group path requires explicit `MINICLAW_CLOUD_BOT_HANDOFFS=true` plus
existing Groups/Handoffs/Cloud Runtime flags and valid gateway/Provider setup.
It defaults off, does not unlock Cloud Goals and introduces no schema beyond
82, Worker change or native checkpoint conversion. Workspace scope, Provider
fingerprint, tool list, model quota and original expiry are frozen at new
association; old Sessions never switch execution owners.

Disable this new flag to stop new Cloud grants/provisioning. Existing Cloud
owners and original approval/result receipts remain reachable under current
policy, as the real Node SIGKILL/workerd/phone test checks with admission off.
Use existing pause/cancel/revoke controls before an incompatible rollback, keep
a v82-compatible Node/Worker pair and retain the association/progress/effect
receipts. Do not reset retry budgets, reissue prompts or restore an old Node
database independently of its Cloud ownership. No production rollout occurred.

## Controlled Goal Teams (v82 → v83)

Schema 83 adds immutable Goal–Group origins and original occurrence–Handoff
contracts. Pre-migration backup remains fail-closed; the private v82 upgrade
case checks mode 0600, SQLite integrity and unchanged legacy Goal content/hash.
No existing Goal, Group, runtime, prompt, approval or native checkpoint is adopted.

Disable `MINICLAW_GOAL_TEAMS` to stop new associations. Existing Team execution
remains governed by current Goal/Group/grant/lease authority, not the admission
flag. Pause/cancel affected Goals before an incompatible rollback and retain a
v83-compatible Node with all original Worker/Node data and receipts. Older Node
binaries refuse schema 83. Do not manually lower schema_version, delete Team
origins, repoint Sessions or restore a Node backup independently of Cloud state.

Status-only Goal PATCH now preserves omitted budget and next action: Zod 4
creation defaults are removed before making those fields optional. Creation and
explicit edits retain their prior meaning. This prevents future accidental
budget expansion; it does not infer or rewrite previously changed budgets.
No production data migration or deployment has occurred.

### Cloud Team device bridge: v83 → v84

Startup takes the existing private integrity-checked pre-migration SQLite backup,
then adds `cloud_device_requests`, retained grant origins and bounded wake
receipts. Existing Team data, generic device grants and legacy binding JSON/
digests are unchanged. No old Session acquires Cloud device capabilities.
Deploy the matching Node/Worker build before enabling `MINICLAW_CLOUD_DEVICES`;
keep `MINICLAW_DEVICE_NODES` and existing Team/Handoff flags explicit. Without
the new flag, reviewed capabilities cannot create new Cloud read requests.

For rollback, disable new admission, pause/cancel the affected Goals and retain
the v84 gateway/Worker pair and both stores until in-flight receipts are resolved.
An older Node binary refuses v84. Never lower `schema_version`, restore Node
SQLite independently of live DO state, delete grant origins or repoint a Cloud
Session to a local executor. A coordinated offline restore is an operator action
with both ledgers stopped, not an automatic rollback promise.

### Product convergence: v84 → v85

The normal private pre-migration backup precedes an additive
`personal_goal_teams.device_resources` column, defaulting to `[]`. Existing Team
bindings, Goal content digests, old contracts and execution owners do not change.
The v84 recovery fixture verifies its private backup/integrity and that the old
Team identity survives. The existing immutable Team trigger also fences the new
field. Newly declared local resources require one verified original read receipt;
this is a tightened completion criterion, not a capability grant.

Roll back new admission/UI separately from in-flight work. Retain v85 gateway and
matching Worker/ledgers until pending effects settle; the older binary rejects
v85. Do not drop the declaration, lower schema_version, independently restore one
ledger or silently replace the Session owner. A coordinated offline restore is a
separate authorized operator procedure.
