# Bot Team issue convergence

## #75–#78 / PR #109: container admission and diagnostics

Server-owned Group Dot Sessions can use their owner's container workspace with
Node Durable. Private and Goal Durable Sessions remain limited to authorized Host
workspaces. The Group admission and runtime grants validate their persisted
origin; Group handoff and discussion use that same scoped admission.

The container entrypoint checks effective node-user access before starting the
agent, and Docker availability reports the failure reason. On the local Colima
profile, the runtime access tests passed in a real container. The broader
permission suite passed 41 of 42: the remaining prompt bind test exposed that a
host file encryption agent presents ciphertext to the virtual machine. The default production image uses its bundled prompts; this failure is relevant
to the optional live-source prompt overlay, and it raises a separate risk for
other host-mounted files. The access check does not detect ciphertext; retain
the PR as draft until the affected runtime paths are verified. Docker Desktop,
real hosted services and deployed Cloudflare remain separate acceptance targets.

The Pocket notification harness resolves URL and brand imports independently and
checks that the notification uses the configured robot icon.

## Five follow-up fixes — 2026-10-21

This implementation supersedes the creation and verification findings below.
Actual SDK authentication/model discovery invoked the API-key resolver without
inference; charging there could exhaust a Bot's grant. Metering now occurs at
the provider stream dispatch, with the same owner checks and finite grants.
Startup now opens the Web control surface before background Session recovery,
so recovery cannot prevent the health/approval UI from becoming available.

Primary creation is a name/shape/color dialog. One SQLite transaction creates
the Profile, private conversation workspace and owner-scoped request receipt;
a lost response retries that receipt instead of creating another Bot. Advanced
configuration remains available. Schema v86 retains existing identities and
adds nullable avatar shape plus creation receipts. Team refresh checks Goal
availability before requesting Goal team options. The local verify-miniclaw
harness now fails on console/page/HTTP errors, with only the exact first
unauthenticated auth-prewarm 401 exception. Docker's summary uses literal
quoting, and its empty/partial/configured credential branches are exercised.

The fixture records actual process startup durations. Its bounded cold-process
readiness window is 120 seconds (previously 30); product/model progress waits and
six-attempt live grants are unchanged. The controlled recovery-hold test proves
that this does not allow recovery to block Web readiness. Both the root and `/mini`
Bot-first browser cases passed after separating build preparation from UI waits.

Final real-model evidence: two consecutive complete Node Durable runs passed all
11 checks, with three calls per Bot against the original six-request grants.
The first post-metering rerun had still stalled after a provider error, and a
later bounded run exhausted six actual requests with connection errors. The final
implementation also bounds generation streams to 60 seconds and pairs fetch with
the installed proxy dispatcher; those failed runs are retained rather than
counted as accepted. See [the final safe result account](bot-team-live-acceptance.md).

The local strict verify-miniclaw suite passed 30 checks: setup/login, chat,
lightweight Dot creation, tasks, capabilities and separate mobile first chat.
All observed unexpected console, page and HTTP error arrays were empty; doctor
passed before/after and both disposable instances were stopped. Primary creation
also passed desktop/390/320-width first replies, short-viewport footer reachability
and a lost committed-response/reload/retry case with one Profile/workspace.
The first-chat provider in these UI journeys is synthetic; the real-model Group
scenario above is a separate actual-vendor acceptance.

Final backend coverage spans 400 files and 3,209 passing tests, with 23 existing
skips. The full run recorded 397 passing files/3,187 passing tests, two cold-start
failures and one preparation-hook failure that prevented 20 Cloud authority
checks from running. After the fixture preparation/budget repairs, the focused
rerun passed all three affected files and all 22 affected checks. Its two filtered
checks had already passed in the full run. This is combined regression evidence,
not a claim that a single final full-suite run was entirely green.

Eleven browser scenarios passed across the UI regression runs, including
root and `/mini` deployment prefixes, settings, avatars, Team and Handoff flows.
Docker summary quoting passed all three empty/partial/configured fixture
credential branches without shell stderr.

Cold-process fixtures run serially before unit tests to avoid competing Node/SQLite
owners. Multi-restart cases receive a 420-second aggregate budget, the seven-start
HTTP case receives 600 seconds, and the 5,000-entry archive case receives 60 seconds
with a 45-second restore-child deadline. Archive preparation is a separate bounded
hook. The recovery-hold preload imports the full real recovery graph before
main, so that proof allows 120 seconds for cold bootstrap and 150 seconds overall
after a 60-second cold-load timeout on this host. Business-state polling remains 30 seconds; all crash, identity, artifact,
archive-safety and finite-model-grant assertions remain in place. A bytecode-cache
experiment was withdrawn because it slowed this host; it is not part of the change.
The Cloud authority fixture also loads Web broadcasters before its bounded setup
hook; cold module construction no longer consumes the unchanged ten-second hook
or five-second business assertions.

## Latest failure and creation-UX audit — 2026-10-21

This section supersedes the earlier all-green Node Group conclusion below.
Two subsequent real `cat-jam-free` runs on `9cce601` failed: one at backend
restart after SIGKILL, one while waiting for both exact artifact approvals.
During the second run, one Handoff waited with three model attempts and the
other failed with six; no budget or timeout was increased. The cause is not
established. See the [retained acceptance account](bot-team-live-acceptance.md).

The existing `verify-miniclaw` baseline passed 24 checks across setup/login,
synthetic-provider chat, profile creation, task creation/pause and capability
registration. Those tests do not prove real-model recovery, new-Dot first-chat
completion, physical devices or deployed Cloudflare business behavior. In
particular, the original Dot journey ends at profile persistence.

Grok Bot was opened and its native desktop creation form was exercised directly:
a single modal has a name, a large live avatar preview, 13 shape choices and 11
color choices. Choosing a blue star updated the preview; entering a name enabled
Create. The draft was cancelled, and reopening showed an empty name and disabled
Create. No Bot was saved, so post-save behavior is unverified.

Current OpenDot creation has a role-description entry followed by five wizard
steps, then leaves a saved Profile without a workspace. Its sidebar's DOTS list
is derived from existing workspaces, so a new Profile cannot appear there until
a workspace exists. The team page can prepare that conversation, but it asks
for another workspace name. This is a verified onboarding gap, not a claim that
profile creation fails. Model effort, host context and capability details are
present before first use; the creation portrait offers emoji/color and later
image upload, without Grok's direct shape picker. These are UX findings, not
acceptance criteria silently changed to match another product.

A new local `verify-miniclaw` mobile first-chat journey now covers the saved
editor, correct workspace/Profile binding, distinct provider reply, exact user
message persistence and 390 x 844 document overflow. All five functional checks
passed. Its sixth, explicit HTTP-error check failed on
`GET /api/goals/team-options` returning 404 when personal Goals are disabled.
`TeamHome.reload()` still makes that optional request on a five-second refresh
cycle; the fallback avoids blocking chat, but does not avoid the error/noise.
This is a disabled-feature request issue, not evidence that first chat failed.

The local skill retains screenshots/ARIA and URL-path/status-only HTTP evidence.
Its original shared harness logs console errors as warnings and may still return
`ok: true`; the new journey makes the unexpected HTTP condition an explicit
failed check. The original created-Profile screenshot also captured a transient
draft/saving state; the new path waits for the saved editor before capturing.

Latest inspected [hosted CI](https://github.com/helsome/OpenDot/actions/runs/39536730814)
for `9cce601` failed before any job steps; no failure log was available through
the connected API. Its underlying scheduling/execution cause is unconfirmed.

The concurrently merged Docker publish preflight (`a062f5b`) correctly emits
`enabled=false` with empty credentials. A local Bash-only reproduction also
found backticks inside a double-quoted summary `echo` executing
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` as commands. It logs two
`command not found` errors and drops both secret names from the summary, while
still exiting 0 and skipping publish. This is a low-severity reporting defect;
no actual credentials or hosted publish were used in the reproduction.

Priorities: restore reliable real-model completion/restart, retain safe failure
evidence, then shorten creation-to-first-chat and make the next action clear.
Deployed Cloudflare lifecycle, physical mobile, native Electron and real IM
remain unverified. No issues are closed by this audit.

## Bot Team follow-up — 2026-10-21

The [real-model directed Group acceptance](bot-team-live-acceptance.md) now
passes all 11 checks on local Node Durable: two explicitly mentioned Bots use
the configured Zen model, read distinct authorized workspace files, preserve
original approvals/submissions across actual SIGKILL, receive phone approvals,
save one private artifact each and deliver once. Reload/reconnect does not add
model attempts. The synthetic helper provider receives zero requests.

The opt-in `npm run test:bot-team-live` command provides a repeatable secure
entry. The original personal-agent live command remains separate. Preflight is
independent of SDK loading, fresh builds invoke installed Node tools directly,
and real-model traces/video/screenshots stay disabled.

The host also reproduced a legacy plugin migration staging-prefix collision;
independent staging names fix it without changing inode isolation/rollback.
Canonical test scratch paths preserve Device path checks on macOS. Process-heavy
test concurrency is bounded without changing assertions or deadlines.

Final local Node regression: 395 files passed, 3195 tests passed and 23 existing
skips. Full type checks/builds and four Group/Handoff/Cloud/Device browser
cases passed. A completed Goal no longer shows a stale next-action instruction.

GitHub still has #30/#34/#35/#58/#61/#64 open at this audit. Inference acceptance
for this Node Group path is no longer missing. Deployed Cloud Group lifecycle,
update/rollback/cost, physical phone/PWA behavior, native Electron and real IM
remain separate. No issues were closed and no new Cloud resources were deployed.

The prior head `c5853f8` [hosted CI run](https://github.com/helsome/OpenDot/actions/runs/39447739069)
failed before any job steps, with no downloadable job log. Its scheduling failure
reason is not established through the connected API. It must not be confused
with the earlier fixed TypeScript error or reported as a hosted pass.

## Live audit — 2026-10-20

Checked GitHub's actual issue states, merged PRs and main Actions at
`b943e4afc50a544061911128bbd439dd181a4e8f`. Historical notes below remain evidence
for their original revisions; their old “not merged” statements are superseded.
No issues were closed by this audit.

| Issues        | GitHub state | Current outcome / remaining acceptance                                                                                                                                                                                                                   |
| ------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #31, #32, #33 | Closed       | Entry, Group domain/ACL and native Handoff core scopes accepted. This does not imply every deployment/device path is accepted.                                                                                                                           |
| #58           | Open         | Foundation and product integration are on main. This follow-up makes generated, explicit emoji and uploaded portraits share a 6.4s breathing layer, including identified private-chat replies/streaming. Physical-mobile performance remains unverified. |
| #61           | Open         | Conversation-first shell is merged. This follow-up removes the overlapping session-sheet close control and resets new-Dot wizard scroll to the editor. Physical keyboard, background and safe-area acceptance remains separate.                          |
| #64           | Open         | Repository rename, product identity and metadata PRs are merged. Retained MINICLAW compatibility names are intentional. Release references/publication and final CI acceptance still need reconciliation.                                                |
| #34           | Open         | Local workerd/authority tests and deployed health checks do not establish deployed Group lifecycle, vendor inference, update/rollback or billing acceptance.                                                                                             |
| #35           | Open         | Real isolated Goal/model/tool recovery has passed separately; complete Bot Team, external IM, physical phone and native Electron acceptance remains incomplete.                                                                                          |
| #30           | Open         | Epic retains the #34/#35 release gates.                                                                                                                                                                                                                  |

The latest main [CI run](https://github.com/helsome/OpenDot/actions/runs/39434444946)
failed during the personal-agent TypeScript check: `randomUUID()` narrowed the
optional session argument to a UUID template literal. The follow-up explicitly
types the argument as `string`, preserving arbitrary stable conversation IDs.
`make typecheck` now passes locally; that is distinct from hosted validation of
the next pushed revision. Both hosted cloud jobs passed on the inspected head.

The independent [image publish run](https://github.com/helsome/OpenDot/actions/runs/39434444957)
failed at Docker Hub login with “Username and password required”. No registry
credentials were created or changed. This publication blocker is still open.

Local follow-up validation passed: complete `make typecheck`, final Web and E2E
TypeScript checks, production frontend build, 74 focused Node/DOM tests and 18
browser cases covering portraits, actual product work/approvals, conversation
geometry, mobile creation/navigation, previews and branding. Browser dimensions
are emulated. Public Node health and Worker health returned healthy; the public
CSS contains the new visual layer and 6.4s breath. None of these checks replaces
the deployed business/physical-device gates above.

Smaller touch targets in older context/profile controls, physical devices and
deployed cloud business journeys remain outside the fixes above. A breathing
portrait does not invent an execution state: waiting/error settle, attention is
finite, reduced-motion disables motion, and offscreen/hidden portraits pause.

This is an implementation/acceptance ledger, not a claim of cloud deployment.
Remote main inspected at `e890e0240137a3c1de1beedf3de26e75a274a040` includes
#46, #47, #48 and #52. Historical feature PR heads are not necessarily ancestors
because integration copied/squashed reviewed trees; inspect current source too.

Main's [product CI](https://github.com/helsome/OpenDot/actions/runs/39361827293)
passed on that exact SHA. Its separate Docker Publish workflow failed at Docker Hub login (annotation: Username and password required); that is a
release/publication blocker and must not be described as a product test failure.
No image publication or credential repair is claimed here.

| Issue                                | Current implementation and evidence                                                                                                                                                                                                                                                                                                                         | Remaining gate                                                                                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #31 Chief/Bot entry                  | Existing Profile/Workspace entry resolution; `tests/bot-entry.test.ts`, `tests/bot-first-product.test.ts`, `web/tests/e2e/bot-first-product.spec.ts` cover ownership, reassignment, Host revocation, desktop/hash/subpath.                                                                                                                                  | Main's ordinary login still enters `/chat`; the conversation-first replacement restores `/bots` and resolves its authorized existing conversation while preserving forced-password/setup branches. Keep open until the reviewed integration lands and main CI passes. |
| #32 Group domain/ACL                 | Existing `src/bot-groups/store.ts` and routes persist Group/member/message identities and receipts. `tests/bot-groups.test.ts`, `tests/bot-group-client.test.tsx`, schema tests and `bot-groups.spec.ts` cover duplicate requests, real two-client timelines, restart and revocation. Present on inspected main with passing CI.                            | Core scope is verified; physical phones and cloud deployment are not required evidence for this domain-model slice.                                                                                                                                                   |
| #33 Durable routing/Handoff (closed) | Existing Handoff service/store and Product Runtime preserve native Submission/Task identity. Native HTTP/control/security/recovery suites and `bot-handoffs.spec.ts` cover authorized delegation, lost ACK, partial effects and server death. Cloud authority/workerd coverage remains distinct from deployment. Present on inspected main with passing CI. | Core scope is verified using fixture inference and actual local execution. No real-provider/deployment claim.                                                                                                                                                         |
| #34 Cloud Team lifecycle             | Existing single-owner Cloud routing, recoverable associations, Alarm/checkpoint/receipt projection, Goal Scheduler and Device bridge. Local workerd and actual Node authority integration exercise them.                                                                                                                                                    | Real Cloudflare staging/account lifecycle, deployment update/rollback, billing/cost and vendor inference acceptance remain Pending. Do not close from local workerd results alone.                                                                                    |
| #35 Product acceptance               | #57 established the reviewed functional UI; #61 replaces its Dashboard entry with the existing Chief conversation, a bottom dock and secondary Work/Attention. `team-final-convergence.spec.ts` runs actual Node/workerd/SQLite and a separate finite-file Device CLI through reviewed artifacts and completion.                                            | Conversation-first replacement merge/main reconciliation; physical iPhone/Android, actual keyboard/background behavior, native Electron GUI, real provider and real IM delivery remain Pending. Existing 90-second demo is in `product-convergence.md`.               |
| #58 Animated Bot avatars             | #60 foundation plus a separate product follow-up use stable Profile IDs and per-Bot authority across Chief, Bots, Group/mentions, Context/Sheet, Work, Goal Team, attention and navigation. Product E2E checks reconnect, approvals and actual avatar upload; screenshots are in `docs/bot-avatars/product`.                                                | Follow-up review/dependency merge/main validation, plus physical-mobile performance. Generated states are not evidence of new thinking/Runtime phases; unknown/recovering snapshots settle.                                                                           |
| #61 Conversation-first shell         | Implemented as a focused follow-up on the verified #57/#60/#62 tree. Geometry/canonical-link tests precede the layout changes; actual product E2E retains ownership, receipts and account-switch assertions.                                                                                                                                                | Replacement PR/full checks and main review; #57 is deliberately Draft and must not merge in Dashboard form. Physical keyboard/phone acceptance remains separate.                                                                                                      |
| #30 Epic                             | Tracks the above product as a whole.                                                                                                                                                                                                                                                                                                                        | Stays open until #34/#35 release gates are actually satisfied.                                                                                                                                                                                                        |

## Evidence boundaries

- Real local: compiled Node HTTP/Scheduler, SQLite, workerd/Pi Harness, isolated
  Linux Device CLI reading a finite temporary file, task/approval/effect receipts.
- Simulated: provider responses, Chromium touch/iPhone UA/hash/PWA viewports,
  synthetic IME/keyboard events. PNG captures stop animation for reproducibility.
- Unverified: physical devices, vendor inference, Cloudflare staging lifecycle and
  cost, native Electron GUI, external IM. No production resources were deployed.

Use existing isolated acceptance commands from `evaluation.md` and
`cloudflare-real-acceptance.md`. Do not create another runtime/scheduler/protocol,
replay original prompts as recovery, weaken assertions, or treat unavailable
external credentials as authority to deploy. Keep these boundaries in PRs and
issue closure notes.

## Follow-up local evidence

The #58 product branch passed complete Playwright 33/33 (5.7m), including real
uploaded avatars at root and `/mini` on desktop and iOS-style hash clients; full
Vitest 391 files / 3,181 tests, with 23 existing skips (124.96s); local workerd
61/61 (273.99s); actual Node/workerd authority 11/11 (136.14s). The last two
suites preceded the final Web-only avatar URL/main-run attribution fixes; their
source stayed unchanged. Generated types, full typechecks, builds, Runner
self-test, formatting/docs and credential scan are part of the commit gate.
Exact-head hosted CI remains separate from local evidence.

#32/#33 were closed with their existing main implementation and exact main CI
evidence recorded in each issue. #57 contains `Closes #31`, so that remaining
login/entry acceptance closes only after the user's reviewed merge. #58/#34/#35
and #30 retain the gates above; no production deployment or main merge occurred.

#62 exact head `e7d49e9e4fb061d7b13be50a9bb8e169c3a99dfc` passed all three hosted CI jobs (run `39386058412`) and is Ready for independent avatar review. #61 supersedes the old Dashboard integration criterion; do not merge #57 in that form.

## OpenDot canonical design follow-up

The repository was renamed to `helsome/OpenDot` (same repository identity).
#63 head `36cf8af4f9667967299dae71300936289f40464a` supplies the canonical
`DESIGN.md`; #65 preserves it and the conversation-first functional ancestors.
#65 exact head `1961b60bc2532f6ca190e46b2561736ad375bffd` passed all three hosted
jobs in run `39395864128` and is Ready. It supersedes #57's Dashboard; #57 stays
Draft. #59 repaired logo head `b4999a939cd7821db90457cc4d429cb5383fab53` passed
all three jobs in run `39393290182` and is also Ready. Neither was auto-merged.

The `agent/opendot-design-system` follow-up applies the canonical tokens and
shared surfaces, static app identity, OpenDot Web/PWA/native labels and actual
Dot names. The existing protected Profile API supports renaming; display metadata
is fenced by actor, read generation and committed Profile version. Its local
full Vitest run passed 394 files / 3,190 tests with 23 unchanged skips. Full
browser acceptance passed 36/36, followed by 2/2 real HTTP rename/brand cases for
the final version-race fix. Screenshots and boundaries are recorded in
`docs/frontend-redesign/opendot-design-system.md`; hosted CI is tracked in the PR.

#64 remains open for repository/package/release compatibility follow-up. Old
personalized/legacy Dot names and existing internal identifiers are preserved.
A pre-existing local Durable path-creation race was exposed during full tests;
it is reproduced independently and belongs in a separate Runtime fix, without
weakening ownership assertions or mixing it into the design change. #30/#34/#35
retain their real-provider/cloud/physical-device gates.
