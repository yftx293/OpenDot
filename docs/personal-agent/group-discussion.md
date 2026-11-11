# Persistent Group Dot sessions and bounded discussion

Implements [Issue #69](https://github.com/helsome/OpenDot/issues/69). A Group
owner explicitly enables discussion, selects participants and a coordinator, then
sends an undirected question. Outside a live discussion, directed `@Dot` Handoffs keep their single-request
behavior. During a live discussion, dispatched user additions (including
mentions) join that same run.

## Product behavior

The conversation stays the primary surface. The composer exposes **按轮讨论**;
its settings reuse the existing Group sheet (bottom sheet on mobile). A compact
activity line identifies the current speaker, round and completed speaking turns.
**停止讨论** cancels the server-owned run; closing/reloading the browser does not.

Discussion is off by default. Enabling requires a currently owned, active Group,
active Dot members, each member's configured Workspace scope and an unexpired
runtime grant. Group membership alone does not spend model or tool authority.
The existing Node Durable/Cloud admission flags still apply. A Group Dot Session
is server-owned, so its Node Durable runtime may use the owner's ordinary
container Workspace — the default Docker deployment path — without granting that
member a Host execution role. Private and Goal Durable Sessions still require an
authorized Host workspace, and a Host Group workspace still requires Host
authority.

Default limits are six speaking turns, two turns per participant, 24 model
attempts including coordinator decisions, and a one-hour run deadline. Owners
may choose at most 12 speaking turns, three per participant and 48 total model
attempts. Each turn also obeys its existing runtime grant's attempt limit.
The Cloud Session's existing immutable 24-attempt/day-long pilot grant remains
an additional lifetime bound; exhaustion fails explicitly and never forks or
renews a Session silently. This is a model-attempt budget, not token billing or
a monetary spending cap.

## Association and execution

`bot_group_dot_sessions` associates `(group_id, profile_id)` with one existing
Product Session and its Pi conversation. Different Groups get different
conversations. The association is permanent even after Group or native Session deletion so an
orphaned session cannot become an ordinary private session. New associations
cannot adopt a session that already has inputs, another Handoff owner, or a
committed conversation.

`bot_group_discussions` and `bot_group_discussion_turns` hold only product
selection, authority and projection state. Pi Durable remains the sole execution
owner: submissions, native tasks, model calls, tools, approvals and checkpoints
continue through `ProductRuntimeService`. The existing Handoff lifecycle sweep
repairs associations and completed-result projections. There is no extra agent
framework, execution queue or business scheduler, and no Pi dependency upgrade.

Each coordinator turn returns exactly one validated JSON decision:

- `speak` with one eligible participant UUID and an optional instruction;
- `finish` with a public summary;
- `wait_for_user` with a public question.

The legacy v1 protocol remains readable for existing runs. A speaker returns
`reply` with a public message or `pass`, and may add
`relay_to` naming one eligible peer. Passing consumes a speaking turn without
appending an empty agreement message. Malformed output or an unselected speaker
fails the run. Free-text “done” cannot terminate it. Coordinator decisions also
consume the model budget; exceeding participant or turn limits ends in
`waiting_user` instead of requeueing indefinitely.

### Versioned public messages and control

New `relay-v1` runs use output protocol v2. The immutable run version and the
exact frozen turn contract select the parser; pending old turns without a
version retain v1. New settings never upgrade an active run. Unknown versions,
a role mismatch or an attempted fallback fail explicitly after native proof
validation.

```json
{
  "version": 2,
  "public_message": "The current queue already preserves that order. We should reuse it.",
  "control": { "action": "reply" }
}
```

A quiet PASS uses `public_message: null` and `control.action: "pass"`.
Coordinator selections use a null public message and a validated `speak`
control; `finish` and `wait_for_user` require public text. Extra authority fields
and public content on a PASS are rejected. The existing native completion proof
is still required before any public projection or next-speaker transition.
Only `public_message` enters the Group timeline; normalized control stays in
the turn receipt. The prompt permits useful disagreement, clarification and
quiet PASS without requiring quotations or per-speaker summaries.

Group snapshots add a read-only `message_type: "conversation" | "status"`
projection. Old Bot replies stored as `system_event` remain conversation
content; their stored kind, source and receipt digests are never rewritten.
Pre-follow-up API payloads remain readable through the shared fallback mapper.

### Turn-taking

Discussion settings select a versioned policy. `coordinator-v1` remains the
migration default: only the coordinator selects speakers and peer nominations
cannot trigger execution. The owner can explicitly enable **允许 Dot 接力讨论**
to select `relay-v1` for future runs. A run snapshots its policy, participant
order, budgets and remaining queue; changing settings never changes a live run.

`relay-v1` starts in the persisted participant order without a separate model
selection before each speaker. A reply or PASS may nominate one eligible peer
using `relay_to`. The server validates membership, pending Session ownership,
per-Dot allocations and total allocations; otherwise it uses the next queued
member. A nominated member is removed from the remaining initial queue, and the
new turn records its originating turn. Once the queue is exhausted, the
coordinator can conclude or select further bounded work. Parked turns count as
allocated speaking turns, so late completion cannot exceed the run limit.

### Reading the Group incrementally

Each frozen input has a context version, digest, canonical timeline boundary
and a contiguous read boundary. At most sixteen oldest unread public messages
are delivered before remaining budget is spent on already-read background.
The read cursor advances only through that delivered batch after native
completion; omitted unread messages retain their original sequence for a later
batch. Message truncation records omitted characters and omitted unread spans
are explicit. The current root, earlier root and user additions are distinct.

The latest user additions have a separate bounded projection so a large backlog
cannot hide a new instruction. Content already present in the unread batch is
not repeated in that projection. A Dot's own public output is excluded only
when a completed turn and native input/result lineage prove it is already in
that same Product Session. Self-authored text without that proof remains
readable. Retries reuse the persisted input, not a rebuilt latest context.

Before the turn commits, `discussion-context.ts` budgets the exact serialized
UTF-8 envelope, including the speaker contract, work scope and native return.
The envelope stays within 32 KiB; this is separate from Pi's budgeting of its
full persistent provider conversation. Already-read background is removed first,
then older delta text is shortened. Current user constraints and the native work
result take priority. All shortened text retains cumulative omitted-character
counts; removed background gets explicit sequence ranges. If a whole unread
message must be removed, `read_through_seq` stays before that gap, and the same
boundary is saved on the turn. The digest describes this final selection.
Authority/control metadata is never shortened to admit an invalid input.

No other Group, private transcript, provider secret or full tool trace is
copied. Internal Group sessions and their raw context are excluded from private
conversation pickers and private new-message broadcasts. No rolling summary is
invented when a source range is omitted.

### User interjections

A user message sent while a run is live is not rejected. It commits as a
canonical message, keeps its receipt and joins the same run: the running Dot
finishes its turn, then the coordinator reads the interjection before deciding
who speaks next. No extra model attempt or speaking turn is charged for the
message itself. If no Dot is currently generating (for example the run is
idle between turns), the interjection immediately returns the floor to the
coordinator. A new message after the run became terminal opens the next bounded
run with `continued_from_run_id` pointing at the earlier one, so follow-up
questions keep their history without reusing native turn receipts.

### Approval and device waits

An approval or device wait is not a model turn. When a speaker turn is waiting
on a human decision or a device result, the turn is parked: it keeps its native
input, its pending state and its execution authority, but releases the run-level
speaking slot. The coordinator continues with other eligible Dots, and the
parked Dot is excluded from `eligible_speakers` and reported in `awaiting`
(`profile_id`, `reason`, `since`). Each awaiting entry carries the owner-visible
approvals of that Dot's own session, so the Group sheet shows the consent
request even though the active speaker is someone else. The UI shows
“等待你的确认/等待设备结果” next to the activity line.

If the coordinator concludes while a Dot is parked, the conclusion is published
as a provisional public message and the run stays `running` with
`awaiting_results_since` set. Ending the run then would revoke the parked
consent and drop its result, so the run idles instead of spending further model
turns. When the human answers, the native result returns, the parked turn
resumes, the coordinator sees `awaiting` empty and closes the run. A user
interjection also resumes a deferred run. This wait handling retains each pending native turn. Independent work uses the
separate Handoff bridge below; parking does not turn the same pending Session
into a second worker. The coordinator itself is never
parked: it is the run's only decision-maker, so its own wait still blocks
progress.

### Independent work bridge

A v2 speaker can propose a `delegate` control with one stable target, public
instruction, required tool capabilities, a model-attempt limit and up to eight
source message IDs. The proposal is persisted against its completed native
turn and canonical public announcement. It does not start work. Proposed source
IDs must have been visible in the original frozen Group input; only canonical
public material is copied into the later work request.

The Group owner reviews the proposal in the existing settings sheet and confirms
its exact digest/revision. Another member (including another administrator)
cannot approve it. Denial or stopping an unapproved proposal admits no Handoff.
A changed, replaced, revoked or expired target grant is rejected rather than
silently adopting new authority. The existing Group command receipt owns replay
and lost acknowledgements.

The explicit discussion-origin Handoff admission verifies the original native
input/result and public source. It never forges an owner-authored user message.
Provisioning, execution, approval/device protocol, Cloud association and result
projection remain in the existing Handoff/Product Runtime services. The new
work Session is distinct from the target's persistent Group Session, so the
Group can continue speaking while the worker waits for approval or a tool.

The work's effective tools, attempt cap and deadline narrow its existing live
runtime grant. Node dispatch, native approval scope, provisioned Cloud metadata
and Cloud grant matching use that same immutable reviewed scope. Goal-bound
device reads remain unavailable in this proposal path; no Goal authority or
shell/deployment tool is invented.

Approving work reserves its maximum attempts from the existing discussion
budget. Every actual native worker generation is counted in aggregate with
Group generations; finishing/failed work releases only unused reservation.
User additions and result continuations do not reset either budget. Run
snapshots expose total `model_attempts`, `work_model_attempts` and
`reserved_work_attempts` so a reservation is not misreported as a completed call.

Only an already committed native Handoff result can mark work returned. The
original requester receives at most one queued continuation with that actual
public result and receipt digest, through its original Group Session and within
remaining turn/model limits. Continuation identity is durable and immutable.
Duplicate decisions, callbacks and process recovery cannot create a second
worker or continuation. Exhausted budgets keep the public result and explicitly
suppress an extra model call. Failed work remains failed, never PASS.

Stopping discussion cancels unapproved proposals and fences all further causal
continuations. Separately confirmed work may still finish; the UI states this
scope and its existing task controls can stop that work independently. A late
result is retained once but cannot reopen the cancelled discussion. Existing
Group/member/grant revocation continues to govern worker execution.

A reply becomes visible only after matching the original Product input,
submission, native producing task, answer entry and digest. Decision validation,
canonical append, read cursor and next phase commit in one SQLite transaction.
A duplicate callback cannot produce another message or advance another turn.

The additive deferred-turn, relay-policy and native-stop-status migration increments the database
version, using the existing pre-upgrade backup and downgrade refusal. Existing
runs migrate to `coordinator-v1` with an empty relay queue.

## Revocation, stopping and recovery

Each context read and execution checks the current owner, Group, all selected
members, Workspace scopes, live runtime grants, configuration fingerprint and
current pending turn. Actual tools retain the existing approval/device checks.
Discussion never grants access to personal memory. Goal-bound device reads are
rejected during setup; this feature does not mint Goal or device authority.
Profile/configuration identity changes block the existing association under the
current runtime policy; they never silently select a replacement identity.

Stopping commits the terminal run and cancels its pending turn before waiting
for the native abort. The session remains marked as stopping until that abort
joins. The immutable run outcome `cancelled` proves the product fence, not a
successful native abort. Snapshots separately project `stop_state`: `stopping`
while an abort is pending, `uncertain` after a coded native/transport failure,
and `stopped` only when every fenced Group Session has joined its abort. The
coded failure persists across Node restart, without copying private native error
text into the Group. Success clears only that exact run's fence and failure,
advances the Group revision and notifies connected clients. A stale retry cannot
clear a newer run's stop. The owner can retry from the activity line; older
server payloads without this projection are treated as unconfirmed in the UI.
A new turn cannot reuse the Session early. Late replies cannot enter the canonical
timeline. Cloud stop uses a signed, exact-run/turn stop-only proof; the worker
aborts a dormant native conversation without activating model or tool execution.
The Cloud Session's identity remains available for a later authorized question.

Permanent Group and Handoff origins exclude their Sessions from the legacy
private-conversation recovery and inactivity archive scans. Their native
coordinators own resume and retention. A restart must not append a private
“recovering conversation” notice or resubmit old Group history as a new input.

Node restart reattaches the original pending turn/request/submission. Completed
turns stay completed. Existing Pi recovery owns interrupted model requests and
attempt accounting. Transport/checkpoint/authority errors produce an explicit
failed run with retained receipts rather than an invented answer. Cloud object
reconstruction uses the existing persistent native Session and signed authority
protocol. Browser reconnect only fetches authoritative snapshots.

A recovered Cloud Handoff can persist its original admission receipt before a
status snapshot returns. The existing recovery scan confirms such ready native
receipts through the same request/payload/session validation, independently of
model completion and progress callbacks. It does not acquire another submission
lease, submit an input or claim that work completed. Paused and terminal Handoffs
are excluded from this ready scan.

Idle persistent sessions remain authorized to read their configuration while
another participant speaks. The runtime's authority heartbeat must not mark
that normal wait as revoked execution.

## Verification

### Issue #71 follow-up scope

| Requirement                                        | Current state                             | Remaining boundary               |
| -------------------------------------------------- | ----------------------------------------- | -------------------------------- |
| Persistent Group × Dot sessions and authority      | Reuses #70; full Node suite passed        | Remote CI                        |
| Bounded unread batches, frozen digest and cursor   | Implemented with byte-budget tests        | Deployed Cloud reconstruction    |
| Exclude only proven own-session output             | Implemented; real input checks captured   | Longer production observation    |
| Versioned relay and durable initial slots          | Implemented, default off                  | No default-on rollout            |
| User interjections and stale coordinator decisions | Native/API and real-provider coverage     | Physical-phone reconnect         |
| Cancel fence and confirmed/uncertain native stop   | Native and fault-injected coverage        | Deployed abort faults            |
| Approval/device wait parking                       | Integrated; local native/UI coverage      | Deployed device path             |
| Versioned public-message/control envelope          | Implemented; real provider and workerd    | Deployed protocol validation     |
| Independent work and one causal return             | Existing Handoff; native/real evidence    | Deployed provider acceptance     |
| Compatible conversation-message projection         | Read-time projection; compatibility tests | Remote CI                        |
| Ten-case same-model quality comparison             | Forty runs reviewed; mixed findings       | Component ablation kept separate |
| Mobile conversation and keyboard layout            | Real-provider Chromium run passed         | Physical phone                   |
| workerd, deployed Cloudflare and complete CI       | Local workerd and full Node suite passed  | Deployment and remote CI         |

This table tracks the complete follow-up. Approval parking and the independent
Handoff bridge have separate coverage. Targeted backend checks do not establish
real-provider, deployed Cloudflare or physical-phone acceptance.

- `tests/group-discussion-stop.test.ts`: persisted native-stop failure, restart/retry joining, exact-run fencing and no stale clear; native stop transport is fault-injected.
- `tests/group-discussion-ui.test.tsx`: authoritative stopping/stopped/uncertain controls, owner retry and conservative old-payload compatibility.
- `tests/group-discussion-context.test.ts`: exact UTF-8 envelope budget with native return, source truncation/omission records, a contiguous cursor and deterministic immutable freezing.
- `tests/group-discussion-protocol.test.ts`: version/role binding, strict public/control separation and no fallback.
- `tests/bot-group-message-projection.test.ts`: historical metadata preservation and conversation/status classification.
- `tests/group-discussion.test.ts`: decisions, bounded context, scope isolation,
  admission receipts, interjections and run continuation, parking/`awaiting`,
  model limits, Stop and revocation.
- `tests/group-discussion-work-http.test.ts`: native independent worker, narrowed tools/budget, proposal and artifact consent, restart, one causal return, denial and scoped stopping; inference is synthetic.
- `tests/group-discussion-http.test.ts`: actual backend and independent Pi SQLite
  sessions, ordered public replies, long participant turns, restart and Stop,
  a live-run interjection, relay between Dots, and a parked approval that lets
  the Group continue while the run closes only after the parked result returns.
  It also covers a member-owned container Workspace created through ordinary
  registration and runs a full discussion there without Host authority.
  The loopback provider SSE is synthetic.
- `tests/group-container-product-model.test.ts`: the container-workspace
  allowance is scoped to Group-owned runtime selection; private and Goal
  Durable admission still rejects a container workspace.
- `tests/group-discussion-cloud-http.test.ts`: actual Node authority and workerd,
  reconstruction, persistent session reuse and stop-only abort. Model responses
  and HTTPS-to-loopback routing are synthetic. Run through
  `npm run test:cloud-authority` after bundling the Worker; ordinary Node tests
  do not require an already generated Cloud bundle.
- `tests/schema-v87-group-discussion.test.ts`: pre-migration backup, retained
  canonical messages, empty new associations and downgrade refusal.
- `web/tests/e2e/group-discussion.spec.ts`: full UI/API at 1440×900 and 390×844,
  settings, running state, reload, Stop, keyboard-sized viewport, console and
  HTTP failures. A completed long conversation remains pinned above the composer
  on viewport resize; manually scrolling into history disables that pin and a
  later resize preserves the reader's position. Run with
  `web/playwright.groups.config.ts` only after the Web build has finished;
  starting its isolated server while Vite clears `dist` can omit static routing.
- `scripts/test-group-discussion-live.ts`: opt-in real-provider test with three
  persistent Pi sessions and a Node restart during the run. Requires private
  `MINICLAW_GROUP_MODEL_CONFIG`; emits hashes/counts, never credentials or raw
  replies. `MINICLAW_GROUP_EVIDENCE_PATH` selects the private report path.

### Real-provider comparison

`scripts/test-group-discussion-compare.ts` runs the ten fixed public tasks in
`scripts/lib/group-discussion-cases.ts`. It keeps the same private model,
personas and per-run budget for `coordinator-v1` and `relay-v1`, reverses their
order on alternating repetitions, and defaults to two repetitions. Real
inference uses an authenticated loopback observer that forwards the actual SDK
request unchanged. The observer resolves the exact native Session and frozen
input from the isolated database and attaches the same application session
headers used by the configured provider. Missing headers in a standalone probe
can produce a false negative; such a probe is not Group acceptance.

The report records real request/message IDs and content digests, native result
lineage, public redacted messages, actual token usage when provided, latency,
model attempts and stop timing. Approval cases use the existing owner decision
and exact native consent APIs. No synthetic fallback or automatic tool authority
is allowed. Other-Group isolation uses the same Dot profiles and distinct native
Sessions. Only the isolated fixture data is used; live user conversations and
private memories are not copied into these tasks.

```bash
MINICLAW_GROUP_MODEL_CONFIG=/path/to/private-model.json \
MINICLAW_GROUP_EVIDENCE_PATH=/path/to/private-comparison.json \
node --use-env-proxy --import tsx scripts/test-group-discussion-compare.ts
```

The private configuration uses `baseUrl`, `api`, `model`, and `apiKey`; it must
remain outside Git. Reports use a model/configuration hash and are written with
mode `0600`; endpoint, model name, key, URLs and private paths are redacted from
reported text. `MINICLAW_GROUP_CASES` selects comma-separated case IDs for a
pilot; a pilot never counts as the full corpus. `MINICLAW_GROUP_REPEATS` controls
repetition count and `MINICLAW_GROUP_MAX_REQUESTS` bounds actual provider
attempts (default 300). Each discussion has the same twelve-attempt limit.
`MINICLAW_GROUP_RESTART=1` enables an additional opt-in fault run: after a real
public reply commits, the isolated Node process is killed and restarted. The
report checks frozen turn/request/input/submission identity and Group Session
associations across that restart. The tighter probe requires an admitted native
input and an unfinished actual provider request before the kill; a nullable
projection field alone does not establish that identity. Keep this fault run separate from latency comparison.

Pi conversation numbers are local to each native SQLite store. The isolation
check requires distinct Product Sessions and distinct physical native stores;
reusing conversation number `1` in those separate stores is valid. A shared-file
alias must fail even if the file names and Product Session IDs differ.

A completed transport run does not establish useful collaboration. The report
keeps `passed: false` until public conversations have been reviewed for new
information, repetition and wrong delegation. Lexical overlap is explicitly a
heuristic. This two-arm comparison changes both protocol and scheduling; it
cannot isolate JSON, prompt and scheduler effects, so separate ablation remains
required. No result is inferred from a model saying the work succeeded.

### Supplemental controls and component experiment

The original ten tasks remain unchanged. `closed-pass` in
`scripts/lib/group-discussion-supplemental-cases.ts` is an explicit extra control:
it closes all open questions instead of asking for more risks. The original
forty runs produced no PASS; the separate closed-scope control captured six
native silent PASS decisions across two relay runs, while two coordinator runs
closed without requesting redundant speakers. These are separate observations.

For a real-provider mobile probe, select one case, one policy and one repetition
with `MINICLAW_GROUP_BROWSER=1`, `MINICLAW_GROUP_POLICIES=relay-v1`,
`MINICLAW_GROUP_CASES=natural` and `MINICLAW_GROUP_REPEATS=1`. The probe uses its
own Chromium context and isolated fixture, sends through the actual composer,
checks light/dark and keyboard-sized geometry, and reloads without another model
request. Screenshots are private and withheld if configured private values occur
in the rendered text. It does not control an existing user browser tab.

`scripts/test-group-discussion-ablation.ts` is a separate opt-in component study.
Set the private model configuration and `MINICLAW_GROUP_ABLATION_EVIDENCE_PATH`;
`MINICLAW_GROUP_ABLATION_MAX_REQUESTS` bounds its total actual requests (default
96). Four arms compare v1 versus v2 wire shape under the same coordinator and
neutral guidance, neutral versus natural guidance under v2/coordinator, and
coordinator versus relay under v2/natural guidance. It uses two chat-only tasks,
two repetitions and reversed arm order on the second repetition.

The experiment loads hashed source overlays only inside its owned fixture
process; it does not change production files, stored immutable runs, native
proof validation, ACL or approval. All arms exclude delegation from the output
contract. This reduced experiment is exploratory: it is not a complete factorial
or blinded human quality study, and v2 retains its versioned context fields.
Keep its results separate from the production two-policy corpus and report
failures rather than automatically attributing differences to JSON or claiming
model-independent quality gains.

### Recorded local checkpoint (2026-10-23)

Before the subsequent Cloud admission-recovery repair, the full Node suite passed
418 files and 3277 tests, with 23 pre-existing skips. That full result must not be
represented as a rerun after the recovery repair; its final gates are recorded
separately. The complete Cloud authority rerun passed 8 files/14 tests after the
receipt fix, with real Node/workerd lifecycle and synthetic inference. Ten
Handoff regressions passed. Six Group browser cases and two navigation cases
passed; the navigation cases cover 320/390/1100/1440 widths.

An earlier migration-fixture failure was repaired by dropping the new child work
table before its legacy parent tables; assertions and upgrade protections remain
intact. Thirty affected migration tests passed before the full rerun.

The forty real-provider runs used one hashed private configuration, fixed
personas/budgets and two repetitions. After correcting the verifier's mistaken
global uniqueness requirement for store-local conversation numbers, relay met
20/20 scenario expectations; coordinator met 18/20, with independent-work gaps.
The original raw failed report remains retained alongside the derived correction.
Tight restart probes passed for both policies with admitted input/submission
identities bound and preserved. A same-Group transition from legacy coordinator
v1 to relay v2 retained all three Product/native Session/store identities, kept
the completed legacy run and frozen turns unchanged, and forwarded earlier
public messages into new actual model inputs (nine requests across both runs).
A separate real-provider mobile run passed with
four actual calls, no synthetic inference, no browser errors and no request on
reload. Two earlier mobile probes exposed a keyboard overlap; the fixed run and
an automated history-position regression cover that failure.

All forty public conversations received an agent rubric review, not an independent
human score. Relay produced more messages with concrete additions, but also
more predominantly repeated messages (11 versus 2). Samples confused proposed
versus created artifacts, disagreed on an artifact ID, or expanded the requested
scope; the reviewer sometimes corrected them. These findings do not justify a
blanket quality or token-cost improvement claim. The initial two-arm comparison
confounds protocol, prompt and scheduler; component results must be reported
separately.

The exploratory component experiment completed 16/16 scenario checks with 52
actual provider requests and no synthetic inference. Wire v1/neutral,
wire v2/neutral and wire v2/natural coordinator arms each used twelve attempts
across four cases; the relay/natural arm used sixteen. On the natural task,
relay used four calls versus five; on the already-closed task, relay used three
silent native PASS calls plus a conclusion while coordinator closed in one.
This illustrates that deterministic slots are not uniformly cheaper. Changing
wire shape or natural guidance did not establish a general quality advantage in
these two controls. All results retain their source-overlay hashes, private
configuration identity, native lineage and limitations. Private evidence and
credentials stay outside Git.

The local service was restarted through its existing launcher after an online
private SQLite backup. Page and health checks returned 200, the additive upgrade
completed and SQLite integrity remained valid. A subsequent startup-recovery
routing regression was caught in the logs and fixed: ordinary recovery/archive
scans exclude permanent Group/Handoff Session origins. Three focused tests
passed, including actual native restart without a private recovery notice.
Their command excluded other cases by name; it introduced no source skips.
The final broad Node rerun completed: 418 files and 3278 tests passed, with 23
pre-existing skips (3301 total). It retained the original running process through
long quiet intervals. The added recovery unit case is included in that count;
the focused native HTTP restart check is recorded separately because the full
run's compiled fixtures were built before the last SQL routing guard.

GitHub CI failed all three jobs before any steps were recorded; logs returned 404. The authenticated GitHub run page's Annotations then confirmed an account
restriction: recent payments failed or the spending limit needs to increase.
GitHub does not distinguish those alternatives in that message. The account
owner must resolve Billing & plans before remote CI can execute. No billing or
spending setting was changed. The PR remains Draft; local green checks do not
stand in for a successful remote run.

These are separate evidence categories. Deployed Cloudflare and a physical
phone require their own live runs; workerd and Chromium emulation cannot prove
those environments.

## Ordinary text chat defaults

The Owner no longer needs to configure each Dot's Workspace scope and model-call
grant before ordinary discussion. With Group execution enabled, new roster Dots
receive model-only defaults from their existing owned configuration when ready.
Opening discussion or sending a new message prepares older Groups and renews
expired model-only configuration. No model call happens merely from creating a
Group or enabling discussion. File/tool access remains opt-in under advanced
settings; an existing tool grant is never automatically extended. The previous
per-member grant API remains available for advanced capability and Cloud setup.
