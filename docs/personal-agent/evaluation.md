# Evaluation evidence

The latest section supersedes earlier Pending/Not implemented markers. Older
sections retain evidence and limits recorded at each previous milestone.

## Cloud Bot foundations (#34, admission still closed) — 2026-10-18

[Cloud Bot foundations](cloud-bot-teams.md) integrate the verified #27/#28 Cloud
recovery/public-Goal implementations with #38 and add optional Handoff origin,
frozen grant matching and native producing-Task result provenance. The two
prerequisite commits are independently reviewable in Draft PR #39. New Cloud
Group execution is still explicitly rejected; DTO support is not the formal
Group→Cloud→Group feature. Goal association, durable progress projection,
Handoff-specific stop/resume/recovery and cross-store admission repair remain
Pending before that gate can open.

Observed current foundation gates: full Node **378 files / 3,093 passed /
23 existing skips** (122.37 s); actual workerd **42/42** (42.47 s); actual
Node/workerd authority/Memory/Goal integration **3/3** (21.44 s). Complete Node/
Web/E2E/runner typechecks, backend/Web/runner builds, runner self-test and Worker
dry-run passed. The complete browser suite passed **22/22** (4.6 minutes);
the combined public Cloud Goal phone/Scheduler/lease/approval/artifact/delivery
scenario also independently passed in 2.2 minutes. Electron typecheck and
main/preload bundles passed.

Real local workerd evidence: its result outbox stores the answer-producing Task
read from the committed SDK Entry, matching an actual GenerationTask record;
eviction retains one input without another model call. An empty Handoff tool
list declares no implicit tool, while ordinary Cloud bindings keep inspect_text.
**Product policy is simulated in these workerd-only cases.** Node SQLite fixtures
verify original Handoff/Session/grant association and rollback of forged marker,
broadened tools/model budget/deadline, plus rejection of Node→Cloud owner aliasing;
provider configuration there is synthetic and no model executes. Protocol tests
compare Node/Worker strict metadata and reject Goal/Handoff owner aliases and
unbounded/forged final-answer progress fields. These are layer tests, not formal
Cloud Group acceptance.

A standalone temporary source copy with only Cloud node_modules typechecks
successfully. A negative control importing the Node validator fails specifically
on missing Root zod, proving the cross-workspace dependency boundary; Node and
Worker therefore keep matching local validators and portable shared wire types.
The original installed dependency directories and lockfiles are unchanged.

A second valid negative control removes only the producing-Task field from the
test Worker's result outbox. Native generation still completes, but the targeted
receipt assertion fails on `undefined` versus the actual Generation Task 15
(13.90 s). Other cases are filtered for this mutation check; the unmodified full
workerd gate remains 42/42. Unmodified targeted code passes again afterward
(11.90 s). No production source is edited by the transform.

Failures/fixes retained: the first workerd attempt had two new cases using the
wrong model ID for the existing authority fixture; correcting the fixture
configuration restored native completion. Its extended /requests statistics
broke an old exact assertion; /requests was restored and the new tool-statistic
endpoint is separate. No existing assertion or permission was relaxed. Root
NodeNext typecheck also required the portable execution-protocol import's .js
specifier; a test-only readonly override list was simplified to a typed mutable
list. No production API fallback or weakened scope was used to pass these gates.

Live Provider/model, deployed Cloudflare, physical device/Safari, real IM and
Cloud Group execution remain unverified/unimplemented as described above.
The original October 15 backend and separate original M4 worktree edits remain
untouched. #38 passed **all three** remote checks at 1debc6a in
[run 39127754920](https://github.com/helsome/OpenDot/actions/runs/39127754920),
superseding its earlier Pending marker below. #39's remote validate is still
running; do not attribute #38's CI result to another head.

## Native Group Handoff (#33) — 2026-10-18

[Native Handoff](bot-handoffs.md) implements Owner-only expiring execution grants,
default Chief/directed targets, explicit Owner-confirmed Chief delegation,
immutable source/Session/native input/Submission/producer-Task/answer provenance,
real progress/results, pause/resume/cancel, native exact-run Abort, scoped artifact
approval and bounded result-projection retry. It reuses the existing Product
Runtime, Harness, native SQLite and queue-control protocol. Cloud Handoff is
explicitly rejected until #34; this increment does not create a Goal or claim
long-Goal completion. Shared membership never spends Owner model/tool authority.

Observed local gates: **375 Node files / 3,077 passed / 23 existing skips**
(131.04 s); `make typecheck`, Electron typecheck, backend/Web/runner builds,
Electron bundles, runner self-test, format/docs/diff checks and Worker dry-run.
The final affected native/store/security fault suite passes **17/17** (45.92 s),
including exact malformed-approval 409 after the last error-presentation fix.
The entire browser suite passes **21/21** (2.8 min); the strengthened mobile
approval case independently passes **1/1** (9.9 s), verifying the real completed
Tool receipt, one mode-0600 file, exact content and unchanged inode/mtime after
same-key decision retry. Actual workerd passes **35/35** (28.08 s); the three
actual Node/workerd authority/Memory/Goal integrations pass **3/3** (20.35 s).

Real local evidence (all private temporary fixtures, never the original backend):

- Formal Cookie-authenticated production Node entry → owned Group/grant → native
  Pi Durable SQLite/Harness → actual Submission/producer Task/answer → one Group
  Bot result. Duplicate requests retain the original identity and model count.
- A held model request is interrupted by actual child SIGKILL. A fresh process
  continues the same input/Submission/Generation Task without posting a new
  prompt. Two HTTP attempts consume two original budget units; exactly-once
  vendor billing is not implied. SDK Storage is inspected only after owner exit.
- Pause survives process death without a second model request; explicit Resume
  keeps native IDs. Cancel and exact-run native Abort reject late results and
  remain terminal after restart. Existing native control receipts are retained.
- Artifact approval waits through restart. A test-only module loader kills the
  child after real fsync/hash verification and before the effect receipt. A new
  process reconciles the same approval/Tool Task and unchanged file inode/mtime.
- A SQLite trigger prevents Group result commit after the native answer commits.
  Persistent projection retries later converge with one model request. A second
  persistent fault exhausts all eight retries, stays uncertain through restart
  and does not regenerate the answer or publish a late result.
- Desktop + iOS-style Hash mobile use real Group UI, native Chief reply, reviewed
  Researcher grant and explicit Chief delegation. Only two selected native tasks
  run; @ text in Chief output does not dispatch a Bot. Offline reload preserves
  one shared result. Another mobile journey closes desktop, kills/restarts the
  backend during approval, loses a committed decision ACK, reloads without
  auto-POST, then retries the original key and sees one actual artifact/result.
- Invited users and outsider administrators cannot grant, dispatch, control or
  read private approval content. Bot revocation fences pending approvals/effects
  and restart. Store tests cover immutable identities, rollback, orphan markers,
  expiry, model/tool bounds, JSON-expanded-context rejection and the verified
  mode-0600 v80 backup/upgrade without adopting old Sessions.

Failure/fix evidence: canonical Product inputs represent absent origin as null;
the strict new binding now accepts null/undefined only without changing the
original digest. Native Abort intents now use the existing QueueCommand parser's
canonical field order, fixing a real control-payload conflict. Legacy migration
fixtures remove future-only tables before reconstructing older schemas; no
production migration/ACL/assertion was deleted. The first context-bound unit
case left dispatch disabled, so its intended fault did not fire; explicitly
turning on its test flag preserves the original rejection assertion. A first
mobile test used a non-iOS UA and correctly stayed on BrowserRouter; the fixture
now explicitly emulates iOS for the actual Hash journey. No runtime workaround
was added for that fixture mistake.

A valid negative control disables only the new projection retry in a test-child
module loader: after the injected delivery fault is removed, the committed answer
fails to reach Group state (assertion timeout, 35.51 s). Unmodified code passes.
The earlier attempt removed the fault before final native publications settled
and **passed**; that attempt is not counted as a negative control. No test was
skipped, deadline increased, permission relaxed or original service restarted.

Simulated: deterministic Provider HTTP SSE/model content, Chromium phone/iOS
emulation, SQL/fault-loader failures and unit-only grant/expiry fixtures. Native
execution, OS process death, files, SQLite, local workerd and authenticated
HTTP/WebSocket/browser paths are real local execution. Live model/provider,
actual Cloudflare deployment/hibernation/billing, physical Safari/devices, live
IM delivery and general external-write reconciliation remain Pending. Autonomous
planner delegation, Cloud Group Handoff/Goal association, generic Group
queue-edit/Steer and inherited Memory/MCP/device capabilities are not implemented
by this slice. Remote CI for this new increment is pending its pushed head.

Earlier PR #37 is independently Draft/reviewable and all three remote checks
passed in [run 39120866213](https://github.com/helsome/OpenDot/actions/runs/39120866213).
That supersedes its older remote-CI Pending statement below. PR #36 likewise
passed all three checks in run 39118093373; main remains unchanged.

## Server-owned Bot Group timeline (#32) — 2026-10-18

[Bot Groups](bot-groups.md) implements independent Group/member IDs, current ACL,
explicit Bot scope, canonical ordered messages and atomic idempotency receipts.
The existing app provides real list/create/chat/member/scope/rename/archive/paging
flows and snapshot reconciliation. No Group message starts a model or native
runtime in this milestone; Handoff remains Issue #33.

Observed local gates: **370 Node files / 3,059 passed / 23 existing skips**
(86.10 seconds), full `make typecheck`, backend/Web/runner builds, runner
self-test, Cloud Worker dry-run, and **19 browser cases** (3.5 minutes). The
strengthened actual Group journey, including real Hash Router back/forward,
Workspace privilege revocation and logout, separately passes in **23.0 seconds**.
The actual Node/workerd authority suite passes **3/3** (21.14 seconds). Focused
Group API/client/migration/backup cases pass **23/23**. The original backend
process remains running with its unchanged October 15 start time; all new
process/SQLite tests use isolated fixtures.

Real local acceptance: Cookie-authenticated private backend; desktop, Hash mobile,
invited member and outsider administrator; actual UI creation/invitation/sending;
HTTP/WebSocket snapshots; real post-commit receipt loss and same-key retry;
concurrent inputs; mobile offline recovery; child backend SIGKILL/restart with
unchanged message IDs/revision; real history paging; sender/mention rejection;
member and Workspace revocation; no later unauthorized broadcast; logout. Schema
79 backup has mode 0600/integrity proof and preserves Cloud placement/budget/Root,
JSONL identity and the unrelated ownership trigger's distinguished SQL.

Failure evidence is retained: the first Group browser expected 403 where the
existing Workspace owner-hiding route returns 404; it now asserts exact 404 and
Owner 200. One unchanged 5-second Cloud authority case timed out during a
concurrent full Node/browser run (3,058 other passes). Running the complete Node
suite alone passes all 3,059 at the original limits; no check, permission or test
was removed or weakened. A compile-only negative-control transform removing the
Group read-generation fence causes the revocation race test to fail by restoring
the old snapshot; the unmodified six client fault cases pass. The simulated
storage-failure test targets happy-dom's bound storage instance, ensuring the
fault actually fires before transport.

Mocked/simulated: client-hook transport races and quota exhaustion; models in
existing native-runtime regression journeys use HTTP fixtures. The new Group
journey performs **no model execution**. iOS behavior uses Chromium emulation,
not physical Safari. Native Group Handoff, live vendor, real Cloudflare deployment,
physical multi-device and real IM delivery remain unverified/unimplemented as
applicable. Remote CI for this new PR is pending until its pushed commit runs.

## Bot-first authorized entries (#31) — 2026-10-18

The follow-up to PR #29 uses current server authority for Profile-bound main
conversation entry, explicit Workspace confirmation and stale-input rejection.
It preserves Profile/Workspace/Session identity and existing execution owners.
See [bot-first-product.md](bot-first-product.md) for scope, protocol, rollback and
the recorded failures/fixes. No group or Handoff execution is claimed here.

Observed local gates: **367 Node files / 3,038 passed / 23 existing skips**
(89.60 seconds), full Typecheck, backend/Web/runner builds, runner self-test,
Cloud Worker dry-run and **18 browser cases** (2.5 minutes), plus format/docs/diff
and staged credential-pattern checks. The two strengthened remembered-child
journeys also pass (53.1 seconds), preserving generic Workspace tab restoration
while fencing explicit Bot entry to main. Runtime/HTTP/Cookie/SQLite/private-process and
reverse-proxy infrastructure is real local execution. Model output and the
explicit empty-Profile-list UI fault are simulated; iOS flags run in Chromium.
Remote CI for Draft PR #36 commit `99227bd3d199abed84698277f9f283d43378abb3` passed all three jobs (`validate`, `cloud-agent`, `cloud-authority`): [run 39118093373](https://github.com/helsome/OpenDot/actions/runs/39118093373). Physical iOS, live vendor and production deployment remain unverified.

## Explicit Cloud Goal admission and background recovery — 2026-10-18

Implemented: explicit default-off `MINICLAW_CLOUD_GOALS` admission through the
existing Goal API/page, immutable runtime selection for a new owned Session,
transactional permission/configuration/100-run/core-context validation, and
bounded prior-result excerpts without changing stored snapshots. Missing runtime
preserves the legacy creation hash and Node behavior. Committed creation retries
retain their original Goal after new admission is disabled. Scoped availability
contains no credential and cannot provision execution.

The new mobile browser case drives the actual compiled Node service and local
Miniflare/workerd using Cookie login and private SQLite. It loses the first Goal
creation ACK, retries the same key and sees one managed Goal/Session/task. The
real background Scheduler starts the Cloud input; no manual claim/start call or
chat resubmission is used. After closing the desktop client and taking the phone
offline, the test evicts workerd, SIGKILLs only its isolated Node child and
restarts both with new Cloud admission disabled. It waits for the production
lease to expire naturally, then verifies the same run and one business budget
charge. The phone approves the exact content. A second workerd restart after the
actual file write but before receipt reconciliation recovers the same native
tool/input/approval; the file inode/content remain unchanged. The server checks
the literal criterion, completes the Goal and the existing result outbox records
successful delivery to the owned Workspace. A late duplicate approval after
Goal completion is correctly denied, rather than reviving the finished run.

**Evidence boundary:** the processes, Scheduler, native checkpoints/Alarms,
Cookie auth, encrypted Provider, files and browser clients are real local
infrastructure. Model HTTP replies and HTTPS hostname routing are fixtures.
The targeted browser case passed in 2.2 minutes; it is not live vendor inference,
Cloudflare account deployment/hibernation, a physical phone or IM acceptance.
Cloud Device tools, Cloud proactive GitHub execution and recovery-time queue
editing remain implementation work; production credentials are not their blocker.

Observed backend regression: **367 files / 3,038 passed / 23 existing skips**
(91.30 seconds), including six SQLite/HTTP admission cases and three pure context
cases. Full Typecheck, backend/Web/runner builds, runner self-test and three actual
Node/workerd HTTP cases (19.57 seconds) pass. All **17 Chromium browser cases**
pass (4.0 minutes), including the new background-Scheduler Goal and the existing
Session/approval/device/mobile regressions. Formatting, documentation, diff and
staged credential-pattern checks pass. Remote CI for this increment is Pending.
The Cloud Worker source/dependencies are unchanged
from PR #27. That predecessor has all three remote checks passing in run
`39112209170`; PR #26 passed `39109653713` and PR #25 passed `39106141222`.
No production resource, main branch or live backend process was changed.

## Cloud native model interruption and fenced stop — 2026-10-18

Implemented internally: managed fetch-boundary admission, checkpoint-preserving
HTTP/SSE failure parking, persisted bounded Alarm recovery, shared in-memory
close coordination, captured lease/Goal-revision stop fences and permanent
cancelled ownership. No replacement prompt or tool replay is used. Model read
retries spend the original twelve-attempt budget and may incur another vendor
charge. Native-compatible complete finish_reason EOF, split UTF-8 and CRLF are
accepted without inventing a terminal frame from incomplete data.

Actual workerd faults preserve the same native generation task and submission
across stream truncation, object eviction and Alarm recovery. An injected failure
between policy success and Harness activation is reproduced in an isolated
negative control: without rearming, the row incorrectly remains resumed while
the task is unfinished. The fix retains waiting/backoff, survives another eviction
and completes the same task with two model requests. A denied wake makes no
model request. A further actual service-binding fault returns HTTP headers and
an incomplete JSON body while keeping I/O alive. Stop finishes the actual native
authorization promise via its abort signal and keeps the same placed submission.
The isolated negative control that omits that signal fails with the authorization
promise still pending. Server-side computation cancellation is not inferred from
local cancellation. An initial fixture without pending I/O was rejected by
workerd as hung; it was corrected to exercise a real outstanding response body.
The shared bounded-body reader now supports cancellation, and JSON authority
calls retain a complete-response deadline. A separately seeded eighth-probe boundary persists exhaustion;
it is not reported as eight real HTTP failures. Pause survives Alarm/eviction,
a stale lease cannot stop resumed work, cancellation rejects late activation,
and a byte-split compatible EOF completes once without false recovery.

Actual Node/workerd HTTP acceptance now first commits Goal pause, waits for the
real Node model proxy to interrupt its active stream, then invokes the signed
stop RPC. The original native submission/Goal run survives workerd restart while
paused, and the stale Goal revision is refused after resume. The same TaskRun
finishes its bounded step. A later occurrence still exercises lost grant/control
ACKs, waiting approval eviction, an actual private artifact and server criterion
evidence. There are four fixture model requests total: one interrupted read plus
its resumed request, then the artifact round and final answer. Both per-run
budgets remain two; the Session counter is four. Claims are manually driven by
the test rather than the background Scheduler; model replies/hostname routing
are simulated. Real vendor inference, deployed Cloudflare lifecycle and physical
devices remain Pending.

Observed gates so far: **365 Node files / 3,029 passed / 23 existing skips**
(99.35 seconds), full Typecheck, **40 actual workerd cases** (46.05 seconds) in
an independent Cloud-only dependency fixture with no root node_modules, its
Typecheck/Wrangler dry-run, and **3 actual Node/workerd HTTP cases** (20.41
seconds). Final backend/Web/runner builds, runner self-test, Wrangler dry-run,
**16 Chromium regressions** (1.7 minutes), formatting, documentation, diff and
changed-file credential-pattern checks pass after the response-cancellation fix.
Remote CI for this increment is Pending. Public Cloud Goal creation, context admission,
full background-Scheduler/browser Goal execution, Cloud Device Nodes and Cloud
proactive GitHub workflow remain implementation work, not credential blockers.
No production changes or live-backend restart occurred. Predecessor PR #26 at
`fd906b7` has all three remote checks passing in run `39109653713`.

## Cloud Goal native execution handoff — 2026-10-18

Implemented internally: immutable DO execution grants/current slot, twelve-step
per-occurrence quota, storage-only native quiescence proof before handoff, frozen
model/tool/input/control/approval run references, grant-aware product transport,
and recovery using the same Scheduler occurrence and original submission.
Public Goal creation still selects Node Durable; no Cloud Goal API/UI rollout
is claimed. The existing Node Scheduler remains the sole business run creator.

Actual local cross-runtime acceptance uses a listening Node authority, existing
encrypted Provider, real Scheduler claim/start records, production
`executeGoalRuntimeStep`, DO/native SQLite and local Miniflare/workerd. Two
occurrences retain Root 1; the first makes bounded progress and the second waits
for an exact artifact approval. The test loses input/grant/control ACKs, retries
the original IDs, edits/Steers/cancels a queued follow-up, disposes/restarts
workerd during approval, then verifies the actual private file and criterion
evidence completing the Goal. There are three model HTTP requests: one for the
first occurrence, two for the second. The cumulative Node counter is three and
the second DO grant counter is two; restart and retries do not reset them.

**Simulation boundary:** model replies and HTTPS hostname routing are fixtures;
Scheduler claims are manually advanced by the test, not its background loop.
This is not vendor inference, deployed Cloudflare hibernation, a physical device
or a formal browser-created Cloud Goal. The full background-Scheduler/browser
flow, lossless mid-model pause, fenced Cloud stop/cancel and context-size
admission remain unfinished before public Cloud Goal selection can be enabled.
Cloud Local Node tools and proactive Cloud GitHub execution remain unfinished.

Eight new actual workerd cases exercise immutable/quota persistence across real
object eviction, prepared/busy/competing handoffs, projection-transaction rollback,
expiry without renewal, running native task identity during read-only inspection,
missing established storage, and two granted native runs retaining their input
identities. Business policy is a fixture in those eight pool cases; the separate
cross-runtime case uses actual Node authorization. Two strict wire-parity cases
compare the independent Worker and Node parsers. Additional real SQLite/private
HTTP cases deny old-control authority under a newer run and prove that reading
an unprovisioned Goal does not mint grants or open either executor.

Initial new-test failures were corrected without weakening checks: a hand-made
Session fixture omitted its transcript chat row; the approval feature flag was
missing; a private approval wake used the wrong request field; and a negative
provisioning response needed consumption before eviction. The administrative PoC
abort endpoint now returns the SDK's actual `aborted` value: an unknown input
cannot be reported as aborted. Formal product exact-task Abort remains fenced
by its existing immutable control receipt.

Validation commands: `make typecheck`, `npm test -- --run`,
`npm --prefix apps/cloud-agent run typecheck`,
`npm --prefix apps/cloud-agent test`, `npm run test:cloud-authority`,
`npm run build:all`, `npm run self-test:agent-runner`, and the existing browser
suite with this environment's system Chromium/FFmpeg configuration.

Observed final local gates so far: **365 Node files / 3,027 passed / 23 existing
skips** (97.68 seconds), full Typecheck, backend/Web/runner builds and runner
self-test, **35 actual workerd cases** and **3 actual Node/workerd HTTP cases**
(18.16 seconds). The independent Cloud-only dependency fixture, with no root
node_modules, passes Typecheck, all 35 workerd cases and Wrangler dry-run.
**16 Chromium cases pass** (1.6 minutes), including existing Cloud Session/approval
SIGKILL and multi-client regression. Formatting, documentation and changed-file
credential-pattern checks pass. Remote CI for this increment is still Pending.

Predecessor PR #25 at `8cefaf5` has all three remote checks passing in run
`39106141222`; earlier red runs below remain historical evidence. No live backend
was restarted, no main merge/push occurred and no production resource was created.

## Cloud Goal grant ledger — 2026-10-18

Implemented in the backend: new-Goal-only Cloud ownership, immutable per-TaskRun
execution grants, full frozen-context proof, shared existing Goal run/model
budgets, atomic model-attempt associations, managed private HTTP validation and
Goal-scoped artifact evidence. Existing public Goal creation remains Node-based;
the Worker/Scheduler managed-Goal handoff and Cloud Goal UI are unfinished.

Observed focused acceptance: **18 cases / 2 files** pass with actual SQLite,
existing Scheduler claims, encrypted Provider and local HTTP/SSE. They include
parallel requests capped at 12, duplicate admission, rollback after an injected
association failure, lease takeover, deadline expiry without renewal,
pause/cancel/Host revocation, original input proofs and actual private-file
evidence completing a Goal. An actual child-process SIGKILL after attempt commit
but before its receipt is followed by a fresh process: the same grant/counters
survive, and the original attempt is refused without a new charge. This proves
the grant ledger's crash boundary, **not** native Cloud Goal checkpoint recovery.
The interrupted attempt retains `started` (outcome unknown); it is not reported
as a completed model request. Model text and trusted DO tool-intent IDs are fixtures; no vendor call or native Cloud Goal execution is claimed. The existing Scheduler transaction and database unique index also reject overlapping execution attempts through running, expired-lease and retry-wait states; those safety constraints remain intact.

The v78 migration case verifies an integrity-checked private backup of the exact
old admission trigger and no new grant tables, unchanged Cloud binding bytes/
model counter/DO Root and JSONL identity, plus no new backup on second startup.
Complete local gates pass: **364 Node files / 3,023 passed / 23 existing skips**
(88.52 seconds), full Typecheck, backend/Web/runner builds and runner self-test,
**25 actual workerd tests**, **2 actual Node/workerd HTTP cases** (51.70 seconds)
and **16 Chromium cases** (2.4 minutes). An initial schema-head assertion still
expected v78; it was updated alongside the verified migration. A shared-resource
run also timed out one existing HTTP case while browser/build workloads ran;
the final complete regression passes without changing its timeout or checks.
The independent Cloud-only dependency fixture also passes Typecheck, all 25
workerd cases and Wrangler dry-run with no root node_modules. Cloud production
dependency audit reports zero vulnerabilities at all severities. Formatting,
documentation and credential-pattern checks pass. Remote CI for this increment
is Pending. Actual Cloud deployment, vendor inference and physical devices remain
Pending; no production configuration was changed.

The initial remote `a3c7a12` run passed the independent Worker job but failed the
cross-runtime gap check: it polled asynchronous result completion with Vitest's
implicit one-second limit after only the admission ACK. The regression now gates
the actual result callback, proves the original input remains `submitted`, then
awaits the real Node HTTP commit and checks `completed` plus the same IDs. Both
cross-runtime cases pass again (39.89 seconds). Neither runtime limits nor the
suite's overall timeout changed. That test-only fix still timed out remotely at
`d3af4f3`; the following deterministic runtime regression explains the remaining
failure rather than treating another retry as success.

### Result-projection lost wake

A real workerd fault test completes a native input after `projectResults` has
finished scanning but before Lifecycle applies its old job outcome. With the
old get-if-missing wake, the test fails: the input is done, but neither a result
receipt nor another projection job exists. The fixed implementation upserts the
same idempotent projection job through the public Agents 0.28.1 queue, so its
new wake supersedes the old in-flight completion. The owner's operation mutex
serializes projections; existing retry backoff and the eight-attempt bound
remain. Native prompts, tool effects and Harness wake jobs are not replayed or
altered. This is a metadata outbox repair, not a new business scheduler.

Red/green evidence is recorded by that exact fault: it fails before the fix and
passes after it, delivering the same native input with one model request. All
**27 existing/updated runtime workerd cases** pass. Test fixture delivery counts
now scope by Session, so a legitimate late receipt from an earlier case cannot
be mistaken for a duplicate in the current one. Actual Node/workerd HTTP passes
**2 cases / 20.23 seconds** with the same overall deadline. All **16 Chromium
cases / 1.7 minutes** pass again. Remote verification of this runtime fix is
Pending.

Each result now persists its next retry time. An early projection wake is tested
without another HTTP attempt or budget charge; an actual eviction preserves
the original retry/result receipt. The additive metadata-column upgrade is
tested against completed native work: Root history, original input IDs and
receipt bytes remain unchanged, with no extra model request. The Cloud-only
dependency fixture passes Typecheck/all 27 cases/dry-run with no root modules.

## Cloud exact-content approval recovery — 2026-10-18

Implemented: frozen opt-in artifact capability, original task/approval memos,
existing exact-content consent and private-artifact effect reconciliation,
persistent approval/receipt waits, closed in-memory execution while waiting,
one-minute Alarm/lost-wake recovery, Queue/Steer while paused, exact Abort fences,
late-event CAS and finite receipt retry/blocked state. No original prompt is
reposted. A resume guard spans Pi generation handover until the Root is idle.

Observed local evidence:

- **25 actual workerd cases** pass. Policy/model/effect ledgers in that pool are
  fixtures; native SQLite/Task/memo/eviction/Alarm execution is real. New faults
  cover waiting eviction, lost effect ACK before the tool checkpoint, a later
  model interruption after generation handover, denial, paused Queue/Steer and
  Abort followed by a late approval. A broken pre-reset stub failed the first
  Alarm attempt; using a fresh stub, as production routing already does, passes.
- **362 Node files / 3,005 passed / 23 existing skips** (102.89 seconds), including
  real exact-content file effects, changed generation/call rejection, expiry,
  missing association, partial-file `uncertain`, the pending Abort fence and
  authorization expiry after an actual file effect (no automatic rewrite).
- Existing actual Node/workerd HTTP suites: **2 passed**, covering Session
  controls/input handoff and Memory consent/audit; model responses are fixtures.
- The two Cloud Chromium cases pass (1.6 minutes). The new product case uses
  real Cookie APIs, certificate-verified HTTPS, encrypted Provider, DO/product
  SQLite and actual private file creation. It kills only its own Node process
  with SIGKILL before phone approval, then kills disposable workerd after Node
  committed the effect but before the native tool received its receipt. Alarm
  recovery preserves submission/tool IDs, the same file inode/exact content,
  one approval and two model requests. Repeating the decision adds no effect.

Complete local gates pass: full Typecheck, backend/Web/runner builds, runner
self-test, Electron Typecheck/bundles, **16 Chromium cases / 1.7 minutes**, and
Cloud-only Typecheck/**25 workerd cases**/dry-run with no root dependencies.
Production Cloud dependency audit reports **0 vulnerabilities at all severities**.
Remote CI at `e30cef8` passed all three jobs in run `39103092290`.
Vendor inference, deployed Cloudflare hibernation/billing
and physical devices remain unverified. Cloud Goal, Device tool routing and
proactive Cloud workflows remain unfinished. Overall Goal completion is not
claimed, and no production resources were changed.

## Cloud Memory tool bridge — 2026-10-18

Implemented behind explicit new-Session capability plus Node rollout flags:
read-only Personal Memory through the signed Tool Gateway, native memo-bound
intent, current owner/Workspace/Host/Provider policy, per-item revision grants,
provenance and original read auditing. Existing Cloud bindings remain unchanged.
Models cannot advertise an extra tool or choose another endpoint, user, Workspace
or native task identity. Source revocation affects new reads, not past history.

Observed: actual Node authority/Memory tests pass; actual Node/workerd HTTP
integration passes **2 cases**, including full process persistence and recall
after grant revocation. Its interrupted singleflight delivery recovers on the
official 30-second hung timeout/Alarm. A workerd fault case preserves the original
input and exact tool task/memo across termination, then returns an empty read
after revocation. Model output and policy fixtures remain simulated; no vendor,
Cloudflare account or physical-device result is claimed.

Full local gates pass: **362 Node files / 3,001 tests / 23 existing skips**
(107.52 seconds), complete Typecheck and backend/Web/runner builds,
**20 actual workerd cases**, **2 actual cross-runtime HTTP cases** (42.54 seconds),
**15 Chromium cases** (1.2 minutes), formatting and documentation checks. The
Cloud-only source fixture, with no root dependencies installed, also passes its
Typecheck/20 tests/dry-run. The legacy-binding test consumes all DO HTTP response
bodies before eviction; leaving them unread held the test request lifetime and
caused a timeout. The native unavailable-tool diagnostic is asserted, and no
unauthorized Memory gateway call occurs. Remote CI at `814a78c` passed all three
jobs in run `39100333015`.
Cloud Goal/Device/proactive bridges remain unfinished; the newer section records
the subsequent approval work.

## Formal Cloud Session pilot — 2026-10-18

Implemented: explicit opt-in product Session selection, immutable provisioning,
existing authenticated message dispatch, native Queue controls/Steer/exact Abort,
read-only authoritative history and persistent result projection. New admission
flags do not reassign old Sessions. This remains a hybrid product-authority
pilot, not a Cloudflare deployment or a completed Cloud Personal Agent.

Observed local acceptance:

- Actual workerd: **18 passed**, including SQLite/native tool execution,
  original-input recovery, duplicate/racing submissions, forged scopes, timeout/
  budget limits, actual eviction/Alarm, interrupted model transport and SSE.
  New cases cover a lost result ACK retried by Alarm after eviction **and grant
  expiry**, plus expired interrupted history without model restart. An expired
  pre-native admission gap quiesces its Alarm without losing the original intent
  or calling a model. An extra native conversation is refused before Harness-wide
  activation; Subagent/fork authority is not implicitly inherited by this pilot.
- A red/green regression proves concurrent history reads leave a live native
  task `running`. Reintroducing a paused `Harness.open()` made the assertion fail
  (`running` task disappeared from that scan); the Storage-only reader passes.
  Even paused Harness creation performs task reconciliation and is unsuitable
  for reading beside the execution owner. A separate read adapter also avoids
  lock inversion with the executor's queued storage transactions.
- Actual Node authority: **12 passed**, using real SQLite/encrypted Provider and
  local HTTP. The new late-result case denies fresh execution after expiry,
  accepts authorized read/result delivery, deduplicates its answer, rejects a
  changed result and refuses a result from another Session.
- Actual cross-runtime integration: **1 passed, 5.30 seconds test time**. It now
  drives existing Cookie-authenticated product APIs, not just internal callbacks.
  Creation retries preserve the same Session after admission closes; changed
  runtime under the same key conflicts. A lost input ACK still completes through
  the DO outbox without any Session client/stream attached. A second authenticated
  client reads the identical snapshot. Workerd disk restart preserves ownership,
  native submission and transcript without another model invocation.
- That same integration holds a real HTTP provider request while two clients
  edit/reorder/Steer/cancel a shared native queue. It loses a control ACK, disposes
  workerd, reads the committed edit in a new instance and reconciles the original
  control. Exact Abort settles only the captured generation. Pi 1.3.0 retains
  unrelated follow-ups after Abort; a **new explicit user instruction** advances
  those same queued submissions. Retrying the old Abort cannot cancel that new
  generation. No original prompt is manufactured as recovery, and no Node
  Harness file is created for the Cloud Session. A persisted Node-only admission
  gap is retained during pre-HTTP startup, then handed off exactly once only after
  the business authority is listening; recovery preserves its original product ID.

Model responses and test-only HTTPS hostname routing remain **simulated**. The
Cookie authentication, Node HTTP/SQLite/encryption, workerd lifecycle/SQLite,
native tools, disk restart and original-receipt reconciliation are real local
infrastructure. Workerd emits expected lifecycle errors when revoked startup is
injected; this is not a successful revoked execution.

Full local gates: `make typecheck`, **361 Node files / 2,998 passed / 23 existing
skips** (81.98 seconds), backend/Web/runner builds, runner self-test, Electron
Typecheck/bundles, Cloud Typecheck/dry-run, production dependency audit (**0 at
all severities**) and **15 Chromium cases / 1.2 minutes** passed. The initial
browser command omitted the saved Playwright cache path, causing FFmpeg lookup
failures; restoring the system encoder/cache resolved these without changing
assertions. CI installs the Cloud lockfile and bundles it before browser tests.

Independent-install regression: PR #22's first remote Cloud-only Typecheck
failed because a backend SDK wrapper resolved packages from the repository root.
The fix shares only a package-free Queue core; each host retains its own SDK
transaction. A clean disposable source directory with **no root `node_modules`**
passes Cloud Typecheck, **18 workerd tests** and Wrangler dry-run (2,503.24 KiB /
444.18 KiB gzip). A protocol parity test preserves the existing Node Zod schema
and exact receipt serialization, including invalid/boundary inputs. The full
Node regression after extraction passes **362 files / 2,999 tests / 23 existing
skips** (118.27 seconds); actual cross-runtime HTTP integration, full Typecheck/
builds and all **15 Chromium cases** (1.2 minutes) also pass after extraction.
These local results do not retroactively make the failed remote CI run pass.

The added browser case uses actual desktop/touch Chromium contexts with separate
logins, the product APIs, a certificate-verified local HTTPS Worker listener,
real native tool output and encrypted Provider configuration. Desktop closes,
mobile goes offline, and product SQLite records both inputs completed through
the durable outbox. After full Node/workerd restart with admission off, the phone
reads the same native submission IDs and one result, with no extra model call.
Only its model output and Worker-to-local-authority service routing are fixtures;
this does not establish physical iOS behavior or production cloud hibernation.

Actual Cloudflare account deployment, production hibernation/billing, the
requested Zen model and physical phone/device acceptance remain **Pending**.
Cloud Goal/Scheduler handoff, approvals, Personal Memory/Device tool bridge and
proactive Cloud delivery remain **unimplemented**, with admission refused rather
than a local fallback. No overall Goal completion is claimed.

## Cloud product authority foundation — 2026-10-17

Schema v78 adds internal immutable Cloud ownership and bounded model-attempt
receipts. Node Harness/recovery cannot execute those placements. Product-mode
Workers call the existing Node authority before opening/resuming and before
models/tools; model credentials remain in the encrypted Provider store.
Each product input is checked against the full original product payload digest,
request/mode, acknowledged native ID and terminal state before admission and
resume. Missing product intent or an acknowledged native checkpoint blocks work;
no new prompt is manufactured. Even a warm object rechecks policy before reads.
A first valid callback binds the actual DO ID, with idempotent compare-and-set;
competing objects cannot receive authority. Product models/inputs require
`ready` state and exact Root 1; both the store API and SQL trigger reject any
other Cloud conversation binding. Public Cloud admission/dispatch,
Goal integration, product projection and Cloud-to-Local tools remain **Pending**.

Observed local evidence:

- Actual workerd suite: **13 passed, 11.13 seconds**, including product-mode
  factory/tool policy and revoked resume. The boundary policy fixture is
  simulated; it is supplemented by the real authority integration below.
- A further real fault test reproduced a startup ordering defect: one original
  admission gap had created a native Submission before a later corrupt receipt
  was rejected. Recovery now verifies all product/native bindings and then all digest
  documents while the factory remains paused. Only its persisted Lifecycle job
  admits an original gap after startup, through PiHarness's native-wake API. The complete rerun passes with
  **zero new submissions and zero model calls** for that injected mismatch.
- A runtime-only wake is persisted before each new intent, covering the gap
  before PiHarness installs its own wake. Another real workerd case evicts at
  that boundary, advances its actual Alarm without a Session client reconnect,
  observes the original model execution, verifies a single original user entry
  and native ID, and confirms a duplicate wake does not invoke the model again.
  Recovery writes its verified native ID back and freezes that binding.
- New Node authority suite: **11 passed**, plus the explicit schema-version
  head checks (**13 focused checks passed**). It uses actual product SQLite,
  encrypted Provider configuration and local HTTP. Cases cover immutable owner/
  object identity, unauthorized/tampered scopes, live Host/Workspace revocation,
  aborting a held upstream HTTP request, duplicate attempts, persisted budgets,
  unknown fields, timeout/partial/oversized responses, transaction rollback and
  a private integrity-checked v77 backup preserving native Memory/Session IDs.
- Separate cross-runtime integration: **1 passed, 2.68 seconds**. Actual workerd
  calls an actual Node HTTP authority, which resolves the real encrypted
  product Provider record and calls a deterministic local HTTP model fixture.
  The real Cloud read-only tool computes a random nonce's hash; the fixture's
  second model request contains that actual tool result. No vendor key enters
  the Worker binding or snapshot. Full workerd disposal/restart preserves the
  original DO, conversation, submission and transcript with admission disabled;
  a second restart after live Host revocation denies activation without another
  model request. A warm-object read is also denied immediately after revocation.
  Removing the real product intent from a disposable store blocks a further
  workerd restart without any model replay. Node creates no local Harness file
  for this product Session.
- Initial integration failures exposed Miniflare 5's new constructor and
  persistence contracts: the official exported v4 conversion helper plus
  current `resourcePersistencePath` are required. The real disk-restart assertion
  caught an ignored legacy persistence option. Corrected receipt parsing also
  uses the public nested receipt and its verified native submission ID. No test
  was skipped and timeout limits were retained.
- Complete Node Vitest: **361 files / 2,997 passed / 23 existing skips**,
  80.97 seconds. `make typecheck`, backend/Web/runner builds, runner self-test,
  Electron Typecheck/bundles, Cloud Typecheck/dry-run and **14 Chromium cases /
  1.1 minutes** passed. The first broad run caught the intentionally pinned
  v77 schema assertion; it now explicitly reviews v78 alongside its migration
  and backup test. A docs gate also required indexing the new private route.

Production dependency audit initially reported the `tsx`/`esbuild` chain for
GHSA-67mh-4wv8-2f99. Only the Cloud CLI's pinned `tsx` version changed, from
4.19.0 to 4.23.15; 27 obsolete lock entries were removed, and no SDK version
changed. Its frozen install, Typecheck, 13 workerd cases, dry-run and actual
Node authority integration were rerun. Final production audit reports **0
vulnerabilities at every severity**; CI now enforces the High/Critical gate.
The staging CLI honors inherited proxy policy and still exits 2/Pending with
missing secure deployment bindings before any network/model request.

The cross-runtime suite runs explicitly with `npm run test:cloud-authority`
after installing both lockfiles and building the Cloud dry-run bundle. Its
separate CI job cannot pass by omitting optional Workers dependencies.
Model output and the test-only localhost service binding remain simulated.
The OS processes, HTTP, SQLite, encryption, native tool and runtime restart
are real local infrastructure. This is not a public product UI journey,
platform hibernation, a real vendor model or deployed Cloudflare acceptance.

## Cloudflare Runtime M0/M1 — 2026-10-17

The isolated, default-disabled `apps/cloud-agent` workspace uses official
`agents@0.28.1` PiHarness/Lifecycle and Pi Durable 1.3.0. Node's schema v77,
runtime mappings, checkpoints and Scheduler are unchanged. This is a private
administrative PoC; formal product Session routing is **not implemented yet**.

Reproducible local evidence on Node 24:

- Frozen `npm ci`, Cloud Typecheck and Wrangler deployment **dry-run** passed.
  The bundle is 2,465.96 KiB / 436.62 KiB gzip. No deployment occurred.
- Actual workerd SQLite/Lifecycle tests: **9 passed, 8.46 seconds**. They cover a
  read-only tool, response-loss retry, object eviction/reinitialization, a future
  occurrence delivered by Alarm, concurrent input/deduplication, native ordered
  SSE/detach/reconnect, interrupted model recovery preserving the original
  submission, model timeout/budget exhaustion, missing checkpoint denial and
  authorization/body-size rejection. Injected object termination emits expected
  workerd reset warnings; no assertion or timeout was relaxed.
- Model SSE is served by a second actual workerd Worker, using a test-only
  synthetic credential. This proves the Runtime/HTTP boundary, **not real model
  inference**. It does not establish physical devices or Cloudflare deployment.
- Existing Node `make typecheck` passed. The complete Node Vitest suite passed:
  **360 files / 2,986 passed / 23 existing skips**, 83.28 seconds. Cloud tests run
  in a separate workerd CI job; the Node pool does not attempt to emulate them.
- Staging live entry exits **2 / Pending** before network access because secure
  origin/signing/provider bindings are absent. Real Cloudflare model execution,
  platform hibernation, account resource limits and deployment remain Pending.

See [cloud-runtime-decision.md](cloud-runtime-decision.md) for inspected source
versions and explicitly inaccessible articles; [cloudflare-deployment.md](cloudflare-deployment.md)
documents the local/live distinction, private signing, migrations and rollback.
Formal product routing, live ACL/provider authority, Cloud Goals/approvals,
Cloud-to-Local Node tools and proactive Cloud workflows remain subsequent work.

## Paired finite-file Device Nodes — 2026-10-17

Implemented optional pairing/identity approval, separate expiring Workspace/path
read grants, heartbeat, revocation, native ToolTask memo-bound dispatch, private
local Node read receipts and server-authoritative device wait snapshots. The
existing Scheduler still owns the Goal Run, lease and budget. No second business
queue, general device access or data-location fallback was added.

Final local evidence:

- Full Vitest **360 files / 2,986 passed / 23 existing skips**, 106.60 seconds.
  New device store/route and local filesystem tests: **13 passed**; the final
  focused rerun includes a real native Memory item preserved by v76 upgrade and
  its private integrity-checked pre-upgrade backup.
- Complete Chromium **14 passed, 1.3 minutes**, after fresh backend/Web/runner
  builds. The new product journey uses two independent desktop/mobile logins,
  actual pairing pages, a separate local Node process and a random nonce stored
  only in the Node's file. It drops the committed pair-ticket response and retries
  the same key, separately approves identity/grants a file, waits offline,
  detaches, pauses/resumes without losing the original intent, intercepts the
  result, SIGKILLs Node and Gateway, modifies the source, then recovers the same
  Run, conversation, submission, command/memo and original cached file bytes.
  Mobile approval creates the actual artifact and completion/outbox delivery;
  charge stays one. Node logs and Gateway audit contain no nonce/credentials.
- `make typecheck`, backend/Web/runner Build, runner self-test, Electron typecheck
  and bundles, docs/Prettier/diff and changed-file credential-pattern scan passed.
  Three initial old Goal mock cases lacked the new device availability/list
  responses, causing an extra Not Found alert. Explicit disabled/empty fixture
  routes fixed this; assertions, timeouts and skips were unchanged. The complete
  rerun passes all original and new browser cases.

**Real infrastructure:** OS SIGKILL/restart, native Harness checkpoints, SQLite,
files, independent CLI Node process, product Cookie/node authorization, read
receipts, artifact approval and owned Session/workspace delivery. **Simulated:**
HTTP model output and explicitly expired disposable lease clocks, plus the old
mock-only UI fixtures. **Unverified:** real vendor model, physical mobile/PWA/
Electron device lifecycle, macOS file semantics, public TLS/network deployment,
external IM delivery, production migration/restore and power loss. **Not
implemented:** device writes/apps/browser/remote desktop, general external-write
tools, session branching and full Skills/MCP/OAuth/Docker Durable parity.

The configured-model live entry was rerun with the requested Zen endpoint and
`cat-jam-free`; it exits **2 / Pending**, `secure_environment_binding_missing`
for `MINICLAW_ZEN_API_KEY`, before inference. Current environment status still has
no runtime/secret bindings and has restricted network policy; its saved draft is
not proof of active bindings or outbound access. No chat credential was copied,
model substituted, production service changed or full Goal completion claimed.

See [device-nodes.md](device-nodes.md) for the implemented boundary and replay/
revocation limits, and [migration.md](migration.md) for v77 rollback requirements.

## Explicit Personal Memory — 2026-10-17

The Personal Memory increment reuses native Home Memory items, revisions,
provenance, tombstones and mutation receipts. It adds explicit user-confirmed
promotion, immutable source lineage, destination/revision grants and digest-only
read audit. The new `read_personal_memory` tool uses the actual Session binding;
it does not merge workspace memories or provide an agent write tool.

Executed evidence so far:

- New Personal Memory route/store tests: **10 passed**. Related Goal/runtime/
  approval/GitHub/migration regression: **7 files / 51 passed**.
- Focused compiled-product browser case: **passed, 38.9 seconds**. It reads a
  verified completed-Goal artifact, explicitly selects an excerpt, injects loss
  of the committed creation response and retries the identical key, restarts
  the actual service, opens a distinct Session and checks that the provider's
  actual tool-result message contains the new Memory ID and source fact. The
  persistent read audit contains IDs/revisions/digests without the raw fact.
- The same case temporarily removes the source owner's Host role in its
  disposable database: source capture is denied without returning artifact text,
  and succeeds only after privilege is restored.
- Initial browser failures found ambiguous nested labels for a select and a
  populated textarea. Explicit accessible names fixed both; assertions and
  timeout limits were retained.

Final local gates passed: `make typecheck`, complete backend/Web/runner build,
**358 files / 2,973 passed / 23 existing skips** in 81.51 seconds, **13 default
Chromium cases passed** in 51.3 seconds, and runner self-test. No new skip or
weakened assertion was added. The complete run includes the source-role denial,
unknown-response retry and independent-Session Memory proof above.
The browser model remains a local simulation; OS processes, APIs, authorization,
database/files and actual Memory data flow are real. No live-model acceptance,
physical-device result or retroactive transcript erasure is claimed.

## Signed GitHub event workflow — 2026-10-17

The opt-in workflow routes signed GitHub CI/PR events through the existing
managed Goal, Scheduler, Pi Durable, approval, artifact and workspace delivery
path. It adds no scheduling loop. Live `main` remains
`3ff1c8d6a0707f4a9f0957ff411758e5e141583a`; PR #2 remains at `a299a76`
and unmerged. Draft PRs #3–#16 had green validate results when rechecked before
this increment. Installed/current npm Durable remains
`@earendil-works/pi-durable@1.3.0`; no SDK dependency changed.

Executed locally on Node 24:

- `make typecheck`: passed, including backend, personal-agent fixtures, Web,
  browser fixtures, runner, generated sources, prompts and documentation.
- `npm run build:all`: passed for backend, Web and agent runner. Existing Web
  chunk-size warnings remain; they were not disabled.
- `npm test -- --run --maxWorkers=3`: **357 files / 2,963 passed / 23 skipped**,
  159.07 seconds. No skip was added by this increment.
- System Chromium/FFmpeg default Playwright suite: **13 passed**, 1.4 minutes.
  The extended product case uses independent authenticated desktop/mobile-sized
  browser contexts, compiled production backend, real temporary databases/files
  and actual SIGKILL/restart. It creates a subscription through the page, signs
  a fixture event, observes its Goal at approval wait, restarts the service,
  verifies the original conversation/submission/approval/run, deduplicates both
  delivery and semantic replay, approves on mobile, and checks completion, one
  charged run, successful workspace delivery and subscription cancellation.
- Agent runner self-test: passed.
- A final Web build and browser-fixture typecheck also passed after making open
  event receipts refresh from server snapshots. The focused production browser
  case passed again in **35.4 seconds**, including observing a new event without
  re-clicking the receipt button; no extra skip or weakened assertion was added.
- `tests/github-goals.test.ts`: 13 cases in the full suite cover HMAC and fresh
  account/workspace/Host checks, explicit signing-reference capability grants,
  grant revocation/malformed policy, filters, request/delivery identity conflicts,
  budget/cooldown suppression, DB reopen, atomic admission rollback, cancellation,
  approval revocation, late-result fencing, suppression of an already claimed
  notification, cleanup without replay, and private v74 backup integrity with
  unchanged Goal/Session/run IDs.

OS processes, database/file writes, HTTP routes, authentication, browser actions
and fault injection above are real. Model responses and GitHub event delivery
are simulated local fixtures; the browser scenario explicitly advances only its
disposable Scheduler lease clock. This does not establish real GitHub delivery,
physical-device or natural-lease live-model acceptance. Migration/backup tests
used only disposable data.

Re-running `npm run test:personal-agent-live` with the authorized nonsecret Zen
URL/model still exits **2 / Pending** with
`secure_environment_binding_missing: MINICLAW_ZEN_API_KEY`. No external model
inference was attempted and no alternative model substituted. The environment
draft declares the secure requirement, but the running instance has no ready
binding. No plaintext chat credential was copied into commands, source or logs.

Unverified: live GitHub endpoint delivery, real configured-model inference and
natural-lease recovery, physical iOS/PWA/Electron devices, external IM delivery
and production migration/restore. Unimplemented in this increment: automatic
GitHub log fetching/repair PRs, cross-task Personal Memory and paired Device Nodes.
The overall Personal Agent Goal is not complete.

## Goal → Scheduler → Durable → approval → evidence

The Goal follow-up connects the existing product flow rather than a separate demo endpoint: signed `POST /api/goals` atomically creates Goal/task/Session, the existing Scheduler freezes and owns the occurrence, and the formal Durable Session executes the original Inbox input. Model/provider configuration remains the existing encrypted product configuration. Schema v73 and the reclaim rule must ship together with this dispatcher.

Local gates passed: `make typecheck`, `npm run build:all`, Runner self-test and Electron typecheck/main/preload bundles. Full Vitest passed **352 files, 2,936 tests, 23 skipped** (exit 0); Chromium passed **13 tests** (exit 0). Logs: `/tmp/miniclaw-goal-durable-{typecheck,build,vitest,e2e,runner,electron}.log`. The browser fixture has a separate checked TypeScript configuration. No live provider is included in these counts.

The browser case creates one Goal through the desktop page, joins that Session from an independent mobile login, closes the desktop page, SIGKILLs the actual backend executor, restarts with the new-Session flag off and checks the original conversation/submission/approval IDs. Mobile then approves, reads the verified artifact, and observes Goal completion plus successful existing outbox delivery. This is one simulated-model Goal journey, not a collection of unrelated mock endpoints. It also exercises an existing populated desktop Session cache, which previously discarded the new Goal link before refreshing it.

The real product HTTP case now verifies automatic Goal provisioning, frozen context, actual workspace file reads, Goal/run-bound consent, SIGKILL of the actual backend executor, recovery of the same TaskRun/conversation/submission/approval, pause/continue without a second run charge, exact artifact verification, literal completion and existing outbox delivery receipts. Natural-language completion stops for explicit user confirmation with verified evidence. A simulated model that repeatedly asks for a file tool is bounded to at most 12 actual local HTTP model requests and one run charge. Provider output is simulated; OS processes, HTTP authentication, Scheduler, Harness, SQLite, file effects and delivery projection are real. Only the disposable lease clock is advanced to exercise takeover without waiting 60 seconds.

Thirteen real SQLite store cases cover atomic provisioning rollback/idempotency, frozen Goal revision, stale lease fencing, trusted started-run recovery without double charging, local executor claim binding, pause/reclaim, unchanged legacy/manual behavior, immutable Goal ownership after link loss, cancelled/expired consent, in-progress Host revocation, cross-owner outbox suppression and private pre-v73 backup without automatic promotion of old task links. These are infrastructure tests, not model acceptance. A fixture initially mixed two SQLite libraries on the same open database; using the product's driver for same-process probes avoids invalid WAL-lock interactions. Cross-process fault injection remains separate.

The HTTP fault suite additionally injects a product completion receipt ahead of an unsettled checkpoint; recovery blocks it before any new model request while an independent Session recovers. Actual Linux FIFO and outside-workspace hard-link reads are rejected through the real tool path without blocking the service or exposing the outside content. Required provider lookup rejects a missing identity in one configuration read; it preserves the existing policy that explicitly selected disabled providers remain selectable.

Failures found and fixed by integration: missing chat-container creation inside Goal provisioning; the legacy Goal-state gate rejecting an already-charged approval wait during recovery; and Scheduler lookup using a stale process workspace cache after first-time setup. Current code resolves managed Goal ownership from the database and requires a live started claim in the executing process before Harness activation. Stale or unbound executors cannot activate it.

Approval [Draft PR #6](https://github.com/helsome/OpenDot/pull/6), commit `0914ca7`, passed actual GitHub CI [run 38910266533](https://github.com/helsome/OpenDot/actions/runs/38910266533). Main is unchanged. Goal follow-up CI is separate from that result.

## Controlled artifact approval follow-up

Schema v72 and the formal tool/API/UI now support exact-content private-artifact approval. Full Vitest passed **351 files, 2,922 tests, 23 skipped** (exit 0), Typecheck/Build passed, and all **13 Chromium E2E tests** passed. Logs: `/tmp/miniclaw-product-approval-{typecheck,build,vitest,e2e,tests}.log`. The browser case adds actual mobile approval, desktop state convergence and verified artifact reads against the compiled backend. Product HTTP recovery now SIGKILLs while awaiting approval, restarts on the original input/tool intent, rejects a changed digest and accepts two concurrent approvals with one actual file effect. The local provider remains simulated.

Five focused tests check owner/parameter/decision binding, persisted pending consent, a post-effect receipt gap without file rewrite, partial effects becoming uncertain, current authorization before writes, and a private pre-v72 migration backup. An additional `product-artifact-recovery.test.ts` SIGKILLs an actual process immediately after file fsync but before the receipt; a fresh process reconciles the same file inode/mtime and completes one receipt. The exception seam also remains covered. These are process-crash tests, not power-loss tests. The pending-approval case kills the actual server process. Existing Makefile backup/restore tests now round-trip a real private artifact with mode 0600. Initial HTTP fixture failure was traced to creating a Session after intentionally disabling the creation flag; the fixture now creates it while enabled and asserts its persisted runtime kind.

Foundation [Draft PR #4](https://github.com/helsome/OpenDot/pull/4), commit `77a96b6`, passed actual GitHub CI [run 38908341650](https://github.com/helsome/OpenDot/actions/runs/38908341650); its isolated archived tree also passed Typecheck and all 9 focused migration/store tests. Formal dispatch [Draft PR #5](https://github.com/helsome/OpenDot/pull/5), commit `4078084`, passed actual GitHub CI [run 38908396420](https://github.com/helsome/OpenDot/actions/runs/38908396420). These results do not establish Goal/Scheduler execution, a live external model or general external-write safety.

## Formal product Session Durable integration

The stacked product-session implementation connects the compiled product backend, authenticated Session creation, `/api/messages`, persisted runtime selection, configured provider, actual workspace read tool, and original Durable Inbox submissions. Schema v71 preserves existing JSONL/Coding identities. This is an opt-in Host Session path, not a completed Goal/Scheduler migration.

Local gates: `make typecheck`, `npm run build:all`, changed-file Prettier/docs checks, and full `npm test -- --run` passed (349 files, **2,916 passed, 23 skipped**, exit 0). The current Chromium suite passed **13 tests** (exit 0). Runner self-test, Electron typecheck and main/preload bundles passed; Electron GUI execution remains unverified. Logs are `/tmp/miniclaw-product-runtime-{typecheck,build,vitest,e2e,runner,electron}.log`; environment is Node 24.19.0, Linux, system Chromium, disposable private databases. Skipped tests remain skipped and do not count as acceptance.

`tests/product-runtime-http.test.ts` starts the actual backend process and signed authenticated HTTP APIs with a local OpenAI-compatible SSE provider. It SIGKILLs/restarts the actual executor, verifies the same conversation/submission IDs and single user/result projections, and reads a real temporary workspace file through the official Harness tool path. A second restart injects mismatched product receipts: that Session is blocked before activation while an independent Session recovers. Duration-budget expiry and user revocation stop actual held model connections, and revoked work does not restart. Duplicate creation/input IDs return the original receipt; changed payloads fail. These are real OS/HTTP/SQLite/file/authorization tests with **simulated model output**, not a real external model or physical device run.

`web/tests/e2e/product-session-continuity.spec.ts` runs the compiled server and two independent authenticated desktop/mobile browser contexts. It verifies offline/reconnect history convergence, submits through the actual chat UI, closes the desktop page while generation is held, and observes the file-tool result on mobile after release. The provider is simulated. Goal/Pocket coexistence, mobile overflow and the unpriced-usage warning are checked. Runtime snapshots are authoritative, but ordered event reconciliation, live Queue editing and complete Steer UI projection remain pending.

Store/migration tests verify immutable runtime/owner bindings, cross-owner denial, flag-independent recovery, private pre-v71 backup and preservation of JSONL Session IDs. Backup tests snapshot committed WAL state and exclude coordinators/sidecars. Adapter negative tests reject a missing bound root or foreign conversations before activation. Backup/restore was tested only with temporary data; no production restore was performed.

Pocket integration is available as [Draft PR #3](https://github.com/helsome/OpenDot/pull/3), commit `7950668`. Its actual GitHub `validate` job passed: [run 38902022615](https://github.com/helsome/OpenDot/actions/runs/38902022615). Results below describe earlier branches and are historical evidence, not CI results for the product-session changes.

## Pocket + Goal integration acceptance

`agent/pocket-integration` merges the full Pocket fix branch into `fe520f5` without changing main. GitHub's API was rechecked: PR #2 is open/unmerged, and `fe520f5` has no Check Runs or workflow runs. Those historical local results are not CI evidence.

The combined tree passed `make typecheck`, `npm run build:all`, changed-file Prettier/docs checks, and full Vitest (344 files, 2,904 passed, 23 skipped; exit 0). Chromium passed 13 tests (exit 0), including `product-session-continuity.spec.ts`, which starts the compiled product server, uses two independent authenticated browser contexts, and verifies same-Session persisted history after mobile offline/reconnect without cross-session history or duplicate messages. The same build exposes Goals and Pocket controls. Messages are seeded transcript fixtures, not a model run; live execution, Queue/Steer effects, and runtime recovery remain separate acceptance work. Local logs: `/tmp/miniclaw-pocket-integration-{typecheck,build,vitest,e2e}.log`. Environment: Node 24, Linux, system Chromium, isolated disposable database for the product browser case.

## Combined integration branch

On `agent/personal-agent-integration`, the Goal milestone and Durable ownership guard are combined without changing main. After the GC lifetime fix, full Vitest passed 343 files: **2,903 passed, 23 skipped**. `make typecheck` (including browser fixtures), `npm run build:all`, format/docs checks, 12 Chromium mobile browser tests, the 10-check real HTTP Goal demo, and the 24-test Durable runtime demo passed. Electron typecheck/bundles and Runner self-test passed on the unchanged Goal milestone components; Electron GUI/device execution remains unverified. Pocket PR #2 and its fixes remain a separate review branch and are not merged into this integration branch.

The GC fault was reproduced before fixing it: a still-live child discarded its activated Adapter, forced GC, and a contender incorrectly opened the same database. Retaining coordinator connections until explicit close fixes that case. All 6 ownership cases now pass, including real process competition and SIGKILL. These tests have no live model or tools; provider/effect responses in other Durable recovery cases remain simulated.

## Completed on the Durable pilot branch

- Official npm package metadata and package declarations were inspected for Pi Durable 1.3.0, including its Node minimum, Harness API, SQLite adapter, request ID behavior, replay rules, and experimental status.
- `npm run demo:durable-runtime`: runs 24 tests across adapter, input-ledger, process-recovery, ownership, and model-smoke suites with the ownership/GC follow-up. It exercises the actual official Harness/SQLite implementation; provider responses and the external effect service are simulated where identified below.
- `make typecheck`, `npm run build:all`, `npm run format:check`, and `npm run docs:check`: passed on the Durable pilot branch.
- Latest full Vitest run: 339 files passed; 2,877 tests passed and 23 skipped. `make typecheck` (backend, smoke scripts/runtime tests, Web, agent runner, shared types, prompts, and docs), `npm run build:all`, agent-runner self-test, and 9 current-branch Chromium mobile E2E tests passed. Browser tests cover existing mobile UI, not a live Durable multi-device flow.
- `tests/backup-restore-safety.test.ts` and `tests/makefile-runtime-contract.test.ts`: 16 tests passed, including a committed Durable WAL row round-tripped through the real Makefile backup and restore commands.
- `tests/zen-model.test.ts`: validates the configured endpoint/model contract and official Pi AI `openai-completions` model registration. These are configuration tests, not a live request.
- `tests/durable-model-smoke.test.ts`: 2 simulated-provider integration tests exercise the actual SQLite/Harness smoke chain, including exact-match failure and reading the persisted `AssistantEntry.model` content. `npm run typecheck:personal-agent`, also invoked by `make typecheck`, includes the smoke scripts and focused runtime tests; the main backend tsconfig alone excludes scripts.
- `tests/pi-durable-input-ledger.test.ts`: 4 passing cases cover persistent request/payload bindings, concurrent payload conflicts, old unverified submissions, and malformed request IDs. The host callback is deliberately a no-op so the adapter's own storage enforcement is exercised.
- `tests/pi-durable-process-recovery.test.ts`: 5 passing cases fork real Node processes, inject SIGKILL, verify signal termination, and start new processes against the original SQLite database. Cases cover before/after a simulated effect, after its checkpoint, an interrupted faux-provider request, and the payload-binding/admission gap. Task/input identity survives; no original prompt is resubmitted for provider recovery. The simulated service records two attempts and one effect for an interrupted post-effect checkpoint.
- Fresh isolated backend smoke using a temporary data directory: `/api/health` returned `healthy` with `database: true` and `queue: true`; `/` and `/api/auth/status` returned HTTP 200; SIGINT completed a clean shutdown. Existing checkout data was left untouched.

## Runtime ownership branch evidence

`agent/durable-runtime-ownership` is a separate follow-up to the Durable pilot. Its full Vitest run passed 340 files: 2,882 tests passed and 23 skipped. Full Typecheck, Build, and docs checks passed. The 5 added ownership cases run actual competing Node Adapter processes and a verified SIGKILL followed by a new owner process. They also verify coordinator permissions/stable inode, symlink aliases, hard-link rejection, initialization-failure release, and unsafe coordinator links. No model or tool is invoked. This establishes cooperative local database ownership, not production session/runtime routing, external effects, distributed failover, or complete migration.

## Pocket continuity branch evidence

On `agent/goal-mode-pocket` based on `feat/pi-pocket-continuity`: `make typecheck`, `npm run build:all`, format/docs checks, and full Vitest passed (335 files, 2,854 tests passed, 23 skipped). Mobile Chromium E2E passed (9 tests). The PR bridge and DingTalk tests were made deterministic where they previously depended on external/network output. This is browser automation, not physical iOS, live push, live model, or real Tailscale validation. See `docs/pi-pocket-port.md` on that branch for exact commands and output.

## Personal Goal engine branch evidence

`agent/personal-goal-engine` is stacked on the Durable pilot. Goal execution still uses the existing MiniClaw Scheduler and Pi Coding Agent. The optional `MINICLAW_PERSONAL_GOALS=true` feature does not connect product sessions to the experimental Durable adapter.

- Full Vitest: 342 files passed, 2,897 tests passed, 23 skipped. Goal-specific suites include 10 real SQLite store/budget tests, 8 authenticated HTTP route tests, and 2 schema-v69-to-v70 migration tests. Route tests use actual signed sessions and database records but simulate Scheduler callbacks.
- `make typecheck`, including the newly checked browser fixtures, `npm run build:all`, format/docs checks, agent-runner self-test, Electron typecheck, and Electron main/preload bundle builds passed. Electron GUI/package installation was not exercised.
- The migration tests verify the private, integrity-checked pre-migration SQLite backup, preservation of an existing task/session, and idempotent reopening. They operate only on temporary databases.
- Mobile Chromium: 12 tests passed, including 3 Goal UI tests with mocked HTTP responses. The new cases cover a lost creation receipt with the same retry key, a failed stop that leaves the server Goal paused, and a stale revision that requires reload before retry. These tests do not establish live multi-device synchronization.
- `npm run demo:personal-goals`: 10 checks passed against an actual listening compiled backend and temporary database. Unauthenticated access was denied; authenticated creation returned a stable receipt; paused/cancelled states persisted; stale revisions were rejected; an existing paused task could be linked; the real Scheduler rejected starting a paused Goal; no agent execution was created. After stopping and restarting the backend, the original signed login and cancelled Goal remained readable and health was healthy. The temporary administrator, credentials, and database were removed after a clean shutdown. No model or external channel was invoked. This is Goal metadata persistence across a clean restart, not Durable execution recovery.
- Goal scheduling reuses existing task definitions, run receipts, leases, and cancellation. Transactional tests cover a shared run budget across linked tasks, duplicate start-marker calls, exhausted budgets, paused queued work, workspace ownership revocation, and edited task scope. These checks establish local scheduling fences, not a completed long-running model task.

Reproduce the automated Goal checks with `npx vitest run tests/personal-goal-store.test.ts tests/routes-personal-goals.test.ts tests/schema-v70-personal-goals.test.ts`, `npm run build:all && npm run demo:personal-goals`, and `PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm --prefix web run test:e2e` in this cloud environment. Elsewhere, install Playwright's Chromium/FFmpeg or configure the system browser paths. See [goals-and-tasks.md](goals-and-tasks.md) for the opt-in local workflow and its limits.

## Remaining acceptance

- Real provider/model call through Pi Durable.
- Real provider timeout/interruption mid-generation; the OS-process restart boundary is covered using a faux provider.
- Real external tool interruption/reconciliation and exactly-once delivery; the local simulated idempotent service does not establish these.
- Physical two-device lifecycle, push delivery, Tailscale configuration, and Electron GUI/package execution. Two independent automated browser contexts against the real product server are covered above.
- A long-running Goal with a live external model and external channel delivery. The actual local Scheduler/HTTP/browser Goal execution and owned-workspace delivery are covered with simulated model responses above.

## Not implemented

- Complete Skills/MCP/profile-context bridging, Docker Durable execution and external channel delivery acceptance. Managed Host Goal/Scheduler dispatch and owned workspace outbox receipts are implemented above; live-model acceptance remains pending.
- General external-write approval/receipt reconciliation. Controlled private-artifact consent, wait/restart and hash reconciliation are implemented and tested above.
- Complex Goal planning, cross-task personal memory and token/currency budgets. Bounded steps, frozen context, private artifacts and literal criterion checks are implemented; semantic correctness still needs user judgement.
- Automatic GitHub log fetching/repair and live GitHub delivery acceptance. Signed event ingestion/filtering, suppression and the bounded Goal workflow are implemented in the latest section above.
- Personal Memory scope/authorization and paired/revocable device execution nodes.

Do not describe simulated tasks as a real model run or live external side effect. The goal-mode end-to-end demonstration remains pending.

The latest environment check found no `MINICLAW_ZEN_API_KEY` binding. An unauthenticated metadata read of `https://opencode.ai/zen/go/v1/models` returned HTTP 200 on 2026-10-16; its 37-model public list did not include the requested `cat-jam-free`. Listing absence alone does not prove an authenticated generation will fail. No model was silently substituted and no chat credential was copied into files, command arguments or logs. Real-model acceptance remains pending secure binding and confirmation of an available authorized model. The existing `npm run test:durable-zen-real-model` command exercises the official Harness/SQLite model chain; it has not passed a live request in this environment. npm metadata was rechecked: official Pi Durable remains 1.3.0 with Node >=22.19.0, matching the pinned dependency.

## Durable Session snapshot and ordered invalidation integration

Branch `agent/durable-session-control`, stacked on Goal execution PR #7 (commit `6cea00b`, remote validate run `38920408352` passed). The existing Pocket UI now reads actual committed Durable busy/Inbox/tool state, with approvals and Goal status in the same authorized snapshot. The existing socket transports ordered revision invalidations; clients refetch full snapshots and reject stale connection/account/Session responses. Revision is an invalidation fence, not an atomic cross-database snapshot or a model checkpoint cursor.

`tests/durable-control-client.test.tsx` verifies gaps, old HTTP fences, process epochs, disconnect, Session/account switches and denied reads using simulated HTTP responses. Product HTTP and two-login Chromium tests additionally assert actual busy-to-idle convergence around execution and original-checkpoint process restart. These tests use a simulated HTTP model provider; they do not establish real-model or physical-device acceptance. Queue edit/reorder/cancel controls and the gated proactive workflow remain pending.

Validation on this branch: full Vitest **353 files / 2,939 passed / 23 skipped**; all **13 Chromium E2E passed (36.0 s)**; `make typecheck`, backend/Web/runner builds, runner self-test, Electron typecheck/bundles, Prettier/docs checks and changed-file credential-pattern scan passed. The initial browser attempt could not start 12 video-enabled cases because the Playwright FFmpeg download was blocked (HTTP 403); rerunning with system `/usr/bin/ffmpeg` in a temporary Playwright cache preserved video capture and all assertions. Reproduce locally with `PLAYWRIGHT_BROWSERS_PATH=/tmp/miniclaw-playwright-system PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm --prefix web run test:e2e` after linking the system FFmpeg executable at that cache's `ffmpeg-1011/ffmpeg-linux`. The cache is an environment setup artifact, not a repository dependency change. No live Zen model, physical iOS device, external channel or production deployment was exercised.

## Durable Session control backend follow-up

The backend on `agent/durable-queue-controls` adds v74 immutable control intents, native receipt/Inbox commits, exact-task abort marks and canonical answer-message bindings. Recovered native controls without product intents, mismatched effective queue payloads and product abort acknowledgements ahead of an unmarked checkpoint block activation. Another administrator, wrong Workspace, forged fields, changed retry payloads and stale queue/task IDs are rejected. A cancelled queued input has an explicit cancelled disposition and no fabricated answer; shared native answers project once. Legacy Coding queue behavior is preserved.

The actual product HTTP test uses normal creation/admission/control APIs, edits/reorders/promotes/cancels queued inputs before SIGKILL, then recovers their original identities and effective content. It additionally proves a repeated old abort cannot stop a later run. The native receipt-gap worker SIGKILLs a real Node process after the edit commit and before the MiniClaw acknowledgement; the next process reconciles the same intent without editing again. No model runs in that worker. The product HTTP provider is simulated.

Twenty-two focused cases across Goal/store, product HTTP and native queue recovery passed; v73 backup/preservation and earlier-version migration fixtures are included. The separate Pocket UI follow-up adds browser controls and a per-tab pending-operation journal; its combined full-suite results are recorded separately. PR #8 (`59dd095`) passed remote validate run `38923290213`. Live model/physical-device/external-channel/production acceptance remains pending. The proactive workflow stays gated on main-chain acceptance.

The final backend review additionally fences Goal completion inside its existing transaction when a late input/control admission is pending. Scheduler retry retains the original run/checkpoint and does not charge another run. An unapplied command from an older Goal execution receives a rejected native receipt; an already committed command still reconciles its original result. The fourteen-case Goal store suite includes late-admission transaction fencing. Applied edits update an existing owned user-message projection in the same product acknowledgement transaction; original admission payloads remain immutable, and a retried original input broadcasts effective content. Per-Session request serialization keeps control acknowledgements/projections in committed order. Recovery validates both queue content and Queue/Steer mode.

## Pocket Durable controls acceptance

Backend commit `3b17d2d` is separated from `agent/pocket-durable-controls`. On the combined tree, full Vitest passed **355 files / 2,948 tests / 23 skipped** (135.18 s), and all **13 Chromium E2E passed (57.6 s)**. Full `make typecheck`, backend/Web/runner builds, runner self-test, Electron typecheck/bundles, format/docs checks and changed-file credential-pattern scan passed. Tests run on Node 24.19.0/Linux with system Chromium and FFmpeg; no tests or video assertions were removed. Initial failures were corrected: duplicate React sibling keys, a schema-head assertion not yet moved with v74, an abort fixture created after disabling the new-session flag, and the queue-gap fixture's expected manifest after adding a rejected operation.

The product browser case verifies actual queue editing, lost response, per-tab journal reload and exact-key retry, edited transcript convergence, and the existing chat Stop's exact-task receipt across another lost response/reload. Four client cases separately verify Stop retry against a later run, unknown-edit preservation, stale-target rejection without automatic retargeting and account changes. User-message updates no longer invent a second local wait. Paused/terminal Goal presentation and unknown queue state are explicit.

Real infrastructure passing: HTTP/auth/SQLite/files, real Node SIGKILL/restart, stable original receipts/checkpoints, partial-effect reconciliation, Scheduler/budget/delivery and Chromium desktop/mobile contexts. **Simulated only:** model HTTP output and the explicit client-race fixtures. **Unverified:** Zen model execution, physical iOS/Android lifecycle, external IM delivery/control history, live Tailscale, Electron GUI, production migration/restore and power loss. **Not implemented in this tranche:** branch creation, general external-write tools, the gated proactive workflow, personal/device expansion and full Skills/MCP/OAuth/Docker Durable support. Secure Zen environment binding remains absent; the public list did not contain `cat-jam-free`, which is not evidence of authenticated generation failure. No model was substituted and no full Goal completion is claimed.

## Live formal-page acceptance entry point (Pending execution)

`npm run test:personal-agent-live` validates the explicit Zen environment, builds the current backend/Web/runner with a credential-free build environment, then runs the dedicated `web/playwright.live.config.ts` scenario against an isolated compiled production backend. The desktop creates a real Goal through the normal page, detaches, and the mobile browser context submits Steer. The scenario kills the actual executor, waits for **natural lease expiry without clock injection**, checks original Goal/run/conversation/input/approval identities, approves only the exact random proof read from its workspace file, verifies one actual artifact and workspace delivery, then inspects committed real tool results after a clean stop. It uses the existing encrypted Provider API and authorization path. A single Goal run retains the existing model-step limit; no alternate model is selected.

This is a dedicated explicit live command, not a skipped test counted in the deterministic suite. `.live.ts` files are selected by its Playwright config; the normal browser suite remains unchanged. Network traces, screenshots and video are disabled for this credential-bearing run. All runner output files live under a private temporary report directory and are removed; only a safe result DTO is printed, never raw provider/client errors, credentials, cookie headers or model text. Actual model/browser execution is **unverified** until it runs with authorized environment bindings. Two preflight unit cases cover missing secure binding (exit 2 / Pending) and invalid endpoint failure without printing the fixture credential; these are configuration checks only.

Observed command on this environment, with the requested URL and `cat-jam-free` supplied as nonsecret environment values: **exit 2**, `status: pending`, `reason: secure_environment_binding_missing`, `missing: [MINICLAW_ZEN_API_KEY]`. No external model call or live browser was started. The previously pasted token was not copied into commands, source, artifacts or logs. PR #9 (`3b17d2d`) passed actual GitHub validate run `38929337590` (9m11s); PR #10 (`7e77178`) passed run `38929466067` (9m47s). Those results cover the committed deterministic product implementation, not this unexecuted live scenario.

Live-entry follow-up local regression: **356 files / 2,950 passed / 23 skipped** (85.87 s), including the two preflight-only cases. Existing default product/browser behavior remains covered by the 13-case CI-passing Pocket suite above; the new `.live.ts` body has not executed. Complete typecheck includes the live page scenario, CLI and preflight tests. A separate discovery check selects exactly the dedicated live case. These checks do not establish live-model success.

## Cloud Handoff lifecycle prerequisite (#34; admission closed)

The follow-up to Cloud Team foundation #40 implements registered-owner stop and
explicit checkpoint resume for Handoff bindings. Stop-only proofs remain valid
after Host execution revocation but grant no execution/read authority. Resume
requires full live product policy and the exact pending Handoff revision. A
one-row additive DO SQLite intent persists monotonic control identity, attempts
and backoff. Stop state and fence commit atomically; a durable Lifecycle wake
precedes reopening the original checkpoint. No new prompt/input/Submission or
business Scheduler is created. Node schema remains 81; public Cloud Group
admission remains disabled. See [Cloud Bot Team integration](cloud-bot-teams.md).

Frozen local regression: **378 Node files / 3,095 passed / 23 existing skips**
(130.32 s), **49 workerd cases passed** without skips (228.86 s), **3 actual
Node/workerd authority integrations passed** (23.18 s), and **22 browser E2E
passed** (4.7 min). Backend/Web/runner, Cloud and Electron typechecks, all builds,
Cloud dry-run bundle, Electron bundles, runner self-test, format/docs and
changed-file credential-pattern checks passed. No dependencies or lockfiles
changed. PR #40 itself passed all three remote jobs in run `39131518541`;
that earlier run does not validate this follow-up commit.

The new actual workerd cases prove the original Submission/GenerationTask after
pause/read/eviction, duplicate/lost resume ACK and persisted-intent-before-native
activation recovery. Natural Alarms use the unchanged 1/2/4/8/16/32/60/60-second
backoff, retain attempts across eviction and exhaust at eight denied probes;
restoring policy does not reset that old intent. Newer cancellation suppresses
resume. Waiting-approval resume retains the original ToolTask/approval and
performs one simulated effect only after approval. Late approval notification
after cancellation receives the existing benign transport ACK while performing
zero effects/model continuation and preserving cancelled state.

A real SQLite trigger injects failure of the stop-state write. A test-only Vite
negative control moving that write outside its transaction fails at the
inconsistent committed cancel/revision alongside an unchanged suspended state
(11.86 s); unmodified production code passes the same fault assertion. Four
repaired focused faults passed (16.26 s). The first full Node run timed out one
unchanged 5 s late-read/result case under concurrent build load; sequential full
regression passed without changing its limit or assertions. One new fault test
initially forced an Alarm before the persisted one-second wake, then attempted
to open an executor through a wait helper; it now observes committed snapshots
after the natural Alarm. The notification test initially assumed an unsupported
409 contract; it now verifies the existing ACK plus mandatory no-effect/state
fences. No ACL, deadline, backoff or safety assertion was removed.

Actual local infrastructure includes SQLite, signed product policy, encrypted
Provider configuration, workerd, native Pi checkpoints, eviction, natural
Alarms, Scheduler and real browser/file regressions. **Simulated:** new workerd
product policy/model/artifact endpoints and explicitly named UI fixtures.
**Unverified:** vendor inference, deployed Cloudflare hibernation, physical
mobile devices and external IM. **Still not implemented for public Cloud Group
admission:** Handoff model transport recovery, durable progress reconciliation,
bounded cross-store association repair and formal Goal-driven Group execution.
No production deployment/migration was performed and the full Goal is not done.

## Cloud Handoff model transport recovery (#34; admission still closed)

The next local follow-up generalizes the existing `ExecutionRecovery` capability
to frozen Handoff identity without creating a Goal run. A retryable model
transport interruption preserves its native checkpoint, persists a bounded wake,
closes outside the invocation and rechecks current product policy before resume.
Original model budget/deadline and tool receipts remain authoritative. Old Goal
grant JSON, references and summary shape are preserved. Node snapshot decoding
accepts the explicit new Handoff variant. There is no new Harness, scheduler,
SQL rewrite, dependency or Node schema bump. Rollback compatibility is documented
in [migration](migration.md).

Frozen local verification: **378 Node files / 3,095 passed / 23 existing skips**
(127.02 s), **54 actual workerd cases passed** without skips (278.03 s), **3 actual
Node/workerd authority integrations passed** (23.02 s), and **22 browser E2E
passed** (4.7 min). Complete backend/Web/runner, Cloud and Electron typechecks,
backend/Web/runner builds, Cloud dry-run bundle, Electron bundles, runner
self-test and format/docs checks passed. The original backend and unrelated
worktree modifications remain untouched; no production deployment was attempted.

Five new workerd faults cover interrupted SSE with actual DO eviction/natural
Alarm and the same Submission/GenerationTask; interrupted model output after a
committed approved-tool receipt with one simulated effect and the same ToolTask;
execution revocation/reinitialization followed by permanent cancel; original
two-step budget exhaustion producing `unanswered` without another input or
GenerationTask; and an expired original deadline suppressing another model
request. The deadline case bounds continuation; it does not claim cancellation
of an already in-flight provider call exactly at its expiry timestamp. Three
focused cases passed (35.60 s), and two bound cases passed (29.28 s) before the
full suite. Existing Goal recovery and lifecycle cases remain enabled.

A test-only Vite negative control restores the old Goal-only model transport
predicate without editing production source. The actual interrupted-SSE case
fails at `active` versus required `recovering` (36.00 s). The unmodified complete
suite passes the same case and verifies the original task identity, not a new
prompt or submission. A Handoff snapshot identifies its actual runtime/marker;
no fake Goal execution reference appears in its model requests.

**Actual local infrastructure:** SQLite, native Pi task storage, workerd,
reinitialization, Alarms, signed Node policy/provider encryption and existing
real-file/Scheduler/browser regressions. **Simulated:** new workerd product
policy/model/artifact endpoints and explicitly named UI fixtures. **Pending:**
deployed Cloudflare/vendor-model/physical-device/IM acceptance, formal public
Group Cloud admission, progress reconciliation, bounded cross-store association
repair and Goal-driven Group execution. No full Goal completion is claimed.

## Cloud Handoff progress reconciliation (#34; admission still closed)

The existing result-projection Lifecycle job now also publishes coalesced,
bounded progress from the official read-only Pi store. An additive DO SQLite
outbox persists the original input/Submission, observation revision, immutable
payload and receipt digest. Lost acknowledgements retry the same payload, with
eight persisted attempts and bounded backoff; exhaustion blocks that observation.
This path neither opens another Harness nor submits input, approves tools or
delivers a final answer. The signed Node receiver verifies the registered owner,
original product receipt and current read policy before updating Group state.
Control revisions fence delayed frames; terminal business rows remain immutable.
No Node schema, dependency, legacy ownership or business Scheduler changed.

Final local verification: **378 Node files / 3,099 passed / 23 existing skips**
(119.72 s), **57 workerd cases passed without skips** (272.31 s), **3 actual
Node/workerd authority integrations passed** (22.74 s), and **22 browser E2E
passed** (4.6 min). Backend/Web/runner, Cloud and Electron typechecks, builds,
Cloud dry-run bundle, Electron bundles and runner self-test passed. The three
new workerd cases inspect actual Pi input/LiveDoc/Inbox records, recover a lost
progress ACK after eviction and a natural Alarm with the same payload, and
exhaust eight observation attempts without replaying the model or tools. The
exhaustion case injects the retry clock/dispatch; it is not evidence of eight
natural Alarms. The new signed Node receiver is separately exercised by the
authority suite; public Group-to-Cloud execution remains gated.

A test-only Vite negative control removes only the control-version guard. The
late-frame case fails at `running` versus required `pending` (9.96 s); unchanged
source passes the full suite. Initial failures exposed the existing empty-string
progress default, the terminal-row mutation guard, a cross-session test poll,
and insufficient polling for the actual two-second backoff. The implementation
preserves the terminal guard and the tests now inspect the exact Handoff.

The browser suite exposed a real touch race: an authorized background update
disabled Send between pointer-down and pointer-up. Content-free, same-epoch
message/progress hints now reconcile without disabling the last authorized
interaction; permission/configuration hints, epoch changes and disconnects
still fence it. The E2E explicitly holds that snapshot read across the gesture
and verifies the real accepted POST. A second full run found HTTP fixtures
racing on reserved ports; test-only IPC now identifies each private child's
actual listening port before any health check. No production authentication or
readiness policy was weakened. A stale Web build during diagnosis was rebuilt
before the final complete browser run.

**Actual local infrastructure:** SQLite, native Pi storage, workerd eviction and
natural wake, signed authority, private backend processes and browser regressions.
**Simulated:** model/policy/artifact endpoints and explicitly named UI fixtures.
**Pending:** deployed Cloudflare hibernation, vendor inference, physical devices,
external IM, bounded original-association repair, public Cloud Group admission
and formal Goal-driven Group execution. The original live backend and separate
worktree changes remain untouched. The full Goal is not complete.

## Original Cloud Handoff association repair (#34; schema 82, admission closed)

The existing Handoff coordinator now owns bounded repair of the original
Node/DO admission association. An additive schema-82 outbox freezes the existing
Handoff/Session/request/payload/grant before transport, charging one of eight
attempts and a 120-second lease. Failure backoff and attempts survive reopen;
duplicate kicks/stale callbacks cannot renew them. The generic Cloud startup
loop excludes these owners and repair starts only after authority HTTP readiness.
Original receipt reconciliation never manufactures an input, Goal run or native
checkpoint. Committed product/native proof may settle an unknown admission even
after transport exhaustion. Separate model and result-delivery budgets remain
unchanged. Restrictive state is rechecked after asynchronous work, and validated
late Cloud receipts cannot mutate a pause/cancel fence.

Frozen local Node regression passed **378 files / 3,105 tests / 23 existing
skips** (126.44 s). All backend/Web/runner, Cloud and Electron typechecks and
builds, Cloud dry-run bundle, runner self-test and generated-type checks passed.
The new integration is included in the explicit TypeScript test project.
The full actual Node/workerd authority suite passed **4 cases** (29.11 s).
Complete browser regression passed **22 cases** (4.8 min). Format/docs/diff and
changed-file credential-pattern checks passed (zero matches across 18 files).
Worker production source is unchanged from the preceding 57-case workerd slice.

Six new SQLite/coordinator cases cover monotonic charged leases, concurrent and
stale claims, eight attempts across reopen, bounded backoff, pause/revocation,
original committed receipt settlement, v81 backup/identity preservation, and
late pause/cancel fencing with payload validation. Attempt exhaustion uses an
injected clock; the coordinator unit case explicitly simulates the runtime.
The migration test checks the actual mode-0600, integrity-checked pre-upgrade
backup and unchanged original Handoff/placement without admitting an input.

The new actual Node/HTTP/workerd integration drops a successful admission ACK,
suppresses progress repair, reads original native state without reconciling the
product receipt, then reconstructs Node services/storage and workerd against
retained SQLite. It verifies identical retried input bytes, one original product
input/native Submission/root task, one final Group result and no local executor
database. This is service/store reconstruction with severed HTTP connections,
not a new Node process-SIGKILL case. Existing real native SIGKILL cases still run.
The model and HTTPS hostname routing are simulated; product policy/provider
encryption/private authority/Pi storage/workerd are actual implementations.

A test-only Vite negative control removes only the generic startup exclusion.
It fails at two submission transports instead of one before the association
coordinator starts (6.33 s), with no unhandled errors. Normal full integration
passes. An earlier diagnostic failed teardown because Miniflare disposal alone
does not drain its service-binding HTTP request; the fixture now severs and
drains the old Node connections before closing SQLite. The first UI typecheck
caught a status block placed outside its task scope; it was corrected before the
full build/typechecks. No security assertion or production auth behavior changed.

Public Cloud Group admission, formal Goal-driven Group execution and full public
multi-device approval acceptance remain Pending. Vendor inference, deployed
Cloudflare hibernation, physical devices and external IM remain unverified.
No production migration/deployment occurred. Keep a v82-compatible pair for
operational rollback; an old Node binary cannot open v82. The full Goal is not
complete.

## Formal opt-in Cloud Group Handoffs (#34 follow-up; full Goal still Pending)

The existing Group grant/API/provisioner and Runtime Router now support explicit
`cloudflare-durable` selection behind separate default-off
`MINICLAW_CLOUD_BOT_HANDOFFS`. Groups/Handoffs/Cloud Runtime prerequisites,
Owner/Workspace/Host/Profile/Provider authorization and original grant quota/
expiry still apply. The existing form offers runtime and appropriate reviewed
tools. Cloud bindings replace global capability defaults with the exact grant;
empty remains empty. Only `inspect_text` and separately enabled approved
artifacts are available. There is no file/Shell/Memory/MCP/device inheritance,
new product API, Worker, queue, Scheduler, Node schema beyond 82 or checkpoint
conversion. Existing flags/legacy Session ownership remain compatible.

Full Node regression passed **378 files / 3,106 tests / 23 existing skips**
(115.73 s). Backend/Web/runner, Cloud and Electron typechecks/builds, explicit
integration TypeScript coverage, Cloud dry-run bundle and runner self-test passed.
Actual Node/workerd authority integration passed **5 files / 7 cases** without
skips (48.49 s). The final complete browser run passed **23 cases** (4.8 min)
after explicit UI-fixture isolation, without default-backend proxy errors. Worker
production source is unchanged from the preceding 57-case actual workerd slice.

Three new integration cases use the production Node entry as a private OS
process, actual HTTP/public Group APIs, encrypted Provider, HMAC authority,
workerd/native Pi/SQLite and retained receipts. They cover a lost cloud admission
ACK plus actual Node SIGKILL/workerd restart with one original input/Submission
and one Group result; a real read-only byte/hash tool under an exact two-model
budget, rejection of incompatible tool grants and preserved ownership with new
admission off; and actual observer/Bot revocation. Revoked observer reads return
404, the runtime is persisted `blocked`, the Handoff remains conservatively
`uncertain`, private runtime reads fail, resume is rejected and reinitialization
causes no late model request or Group answer. No local executor database appears.

The new real phone-browser case reviews a Cloud grant in the existing Group UI,
waits for an original artifact approval, detaches desktop, SIGKILLs Node and
restarts workerd with new admission disabled. The phone approves the same
approval/Tool Task after reconnect. Dropping its decision response and retrying
the original key preserves one actual mode-0600 file with unchanged inode/mtime,
one final Group answer and the original Handoff/Session/input/Submission. Only
the reviewed artifact tool reaches the model. The focused case passed (11.7 s).
Chromium emulates iOS/hash navigation; it is not physical Safari acceptance.

A test-only Vite negative control omits only the separate Cloud Handoff opt-in
from the shared admission predicate. The actual gate test fails at `true` versus
required `false` (5.25 s). No production source is edited; the complete normal
Node suite includes and passes that predicate test. Its selected negative run
intentionally excludes unrelated cases, not the full regression gate.

Initial browser-helper failures came from resolving its Worker bundle/module
root relative to the Web working directory; both now derive from the helper's
repository URL, and workerd readiness is awaited. The first revocation test
incorrectly expected `cancelled`; existing Native revocation deliberately records
`blocked / uncertain`, so the corrected test adds actual blocked-database,
read-denial, rejected-resume and no-late-execution proofs instead of weakening
production state or permissions. A restored environment exposed optional
unmocked availability reads in two UI-only harnesses; these now provide explicit
local mocked responses. All formal Node/workerd paths remain actual HTTP.

**Actual local infrastructure:** production Node processes/SIGKILL, HTTP/HMAC,
encrypted Provider, SDK checkpoints, workerd reconstruction, SQLite, browser and
artifact filesystem. **Simulated:** inference, HTTPS hostname-to-loopback routing
and expressly identified UI harness APIs. **Unverified:** deployed Cloudflare
hibernation/billing, vendor inference, physical devices and external IM.
**Still Pending:** formal Goal-driven Group association, remaining unified
multi-device controls and Cloud-to-Local-Node capabilities. No production
deployment, credential commitment, main update or full Goal completion occurred.

## Goal Team convergence over current main

The baseline was fetched live as `b9e933a` after #46 and #28 merged. Goal Teams
were absent there; the new public creation test first failed with the unknown
Team field (5.70 s). Existing status-only PATCH also had a real SQLite/Scheduler
counterexample: a reviewed one-run budget became ten and next action was erased
by Zod creation defaults. The fix preserves omitted fields and the new regression
checks the actual exhausted-run fence and explicit later budget edits.

The first actual Node/workerd Team chain passed (5.49 s): Chief selects
Researcher, then Developer through existing Group grants; two distinct native
Handoffs, four synthetic inference requests and two actual approved artifact
receipts satisfy cumulative evidence. The enhanced chain then passed with
actual Node SIGKILL, workerd reconstruction during the second approval and
natural Scheduler lease recovery (65.02 s). Original Submission/Tool Task/
approval identity, exactly two charges and no coordinator input are asserted.
An actual rapid pause/resume test revealed a control race; returning the existing
execution-pending signal fixes the old caller's mistaken failure transition.
The corrected controls case passed (5.52 s), preserving one Handoff and rejecting
late completion/@Bot text after cancellation. Selected test runs deliberately
exclude other cases; they are not full-suite evidence.

The initial browser slice passed (11.1 s): independent desktop/touch logins,
Goal and Group state, offline reconciliation, desktop detach, phone approval,
artifact-backed completion and same result after reopening. Team creation uses
the real API, not a completed Chief creation UI. The final updated product-link
and complete regression gates are recorded separately after execution.

Source/lease/revision/Owner/Workspace/tool denial, immutable origins and a private
v82→v83 backup/integrity/no-adoption case run against actual SQLite. No new
Scheduler, model executor, shared-memory merge or approval system is introduced.
Only actual files/native receipts authorize completion, never a model statement.

**Actual local infrastructure:** production Node/auth/HTTP/Scheduler, SQLite,
workerd, native Pi checkpoints, OS SIGKILL, filesystem and Chromium. **Simulated:**
model responses and explicit HTTPS hostname routing. **Pending:** deployed
Cloudflare, vendor inference, physical phones, external IM, Cloud Device bridge,
conversational Team creation, mention composer and attention center. No production
resources/data changed; #34/#35/#30 are not marked complete.

Final local gates on the complete slice passed: **379 Node files / 3,114 tests /
23 existing skips** (139.18 s); all backend/Web/runner, Cloud and Electron
typechecks/builds, generated-source checks, runner self-test and Worker dry-run.
Actual workerd: **57 tests** (269.35 s). Actual authority integration: **6 files /
9 cases**, no skips (121.20 s), including final Chief outcome projection,
structured results and four persisted Goal model-attempt charges. The final
complete browser regression passed **24 cases** (4.9 min). Cloud production
dependency audit reports **0 vulnerabilities**; the staged 27-file credential
pattern scan reports **0 matches**. Documentation/format/diff checks pass.

These are local results, not a substitute for the new PR's own remote CI or the
Pending deployed/provider/physical-device release gates above.

PR #47's initial remote run 39214971936 passed both Cloud jobs and the validate
format/generated/typecheck/full-test/build/bundle steps, then hit the **20-minute
job ceiling** during browser regression. GitHub's annotation explicitly reports
the maximum execution time, not a test assertion failure. For comparison, main's
successful validate job already takes 19m19s, including 9m06s of browser tests.
The validate job ceiling is now 30 minutes; all test selection, per-test timeouts,
assertions, security checks and skip counts remain unchanged. The new head must
pass its own rerun before readiness is claimed.

## Cloud Team → existing Device Node bridge (2026-10-19)

The default-off `MINICLAW_CLOUD_DEVICES` slice adds an exact-request read tool to
Goal-owned Cloud Handoffs using the existing Device Node registry, grants,
command/cache receipts and Lifecycle/Alarm. It does not add a second runtime,
Scheduler, approval service or local execution protocol. Schema v84 preserves
legacy generic grants and binding digests; the pre-v83 fixture reconstruction
now removes v84 children before reconstructing old parent tables, with the old
migration/backup assertions retained.

Local evidence: complete Node Vitest 382 files / 3,122 pass / 23 existing skips
(137.90 s); post-change focused regression 7 files / 45 pass (8.07 s). Existing
workerd suites pass 57 cases (270.65 s), and four additional actual workerd fault
cases pass (10.52 s), including forged ledger-only native identity, due Alarm,
cancel/eviction, monotonic budgets and retirement of an old completed-tool wake.
The formal authority suite passes 7 files / 11 cases (170.85 s). The final Cloud
device HTTP cases pass 2 cases (23.98 s including compilation): permission wait,
offline wait, native workerd reconstruction, exact existing grant/command,
original-byte local cache, duplicate grant/result, lost Cloud confirmation ACK,
second reconstruction, approved artifact, verified device evidence, completion,
and pause/cancel/revoke fences. Model inference and test HTTPS hostname routing
are simulated; Node, workerd, SQLite, Scheduler, file reader/cache and artifact
writes execute. No Cloud Mac/phone/CLI combination is claimed by these HTTP cases.

Backend/Web/runner/Cloud/Electron typechecks, generated types, all builds,
Agent Runner self-test, formatting and documentation checks pass. The complete
existing 24-case browser regression and remote CI are still being collected for
this slice. It is not release acceptance until their results are recorded.
The existing physical-device, real-provider and deployed-Cloudflare gates remain
Pending. Request approval/Chief Team creation/mention/Attention UI is a subsequent
product slice; this bridge is not a claim that the final 90-second demo is ready.

## Team product convergence and final local scenario (2026-10-19)

PR #47 (`7254c87`) passes all three remote checks in run 39217269452; PR #48
(`9d5ee36`) also passes `validate`, `cloud-agent` and `cloud-authority` in run 39223523810. Both are ready for review; no merge or production deployment was
performed by this agent. The older bridge-section browser/remote Pending entries
above describe its pre-CI snapshot; #48 subsequently passed all 24 browser cases
and remote validation.

The product slice adds the Chief Team composer, private attention snapshot,
keyboard/touch mentions, readable Goal contracts and declared local evidence.
Its full Node regression passes 384 files / 3,130 tests, with 23 pre-existing
skips (135.76 s). Workerd passes all 61 cases (286.88 s); the formal authority
suite passes 7 files / 11 cases (132.37 s). The final product scenario has passed
with actual Node/Scheduler, workerd/PiHarness/SQLite, a separate Linux Device CLI,
real finite files/cache and artifact writes. Inference is a fixture. The latest
focused run including same-browser logout/login and a delayed old-owner snapshot
passes in 26.4 s. Desktop explicitly overrides the default mobile test preset.

The test-first failures identified absent mention/choice behavior, missing
resource evidence, a manual-completion bypass, and Host revocation in the new
read projection. Those are fixed without reducing assertions. The browser checks
also found the historical successful-login redirect still targeting Chat; ordinary
login now opens Bots and mandatory password change still opens settings. A test
context that inherited mobile defaults was corrected to an explicit desktop;
no timeout or permission guard was weakened. A scoped listbox locator replaces
an ambiguous option locator without changing the touch assertion.

The final complete browser rerun passes all 25 cases in 4.9 minutes, including
the same-browser account switch and delayed old-owner response. Post-change
focused Node regression passes 6 files / 30 cases (6.34 s). Backend, Web, runner,
Cloud Worker and Electron typechecks/builds, generated types, documentation,
formatting and Agent Runner self-test pass. Wrangler dry-run bundles the Worker
without deploying it. Product PR remote CI is still Pending at this commit;
its actual workflow result must be checked before removing Draft.
No deployed Cloudflare lifecycle, real Zen inference, physical iPhone/Android,
actual external IM exchange, Electron GUI or cloud cost is claimed. The live
preflight returns Pending for the missing secure `MINICLAW_ZEN_API_KEY` binding;
observed runtime secrets/variables/outbound identities are empty. See
[product convergence](product-convergence.md) and
[Cloudflare staging acceptance](cloudflare-real-acceptance.md). #34/#35/#30 remain
open for the outstanding real gates.
