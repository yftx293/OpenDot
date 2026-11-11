# Bot Team product convergence

This slice connects the existing Goal/Group/Handoff/Cloud/Device systems. It
introduces no planner/runtime, business scheduler, messaging, approval or device
protocol. #47 and #48 provide the underlying coordination and Cloud device bridge;
review/merge their dependencies before this product change. Local Node/Web
acceptance and deployed Cloudflare acceptance are recorded separately.

## Creation and refresh follow-up — 2026-10-21

Primary “新建 Dot” opens one responsive name/shape/color dialog. Creation binds
an owned assistant workspace atomically and enters that conversation immediately.
A per-owner request receipt survives lost responses/reload, while permission and
quota checks stay on the server. The advanced editor remains separate. Nullable
avatar shape travels through workspace, Group, chat and Team identities; legacy
avatars keep their fallback. The dialog keeps its footer reachable when its body
scrolls, and retains the existing motion/reduced-motion behavior.

Disabled personal Goals no longer cause the team-options request. Enabled
Goals still load reviewed Teams through the existing endpoint; an actual error
invalidates the view rather than being treated as an empty successful response.

## Conversation navigation follow-up — 2026-10-21

“Dot 和对话” is the shared entry for finding an existing Dot, opening another
workspace conversation and creating a new Dot. Browse, creation and per-workspace
history use one left-side Sheet, with explicit back-to-list and close controls.
The phone header opens this navigation instead of treating “Back” as a hidden
session-list action. Desktop search/new-Dot controls and the tablet rail use the
same surface. Settings no longer duplicates identity creation/navigation.

The history body is portalled from the live ChatView into this Sheet, preserving
its current session selection, original actions and server-derived state. Existing
`?sessions=1` links and reloads remain supported. Dot history links retain the
fresh, owner-scoped server entry check before selecting an authorized workspace.
Read-only list navigation never creates a workspace or invokes a model. Legacy
unbound Profiles still require the existing explicit workspace setup.

The name/shape/color form keeps the atomic creation receipt, lost-response retry,
owner checks and reachable footer, with phone safe-area insets. A stale entry guard is reset on effect cleanup,
so development StrictMode remounts cannot cancel the only Dot-entry request.

Browser acceptance passed the unified create/find/history/other-conversation flow
at 320, 390, 1100 and 1440 CSS pixels. Each navigation view was the single visible
left-side dialog; short-screen creation, search, remembered-session preservation,
history reload, Escape and focus return were checked, with no page/console/HTTP
errors and zero model requests in the navigation-only journey. Separate existing
quick-create/first-reply/lost-ACK and mobile settings/advanced-editor regressions
also passed. Eight focused unit files passed all 42 checks; Web and E2E TypeScript
checks passed. This is browser emulation, not physical phone acceptance.

## Model dispatch and verification follow-up

Node Durable provider discovery/auth refresh no longer consumes model attempts.
Each real stream dispatch authorizes and charges once; SDK retries are disabled,
and the existing Harness alone owns any further attempt within its persisted
grant. A 60-second stream boundary aborts a stalled transport, preserves caller
cancellation and rejects late success. Model fetch uses the same installed Undici
as the proxy dispatcher. Actual startup/model-attempt summaries and allowlisted
failure codes are exported without private content. See the two consecutive
[real-model acceptance runs](bot-team-live-acceptance.md).

## Product behavior

Normal login opens the Bot-first homepage; mandatory password change still opens
settings. Returning to that page resets its existing app scroll container once,
without moving an active draft on subsequent snapshot refreshes. Chief displays a
compact Goal action and a server-derived attention count. Expanding “创建团队长期目标”
lets the owner enter objective/criteria, choose an existing reviewed team, bound
its steps and optionally declare a finite local file. Runtime/Workspace IDs are
not part of this flow. Existing chat, profile, workspace and advanced execution
configuration remains available.

The page shows running Goals, recent completed results, Group Chats and a single
“需要你处理” area for existing Goal/Handoff tool approvals, exact device permission,
offline device waits, human completion/input and unresolved uncertain effects.
It links to existing controls; device confirmation calls the original grant API.
Model labels, configured capability summaries and current task/activity come
from existing profile and committed server data. No client state declares work
complete. Goal detail also shows hash-verified local evidence, not file contents.

`GET /api/team-overview` is an authenticated private/no-store SQLite snapshot.
It reuses current Group ACL, owned Goals, Host policy and original runtime approval
checks. Shared Group membership never exposes another owner's private Goal or
approval APIs. Reconnect, relevant Group events and visibility/online restoration
refresh it; bounded UI polling observes business state and never invokes a model.
It is not offline push. Request generations and owner checks reject late replies;
account changes unmount and clear the old data. A failed revalidation clears
attention rather than treating cached permissions as authority.

Group composing uses `@` suggestions with explicit profile identity, keyboard
arrows/Enter/Tab/Escape and touch targets. Deleting/editing the token drops its
metadata; plain model/user text does not invent a selected profile. Two selected
Bots is the maximum; the existing dispatch/discussion intent remains separate.
Saved Goal step envelopes show a human summary and an optional contract detail;
tool traces and execution IDs remain in expandable details. Recovering progress
uses the signed persisted runtime projection, not socket connectivity.

## Local evidence requirement

Schema v85 adds an optional immutable declaration to the existing Team association.
A paired device/path declaration grants no access. A separately approved actual
read receipt is required even if a prior report contains every completion keyword.
The next existing Scheduler occurrence may advance another reviewed Bot within
budget. Automatic and manual completion cannot bypass the declared local evidence.
See [Goal Teams](goal-teams.md), [device nodes](device-nodes.md) and
[migration](migration.md) for the exact boundaries.

## Reproducible product scenario

After locked installation/build and the independent Worker dry-run:

```sh
PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
npm --prefix web run test:e2e -- tests/e2e/team-final-convergence.spec.ts
```

This starts disposable compiled Node/HTTP/Scheduler, real local workerd/SQLite/
PiHarness, explicit Researcher/Developer grants, actual product pages and a
separate existing Device Node CLI. It reads a real finite temporary file and
creates real private artifact receipts. The fixture controls model responses
and the test HTTPS hostname route. Desktop explicitly uses a desktop viewport,
non-mobile context and desktop UA; the second context uses touch and an iOS-style
hash router in Chromium. It is not a physical phone or deployed Cloudflare test.

The scenario creates a Goal from Chief, closes that desktop page, uses phone UI
for the first report approval, proves that report keywords cannot bypass local
evidence, observes the second Handoff waiting for its offline device, approves
one exact file, reconnects the actual CLI and phone, approves the final artifact
and reopens the same completed Goal/evidence. It checks two Handoffs, two native
inputs, five fixture provider calls, one cached file read and two result messages.
Keyboard/touch mentions then post discussion only, without executing more Bots.
Finally it logs out/in on the same desktop, delivers a held old-owner snapshot,
and verifies that the new account sees no old Goal/attention. The test uses real
account endpoints and an explicitly injected stale HTTP response.

The test also saves owner-only UI screenshots for review. Synthetic markers and
file content are disposable fixtures; screenshots/traces are not real credentials
or a vendor acceptance record. Provider tokens and deployed costs are not measured.

## 90-second presentation

With already paired nodes and reviewed team grants, open Chief and create the
architecture/local inspection Goal. Show Researcher progressing, then its approved
report. Switch to the phone attention area: Developer requires the declared local
file. Confirm that one request, reconnect the node and show Developer's approved
report, Goal completion and verified local evidence. Close/reopen the page to show
the same history. The automated fixture can execute this sequence within the
presentation window; real model latency and physical background behavior remain
unverified. Users must still review actual tool content before approving it.

## Release boundary

Local workerd, real Linux processes/files, mocked inference and Chromium emulation
are separate evidence classes. Cloudflare staging deployment/lifecycle/cost,
requested Zen provider inference, physical iPhone/Android, native Electron GUI and
external IM delivery with real channel credentials are not established by this
scenario. Existing unit/regression coverage is not a claim of real IM acceptance.

The earlier managed-cloud preflight reported a missing secure Zen binding.
On 2026-10-21, an authorized local environment passed a separate real-model
[directed two-Bot Group scenario](bot-team-live-acceptance.md), including original
approval recovery, actual workspace reads and mobile artifact approvals. Two
later runs on `9cce601` failed at restart readiness and bounded two-Bot
completion. The earlier pass is historical; real-model end-to-end repeatability
is still an open gate. The complete Cloud/Device Goal scenario above still uses
simulated inference. Keys stay outside Git and traces.
#34/#35/#30 remain open for their applicable deployed/physical/IM release gates.
