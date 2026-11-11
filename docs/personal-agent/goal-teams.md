# Controlled Goal Teams

This is the first convergence slice for #34/#35, based on main `b9e933a` after
#46. It reuses Goals, the existing Scheduler, Group timeline, runtime grants,
Handoffs, product Runtime Router and artifact approvals. It adds no Planner,
executor, business timer, message bus or approval system.

## Admission and ownership

`MINICLAW_GOAL_TEAMS=true` explicitly permits new Team associations alongside
the existing Personal Goals, Groups and Handoffs flags. It defaults off. A new
Goal may include `team: { group_id, bot_member_ids }` through `POST /api/goals`
with its original `Idempotency-Key`. Select one or two distinct existing Bot
membership IDs in reviewed preference order. Choose an existing supported Goal
runtime as usual. The Group owner must also own the Goal/Host workspace; an
active default Chief must be in that Group. Every selected Bot must have a
current explicit scoped runtime grant. Membership does not grant tools.

Team definitions allow at most 100 occurrences and 8,000 serialized characters
of objective/criteria/next action; a complete step envelope must fit 15,000
characters before association. Oversize contexts fail closed, without truncating
the objective or creating a partial Handoff. Previous result excerpts are marked
as untrusted data and bounded to 2,000 characters each. Legacy Goal limits and
creation digests are unchanged. Team retargeting/adoption through PATCH is
rejected. Failed admission rolls back Goal/Session/Task creation together.

The existing managed Goal Session is its control/ownership anchor, not another
model executor. It never opens a Harness or receives a native input for Team
work; direct execution there is rejected. Each selected Bot gets its own normal
Handoff Session, runtime identity, exact reviewed tools, model quota and original
grant deadline. Native and Cloud Handoffs retain their existing execution paths.

## Bounded Chief coordination

One existing Scheduler occurrence is charged once and atomically selects one
available Bot, freezes its Goal snapshot, Group/Chief/member/grant/deadline/tools,
allocates one Handoff and appends the existing timeline receipt plus a Chief
coordination event. Selection rotates through the reviewed order, skipping a Bot
with an active Handoff. Parallelism is **one**. This is deterministic product
coordination; no inference-based planner or autonomous Bot-to-Bot fan-out is
claimed. Model output containing `@Bot` cannot dispatch another message.

Immutable `personal_goal_teams` and `personal_goal_team_steps` bind the Goal,
original Scheduler occurrence and Handoff. A retry returns that same selection,
contract and Handoff. A new occurrence receives a new identity. Group/member
identities are retained if the Group disappears, so a missing source cannot turn
managed work into an ordinary unrestricted Session.

Every model/tool authorization additionally requires the original Team step,
live Scheduler lease and executable Goal status, current Group/Chief/Bot scopes
and the original Handoff runtime grant. Pause/cancel stop the existing Handoff
owner; late lease callbacks cannot stop a newer claim. Rapid pause/resume uses
the existing retry state rather than failing or resubmitting the Goal. Revocation
prevents further execution; it does not authorize moving work to another device,
workspace or runtime.

## Evidence and delivery

The existing Handoff projector verifies its native producing Task/answer/input
and appends one result. The coordinator reads that immutable result and exact
completed artifact receipts. It verifies real file digests again and evaluates
the original completion criteria. Earlier verified evidence remains available
to subsequent steps; previous native-verified result text enters the next frozen
Goal context. A model's completion statement cannot finish a Goal.

The existing Goal evaluator chooses completed, waiting for human confirmation,
failed or another bounded occurrence. Artifact literals must all match verified
files for automatic completion. Human criteria still require review. The
existing isolated-run result/delivery outbox remains responsible for delivery;
the coordinator introduces no second notification schedule.

Evaluation also appends a receipt-bound Chief status event to the same Group
transaction, exactly once per occurrence, and invalidates snapshots only after
commit. The final Chief message states the verified completion/evidence count;
it is deterministic product output, not another model summary or executor.
Step views derive structured status/summary/evidence references and a nonbinding
next-action suggestion from these persisted server outcomes. They do not accept
model-authored state transitions.

`GET /api/goals/:id` returns the Team association and frozen steps. Goal detail
links to the actual Group/Handoff approvals; owner Handoff cards link back to
the same Goal. Shared Group members do not receive the owner's Goal API access.
The Bot-first homepage now creates Team Goals through the same authenticated API,
using current owned Groups and reviewed Bot choices. The mention composer and
unified attention snapshot reuse the existing messages/controls/grants. Cloud
Device reads require the separate default-off bridge described in
[device-nodes.md](device-nodes.md). The Chief remains a bounded product coordinator,
not an inference-based planner.

## Reproduce the local acceptance

Use the locked dependencies and existing workflow:

```sh
npm run build:all
npm --prefix apps/cloud-agent run build
npx vitest run tests/goal-team.test.ts tests/personal-goal-store.test.ts
npx vitest run --config vitest.cloud-authority.config.ts tests/goal-team.integration.ts
npm --prefix web run test:e2e -- tests/e2e/goal-team.spec.ts
```

The HTTP scenario configures Researcher and Developer through real product APIs,
creates one Goal, approves their two different artifact Tool Tasks, SIGKILLs Node
and reconstructs workerd during the second approval, then waits for the natural
Scheduler lease takeover. It checks original Submission/Task/approval identities,
two charges, cumulative artifact evidence and one result per Handoff. A separate
case pauses/resumes/cancels the original Handoff and rejects late model text.
The browser case uses independent desktop/touch logins, offline reconciliation,
desktop detach, phone approval and the same Goal/result after reopening.

These use actual compiled Node, HTTP/auth, Scheduler, SQLite, workerd, browser,
OS termination and files. Provider responses and HTTPS hostname routing are
fixtures. Chromium touch/hash emulation is not physical Safari. No actual vendor,
Cloudflare account/deployment, external IM or physical-device acceptance is
established. See [evaluation](evaluation.md), [migration](migration.md) and
[real Cloudflare acceptance](cloudflare-real-acceptance.md).

## Declared local evidence (schema v85)

A new Team Goal can declare at most one `device_resources` entry: a currently
paired active owner device and one immutable manifest path. At least one chosen
Bot must already have a reviewed Cloud device capability. The declaration is
stored in the existing immutable Goal/Team association and frozen into each step;
it is **intent, not permission**. The actual tool still waits for a separate exact
request grant and native checkpoint proof. A declared resource also constrains
which file the Cloud tool may request.

The server cannot complete this Goal from report keywords alone. If research
artifacts match all literals before the local file is read, the original
Scheduler creates the next distinct bounded Handoff while budget remains. An
exhausted budget or missing evidence waits for input. Successful device receipts
must match the declared node/path and original Goal lineage. Manual completion
also rejects a missing required read with `GOAL_DEVICE_EVIDENCE_REQUIRED`; pause
and cancel remain available. Existing Teams receive no declaration, and their
creation digests/step contracts retain their original identity.

See [product convergence](product-convergence.md) for the actual UI/demo and
remaining external release gates.
