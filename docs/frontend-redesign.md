# Frontend product redesign

Five incremental presentation slices preserve the existing product authority.
Historical entries below record evidence at each commit; PR checks are the source
for current exact-head remote status.

| Slice                 | Review                                                                                   | Dependency                |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| Design system / shell | [#52](https://github.com/helsome/miniclaw/pull/52)                                       | main                      |
| Chief / Bots          | [#53](https://github.com/helsome/miniclaw/pull/53)                                       | product #49 and shell #52 |
| Group conversation    | [#54](https://github.com/helsome/miniclaw/pull/54)                                       | #53                       |
| Work / Attention      | [#55](https://github.com/helsome/miniclaw/pull/55)                                       | #54                       |
| Settings / polish     | [review branch](https://github.com/helsome/miniclaw/tree/agent/frontend-advanced-polish) | #55                       |

#52–#55 passed their three exact-head remote CI jobs and are ready. The final
branch is submitted separately after local gates; its PR links the exact-head CI
before ready. Review/merge prerequisites first; no merge or deployment is performed
by this task. The separate pending product integrations #47–#49 are not recreated.

## Shell slice

Based on remote main `49c5e42ec018b060c6692165e397dd654d5f4454`.
This slice changes presentation, navigation grouping and responsive containers.
It does not change authentication, entity identity, API payloads, runtime choice,
execution, Scheduler, approvals or device grants. #47–#49 remain separate pending
product integrations; their APIs and Team UI are not invented on this main branch.

Current visual gaps: icon-only desktop navigation, too many mobile destinations,
strong orange/glass decoration, repetitive cards, excessive type scales, inconsistent
overlay styling, prominent engineering controls in conversations, and no explicit
tablet layout. Page-specific reductions follow this shell slice.

## Design contract

`web/src/styles/product.css` is the canonical semantic palette. Legacy/shadcn
names alias the same background, surface, elevated surface, subtle/default border,
primary/secondary/tertiary text, action and feedback values. The old theme-value
blocks were removed from `globals.css`; it retains shared utilities and rendering
styles. Each application/test entry loads both stylesheets in the same order.
The default accent is restrained blue. Explicit stored warm/neutral preferences
still work; an unset old orange default adopts the new default. Theme storage keys,
light/dark/system selection and font preferences are retained. Browser theme-color
uses the actual surface token. Theme changes do not change geometry.

Desktop (>1100 CSS px) uses a labelled 228px sidebar, main and optional 320px
Context. Existing Chat workspace navigation remains available. Tablet (768–1100)
uses a 68px rail and an explicit navigation drawer. Mobile (<768) uses Chief,
Teams, Work and Me, with the existing Goal feature gate selecting Work's route.
Conversation routes leave room for their composer. Advanced resources and billing
retain their original URLs, guards and billing visibility inside Advanced.
No new route grants access to a resource.

`ContextPanel` is a presentation container, not a state/permission store. It is
empty until an existing page supplies content. Desktop uses a closable aside;
tablet/mobile use the existing Radix modal primitive, with focus containment,
Escape, return focus, safe-area padding and constrained height. Owner changes
remount the presentation scope; route changes clear open context. The page remains
responsible for live server snapshots, revision checks and sensitive controls.

The palette, typography helpers, flat list helper, button/input touch sizing,
focus outlines, overlays and reduced-motion behavior are shared. Page cards and
technical configuration are intentionally not silently restyled into different
business flows in this shell PR. Chief/Bots, Group and Work are later slices.

## Browser evidence

`redesign-shell.spec.ts` uses disposable compiled Node/HTTP/SQLite, actual Goal
and Group APIs and a real native Handoff waiting for approval. The model response
is a fixture. It captures Chief/Bots, Group/Attention and Goal in both themes at
1440×900 desktop and 390×844 touch viewports, without approving or re-submitting
work. A frozen provider request count verifies that viewing pages starts no new
model call. It also checks four mobile destinations, 44px mobile navigation,
four foreground/background contrast pairs (WCAG AA 4.5:1), and tablet drawer focus.

`context-panel.spec.ts` separately verifies responsive aside → bottom sheet,
Tab containment, Escape and focus restoration. Its harness is explicitly a
presentation fixture and makes no execution claim. The initial failing focus
return assertion was fixed in the container, not removed. Existing browser
security/identity/recovery assertions remain in the complete regression suite.

Baseline capture passed (17.7s). Final local evidence: 382 Node files / 3,120
passed / 23 existing skips (127.00s); 57 workerd cases (305.93s); 5 authority
files / 7 passed (51.36s); full Playwright 25 passed (5.0m), followed by 2 passing
post-review browser cases (17.9s) for the profile destination and settled Sheet
captures. Typechecks, generated copies, backend/Web/runner/Electron builds,
Wrangler dry-run, Agent Runner self-test, formatting and docs checks passed.
Remote CI remains Pending at this commit.

An initial shared-machine parallel run failed the existing 5-second late-authority
case and 10-second association-recovery wait. The full Node and authority suites
then passed serially on this 5-core host with unchanged assertions/timeouts and
no Runtime edits. This is a recorded load-related failure/non-reproduction, not
a claim that this frontend PR fixed a backend recovery defect. Separate heavy
local suites instead of running all CI jobs on one host at once.
Screenshots use disposable fixture data. Chromium touch/iOS-style UA is emulation,
not physical Safari, Android keyboard, Electron GUI or real model acceptance.

| View                          | Before                                                                     | Shell                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Desktop Chief/Bots, dark      | [before](frontend-redesign/shell/before/desktop-dark-chief-bots.png)       | [after](frontend-redesign/shell/after/desktop-dark-chief-bots.png)       |
| Desktop Group/Approval, light | [before](frontend-redesign/shell/before/desktop-light-group-attention.png) | [after](frontend-redesign/shell/after/desktop-light-group-attention.png) |
| Desktop Goal, dark            | [before](frontend-redesign/shell/before/desktop-dark-goal.png)             | [after](frontend-redesign/shell/after/desktop-dark-goal.png)             |
| Mobile Chief/Bots, light      | [before](frontend-redesign/shell/before/mobile-light-chief-bots.png)       | [after](frontend-redesign/shell/after/mobile-light-chief-bots.png)       |
| Mobile Group/Approval, dark   | [before](frontend-redesign/shell/before/mobile-dark-group-attention.png)   | [after](frontend-redesign/shell/after/mobile-dark-group-attention.png)   |
| Mobile Goal, light            | [before](frontend-redesign/shell/before/mobile-light-goal.png)             | [after](frontend-redesign/shell/after/mobile-light-goal.png)             |

Both directories contain the complete twelve-image matrix. The after directory
also includes exact approval views, the mobile Advanced sheet and task Sheet.
Before images have
the same CSS viewports and retain the inherited display pixel ratio. Screenshots
are evidence for this slice, not a claim that the later page redesign is complete.

## Reproduce and roll back

Use existing pinned dependencies; `npm run build:all` then
`npm --prefix apps/cloud-agent run build` (Wrangler dry-run, no deployment).
Run the complete CI workflow and `npm --prefix web run test:e2e`. Focused browser
commands select `redesign-shell.spec.ts` and `context-panel.spec.ts`; a local
system Chromium can be selected through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
Tests manage their own isolated services and data. Do not start/migrate the
original dirty checkout or point test fixtures at an existing database.

Rollback is a frontend asset/code rollback. It requires no database or Worker
migration, receipt changes or task cancellation. Preserve the matching frontend
bundle and all existing feature flags. Stored color preferences are cosmetic;
returning to the older default palette does not change execution authority.

## Chief and Bots slice

This subsequent frontend slice uses pending product integration #49 as its base
and carries the shell from #52. Its review dependency is explicit: the Team
overview/Goal APIs are existing #49 capabilities, not new execution infrastructure
added by a UI redesign. The first shell remains independently based on main
`49c5e42`. #52 passed all three remote jobs in run 39298621066 and is ready for
review. No merge or deployment was performed.

Chief now centers on a quiet text composer. Ordinary questions reuse the original
message action and its `expectedAgentProfileId`, after a fresh server chat-entry
lookup and the existing owner/profile/folder checks. Successful submission opens
the original conversation. An unconfirmed response retains the text and asks the
user to inspect that conversation; reconnect never re-sends it. Composition input
is respected and Ctrl/Cmd+Enter is separate from plain newline. Acknowledging a
message is not a Goal completion state.

The separate long-term action opens the existing bounded Team Goal form in a
responsive Sheet. Its creation payload, request receipt, exact device declaration,
budget and server-side completion criteria remain unchanged. Working, attention,
Group and recent sections use flat lists; approvals/critical attention retain a
distinct surface. Contact rows replace the Bot tiles. Their detail opens Context/
Sheet with conversation, current work, configured capabilities, authorized memory
and configuration links. Technical Profile configuration is an explicit action.

Team work uses the existing authoritative overview. Native conversation work uses
the existing logical `activeRuns` events/snapshot, never a warm process indicator.
Unverified team data is not presented as idle. Unknown role metadata is labelled
as a team member, not an invented specialist capability. Model/skill summaries
describe configuration; server admission remains authoritative. No list infers
tool permission from Group membership. Bot detail updates from live presentation
props without replacing its selected tab or the original return-focus target.

The only Node changes are additive, read-only presentation fields on the existing
overview/DTO: actual Goal run-budget counters, participating Bot names/states,
and activity routing/name metadata. A Goal link is emitted only for a Goal already
visible to the current owner. Shared Group source envelopes are reduced to their
human title instead of showing internal JSON in a contact row. The existing ACL,
canonical Host revocation checks, no-store response and SQLite snapshot remain.
No Runtime, Scheduler, Goal evaluator, effect/approval or Device protocol is edited.
Run budget is not a planned step count or a completion percentage.

The existing Bot-entry E2E now sends through Chief, checks exactly one model call,
and exercises actual Bot Context keyboard tabs/focus, while retaining its scope,
identity, stale entry, logout and cross-account assertions. The full product Goal
case still checks original Handoff/Submission/device/receipt identities and five
fixture model calls; it also verifies the projected server budget and two actual
participants. The first focused run only needed updated empty-state locators;
the revised three-case core run passed (1.0m). The full Node suite passed 385 files / 3,132 tests (23 existing skips), and the full browser suite passed 27 cases. A subsequent four-view contact-list capture passed in 20.1s. Workerd/authority and final build gates are still being collected; remote CI remains required before ready.
All model responses remain fixtures and touch clients remain Chromium emulation.

The first complete browser run retained one obsolete Group entry label and timed
out at navigation (26/27 passed). Updating that locator to the new visible Group
name preserved the original recovery/revocation assertions; the complete rerun
passed 27/27 in 5.0m. No timeout, test exclusion or assertion weakening was added.

The [Chief/Bots screenshot directory](frontend-redesign/chief-bots/after/) contains
the desktop 1440 × 900 and touch 390 × 844 matrix, in both themes, including Bot
Context/Sheet. Representative views:

| View                      | Screenshot                                                              |
| ------------------------- | ----------------------------------------------------------------------- |
| Desktop Chief, dark       | [Chief](frontend-redesign/chief-bots/after/desktop-dark-chief-bots.png) |
| Mobile Chief, light       | [Chief](frontend-redesign/chief-bots/after/mobile-light-chief-bots.png) |
| Desktop Bot detail, light | [Bot](frontend-redesign/chief-bots/after/desktop-light-bot-detail.png)  |
| Mobile Bot detail, dark   | [Bot](frontend-redesign/chief-bots/after/mobile-dark-bot-detail.png)    |

## Group conversation slice

Group chat now has a single scrolling timeline and an anchored, autosizing
composer. Ordinary messages are flat; consecutive system events collapse into
explicitly expandable history, retaining their original message/sequence DOM
identities and text. Bot activity uses committed server Handoff state, with
recovery labelled from the existing server progress projection. Tasks whose source
message falls outside the loaded timeline still have a visible activity entry.

Selecting work opens the existing Handoff controls in desktop Context or a mobile/
tablet Sheet. The same approval fetch, exact-content preview/digest, revision,
control and command journal are reused. Live snapshots refresh the selected work;
revocation clears its content. Group membership, scopes and reviewed execution
permissions move into settings. These moves do not create a second approval,
message queue or execution path. Sync status remains visible and explicitly
refreshable on touch clients; technical sequence/version and model attempts are
available through advanced details.

The shared mention composer keeps caret-based insertion, filtering, maximum-two
selection and metadata retention. It adds an explicit @ action, a menu above the
composer, autosize and composition-aware presentation. Keyboard viewport handling
reuses the existing visualViewport hook, now measuring initially and clearing its
delayed focus work/global height on unmount. Plain Enter is not a send command.
The Group send action and retained unacknowledged command payload remain unchanged.

The first focused browser run passed five cases and failed two that still tried
old always-visible settings/refresh controls. Restoring the visible sync control
and updating explicit settings open/close interactions retained all original
assertions. The seven-case rerun passed in 1.2m. It covers native delegation,
exact approval, lost ACK, process/Worker restart, account revocation and the
Chief-to-local-device Goal chain. The screenshot case additionally exercises a
synthetic composition sequence and visualViewport keyboard resize; these are
Chromium simulations, not physical keyboard/IME acceptance. Full slice gates and
screenshots are collected before ready. No Node or Worker source is edited here.

The complete Group browser regression passed 27/27 in 5.1m after the final layout
review. The read-only screenshot fixture now creates Chief, Researcher and
Developer through the actual Profile/Group APIs, without dispatching extra Bot
work. Browsing, mentioning and theme/layout changes preserve the frozen model-call
count. The full [Group matrix](frontend-redesign/group/after/) includes Chief,
contacts, Goal, approval, timeline, mention and simulated keyboard views in both
themes. [Desktop timeline](frontend-redesign/group/after/desktop-dark-group-timeline.png),
[mobile mention](frontend-redesign/group/after/mobile-dark-mention.png) and
[mobile approval](frontend-redesign/group/after/mobile-light-approval.png) are
representative. Node/workerd/authority regressions are running; CI must pass for
the submitted head before this slice is ready.

## My Work and Attention slice

My Work presents server-owned Goals as a flat list with all/running/attention/
completed filters and a link to the existing business schedules. Budgets remain
actual started-run counters, not invented planned steps or completion percentages.
Desktop keeps detail beside the list; tablet/mobile use the shared Sheet. Team
names come from the existing authorized Group snapshot. Evidence counts use the
existing Goal receipt ledger, with local-read evidence retained separately.
Configuration for devices, memory and routines is secondary and keeps its original
API/actions. Step linking and raw execution diagnostics are expandable details.

The same Team attention projection is reused on Chief and My Work. The only Node
edit adds a specific work query to existing authorized approval links. A Group
opens that requested work only after matching an authenticated server snapshot;
the URL grants no access and reconnect never reopens a dismissed panel. Completed
work can read its already-authorized artifact approvals in the same existing
Handoff detail. No new approval or artifact protocol is introduced.

Device review moves the original exact one-read grant action into the shared
Sheet, keeping owner, request, path, deadline and revision checks on the server.
Its pending client attempt freezes the original body/key and prevents concurrent
send gestures. Dismissal grants nothing. Focus returns to the origin when it still
exists. Goal creation similarly retains an unacknowledged attempt and its displayed
values across explicit Sheet close/reopen in the mounted page; retry remains an
explicit action using the original key/body. This is not a new browser-reload or
server-execution recovery protocol.

Confirmed 403/404 Goal reads clear old private detail. Switching Goal selection
clears the previous detail before a delayed read can expose old action buttons.
Sensitive mutations continue to use the existing goal ID and expected revision.
The new mock-API cases test these display/identity fences; the actual HTTP product
case tests one-click attention-to-original-work, device approval and verified Goal
completion. Its model output remains a fixture.

The first focused run passed 7/8 and exposed a screenshot navigation path that
had not dismissed the new Goal Sheet. The revised nine-case run passed in 52.3s,
including the real local Node/Worker/Device path and the two new mock-API cases.
Final copy/focus checks and the full slice regression follow before ready.

The Group slice's full Node regression passed 385 files / 3,132 tests with 23
existing skips. One concurrent local workerd run observed an already-delivered
outbox row where a timing-sensitive test expected pending (60/61). No Worker or
fault-test code/assertion was changed. The full unchanged serial rerun passed
61/61 in 275.13s, followed by 11/11 authority cases in 133.11s and Runner self-test.
This documents an observation race, not a frontend fix to Runtime recovery.
#53 exact-head remote CI passed all three jobs in run 39304642966 and was marked
ready. #54 remains subject to its own exact-head CI.

The final My Work complete browser run passed **29/29 (5.0m)**. Before that, full
runs found old link/title locators and unexpanded routine/memory settings. They
were corrected with explicit, idempotent expand gestures, retaining every original
runtime, source-permission, receipt, file and model-count assertion. The longest
Session/Scheduler/routine/Memory chain also passed independently in 46.0s. No
retry count, timeout, safety assertion or test exclusion was relaxed.

The [Work screenshot matrix](frontend-redesign/work/after/) covers desktop
1440 × 900 and touch 390 × 844 in both themes, with Goal progress, Attention,
exact approvals, task/mention/keyboard states and the actual finite-file device
review. Examples: [desktop Goal](frontend-redesign/work/after/desktop-dark-goal.png),
[mobile Attention](frontend-redesign/work/after/mobile-light-work-attention.png),
[device permission Sheet](frontend-redesign/work/after/device-permission-sheet.png).
Generated types, full typecheck and all component/Worker dry-run builds passed;
The full Node suite passed 385 files / 3,132 tests with 23 existing skips
(132.10s), workerd passed 61/61 (275.09s), and authority passed 11/11
(133.41s). Electron build, Agent Runner self-test, docs and credential checks
also passed. Exact-head remote CI is required before ready.
The earlier Group PR #54 passed all remote jobs in run 39306869320 and is ready.

## Settings and final polish slice

Settings defaults to the current user's Profile; existing explicit model/system/
management links and all permission/password guards remain. Settings sections use
flat headings and separators. Resource selection for Skills, MCP and Memory uses
native list surfaces; provider/billing status and neutral colors use the shared
semantic tokens. The old highlighted pricing glow is removed. Profile configuration, usage and billing retain the
existing APIs and actions. Settings navigation uses the same bottom Sheet below
1101px and returns focus to its opener.

Work titles use the first non-empty objective line, capped for list/header use.
Full objectives, including existing untrusted event metadata, remain available in
an explicit disclosure. The stored objective, frozen context, criteria, evidence
and execution behavior are unchanged. Native continuity labels use the existing
server status mapping and distinguish missing state from idle; no control action
or reconnect behavior is changed.

The existing keyboard hook is shared by composers and a small app observer. It
keeps one viewport/focus subscription and clears it after the last subscriber,
avoiding a conversation unmount resetting an open form Sheet's height. The app
shell itself does not re-render for every viewport event. Bottom Sheets stay
above measured keyboard occlusion; coarse input text avoids automatic small-input
zoom. Synthetic scale changes are not treated as keyboard occlusion. This is
frontend viewport handling, not a physical iOS/Android claim.

The new isolated actual-API browser case visits Profile, preferences, models,
Profile configuration, Skills, MCP, Memory, usage and billing on desktop, touch
and tablet in both themes. It checks page errors, horizontal overflow, theme
heading geometry, Settings Sheet/focus and that viewing these pages starts no
model request. The existing actual-API matrix adds a keyboard-visible Goal form
and synthetic zoom/route-cleanup checks while retaining model-call counts.
The full browser regression passed **30/30 (5.4m)**. An old Cloud Session
idle-label assertion was updated to the new public copy, retaining the original
submission identities, recovery checks and result/receipt counts. After the final
pricing highlight review, Web was rebuilt and both layout matrices passed again
(45.5s); the [100-image final matrix](frontend-redesign/polish/after/) combines that
fresh build's 97 screenshots with the full run's three completed Device/Team
screenshots. Desktop is 1440 × 900, touch 390 × 844 and tablet 900 × 1000, in both
themes. See [dark Group](frontend-redesign/polish/after/mobile-dark-group-timeline.png),
[keyboard-visible Goal](frontend-redesign/polish/after/mobile-dark-goal-keyboard-emulated.png),
[device review](frontend-redesign/polish/after/device-permission-sheet.png), and
[desktop Profile](frontend-redesign/polish/after/desktop-dark-profile.png).

The first full Node regression found two expected-copy mismatches in the existing
Settings and Memory UI tests. Only renamed labels were synchronized; the Memory
heading assertion was tightened to the exact H1. All original scope/JID, revision,
permissions, provider and management checks remain. The complete unchanged-count
regression then passed **385 files / 3,132 tests**, with 23 existing skips (129.37s).
No assertion was removed and no timeout or retry/skip setting was expanded.
The serial workerd suite passed **61/61 (275.07s)**, and actual Node/workerd
authority integration passed **11/11 across 7 files (135.34s)**. Generated sources,
full Node/Web/Runner/Cloud/Electron typechecks, backend/Web/Runner/Electron builds,
Wrangler dry-run, Agent Runner self-test, formatting, docs and credential checks
passed. No Runtime/Worker, dependency, schema, Scheduler, permission or device
protocol source was changed by this slice. Exact-head remote CI is linked from
the final PR and must pass before ready.

My Work's initial remote CI run 39312610460 passed both Cloud jobs. The
validate job timed out at the unchanged 5-second late-authority test
(`tests/cloud-authority.test.ts:657`), after passing format/generated types/
typecheck. The same case passed the local full regression and earlier slices.
Only failed jobs were rerun on the identical commit; no timeout, assertion, skip,
Runtime or workflow setting was changed. Attempt 2 passed all three jobs on
`f409edaf6635dd589f99de4e638be2e9cf9ab2ba` and #55 was marked ready:
[CI evidence](https://github.com/helsome/miniclaw/actions/runs/39312610460).

## Reproduce the product review

Use the existing isolated product fixtures, not a permanent mock dashboard:

```sh
npm run build:all
npm --prefix apps/cloud-agent run build
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm --prefix web run test:e2e
```

A local Chromium path is optional when the locked Playwright Chromium is installed.
The complete command keeps every browser case, including legacy chat controls,
source/Workspace permissions, account switching, hash/subpath routes and approval
receipts. `team-final-convergence.spec.ts` exercises Chief → Researcher → Developer
→ exact device permission → independent finite-file Device CLI → approved artifact
→ evidence-backed completion, then closes/reopens the client and switches account.
It uses the actual compiled Node/Scheduler, workerd/PiHarness, SQLite and Linux
Device CLI. Inference is a deterministic HTTP fixture.

For a short product review, inspect Chief's composer and current work, open the
Group's activity, follow attention to the original approval, review the device
permission Sheet, and reopen the finished work/evidence. The automatic fixture
creates disposable credentials/data and removes its processes and files. A timed
90-second physical-device or live-provider demo is not claimed.

Revert each presentation commit in reverse stack order to roll back its UI; there
is no data migration, runtime-owner switch or conversion of old sessions. Server
flags, ACLs, expected revisions, original submission/decision keys and receipts
remain authoritative. Read-only Team presentation additions are additive.

Physical iPhone Safari/PWA, Android keyboard, Electron GUI, vendor-model inference
and deployed Cloudflare lifecycle acceptance remain unverified in this environment.
The screenshots cover Chromium desktop/touch/tablet; synthetic keyboard/IME/zoom
checks are explicitly emulation. No production resource was changed or deployed.

## Final integration repair

The initial #57 tree (`1572716`) omitted the reviewed Group page: its
BotGroupsPage still matched parent main while Context, attention links and tests
came from the new frontend. An isolated actual-API run reproduced the missing
“团队群聊” heading; the diagnostic was stopped after reproducing the omission,
not recorded as a passing full suite. Restoring the exact reviewed page from
`054f9b7` resolved the Group failures. A complete run then passed 29/30 and exposed
the other integration regression: normal login navigated to `/chat` instead of
Chief `/bots` after the main #51 input changes were retained. Only that normal
login destination was corrected; exact-input attributes, password change and
administrator setup branches remain.

After both repairs the unchanged full browser suite passed **30/30 (5.2m)**,
followed by **388 Node files / 3,144 tests / 23 existing skips (121.43s)**.
Generated types/full typechecks, backend/Web/Runner builds, Worker dry-run,
Runner self-test and format/docs checks passed. The Group source is byte-identical
to the reviewed `054f9b7` version. No test, timeout or skip was changed. Both UI
repairs stay in #57; the new avatar work (#58/#60) remains separate. Exact-head
remote CI is linked from #57 before its release gate is considered passed.
