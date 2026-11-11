# Native Bot Handoff (Issue #33)

This optional slice uses the existing Product Runtime Router, Pi Durable 1.3.0
Harness, native SQLite Inbox/Tasks/checkpoints and authorization. It introduces
no second executor, queue, Scheduler, model Provider or socket protocol.
`MINICLAW_BOT_GROUPS=true`, `MINICLAW_BOT_HANDOFFS=true` and
`MINICLAW_DURABLE_RUNTIME=true` enable new Host-backed Group work. Default
admission remains off. The separate default-off Cloud path is documented in
[Cloud Bot teams](cloud-bot-teams.md); there is no fallback to Node for a Cloud request.

## Flow and controls

In `/bot-groups/:id`, configure an owned Bot Workspace scope, then explicitly
review model-request budget (1–12), grant duration (1–1440 minutes) and tools.
Default tools are empty. The first slice permits `read_workspace_file` and
`create_approved_artifact` only; it does not silently inherit Shell, Memory, MCP
or device authority. Model selection uses the existing authorized Profile
configuration; its immutable provider/configuration fingerprint is frozen.
Re-granting stops tasks bound to the replaced grant. A request already waiting
for authority needs explicit Start after a grant is reviewed.

Owner messages default to Chief, or only the explicitly selected/leading-@ Bots
(maximum two). Leading names must uniquely match current roster names; structured
selection supports names containing spaces. Quoted/mid-message mentions do not
route work. `dispatch:false` posts ordinary shared chat. Non-Owner messages
remain shared chat and cannot spend the Owner's credentials. This restriction
is explicit in the UI; membership is not an execution grant.

Message + request receipt + Handoff + new native Session association commit in
one product SQLite transaction. Model work begins afterward. One Handoff owns
one new native Session, frozen request/digests/grant, and immutable input, native
Submission, answer-producing Task and answer Entry identities. No historical
Session is adopted. A permanent Session-origin marker survives Group deletion.
Client reconnects and Group snapshots read product state only, never submit or
resume a Harness. Detach is not cancellation.

Owner can pause, resume, cancel and request exact-run Abort. Pause saves state
before closing the warm owner; Resume reconciles the original Submission.
Cancel fences future execution before owner shutdown and rejects pending
approvals. Unconfirmed effects produce `uncertain`, not a clean-cancel claim.
Abort persists the existing native queue-control intent with the exact run Task
and queue digest; the original native control receipt validates and settles it.
A rejected stale abort does not terminate a newer run. A confirmed abort then
cancels remaining Handoff work. The same request key cannot change its command.
Generic private queue edits/extra inputs cannot rewrite this source request;
additional work uses a new explicit Group message.

For a completed Chief result, Owner may confirm a server-side delegation to a
selected Bot. This is a user-approved command, not an autonomous planner Tool.
The child references Chief's actual native result and receives only the explicit
new instruction plus at most 4,000 characters of the same-Group result as untrusted user data.
The full result digest remains in provenance; JSON-expanded execution context
over the native 32,768-character bound is rejected before message admission.
Limits: depth 2, fan-out 2 per parent, 100 Handoffs per Group and the frozen
per-task model budget. Native Bot output never triggers another @ dispatch.
This slice does not associate a new Goal or decide long-Goal completion;
`completed` means that native submission returned a committed answer.

## Approval, result and recovery

The task panel shows native progress/tools, waiting/paused/uncertain states,
model attempts, unpriced cost and provenance. Sensitive controlled-artifact
content is fetched only for Owner under current Native Workspace/Host/model
authority; shared members see task status. Approve/Deny binds the original
Tool Task, Handoff/grant/deadline and exact parameter digest. Decision + Group
receipt commit together before wake; retries preserve the original decision.
The existing exclusive mode-0600 artifact and content hash reconcile an effect
that completed before its Tool checkpoint. This is not arbitrary email/delete
or remote-write recovery.

Only an actual committed Product input, immutable official Task-source receipt,
answer Entry and matching private assistant message/hash can produce a Group Bot
result. Progress text cannot become a final answer. The answer-producing Task is
distinct from the live root run Task used for Abort. Final Group text is bounded
to 16,000 characters with full result hash/truncation provenance. A Group result
transaction failure retains a SQL delivery outbox: at most eight retries with
250 ms–5 s exponential backoff, surviving restart. These retries read only the
completed native result, never resubmit input or request another generation.
Integrity conflicts or exhausted delivery budget enter `uncertain`. Cancellation
and live revocation fence late projection; original receipts remain historical.

On Node restart the existing runtime verifies committed inputs and native
requests before activation; Handoff reconciliation attaches to the same IDs.
Interrupted network requests can call the vendor again and consume the original
attempt budget; this is not exactly-once model billing. Missing trusted storage
never becomes a new prompt. Group ACL/read fences and snapshot generations from
Issue #32 remain active. No native owner is opened merely to serve a Group GET.

## Reproduce and evidence limits

Use Node 24 and the locked dependencies. `npm test -- --run` compiles the actual
backend once before Node test workers, so a fresh checkout executes the current
production entry. Focused verification:

```sh
npx vitest run tests/bot-handoffs.test.ts tests/bot-handoff-http.test.ts tests/bot-handoff-recovery.test.ts tests/bot-handoff-controls.test.ts tests/bot-handoff-security.test.ts
npm run build:all
npm --prefix apps/cloud-agent run build
npm --prefix web run test:e2e -- bot-handoffs.spec.ts bot-groups.spec.ts
```

All process tests create private temporary data/config/Provider/Cookie stores,
kill only their own child and remove fixtures. The artifact fault loader exists
only in that child and kills it after real fsync/hash verification before the
receipt, then restarts without injection. No production fault flag exists.
The provider emits deterministic HTTP SSE: real local Harness/SQLite/OS process/
HTTP/browser/effect evidence, **simulated model output**. Chromium emulates a
phone/iOS Hash Router; physical Safari, live vendor, actual Cloudflare deployment
and real IM delivery are Pending. Evaluation records observed gates; roadmap
requirements are not treated as implemented.

See [migration](migration.md), [security](security.md) and
[evaluation](evaluation.md) for rollout, backup and observed failures. Disabling
Handoff admission retains the current v82 code/data and existing owners; a full binary
downgrade requires an explicitly authorized consistent restore, not schema edits.
