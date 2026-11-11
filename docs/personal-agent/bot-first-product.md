# Bot-first entries (Issue #31)

This is an additive product entry built on the existing Agent Profile and Workspace APIs. It does **not** create a competing Bot runtime, change Session ownership, or claim multi-bot group execution exists.

- `/bots` lists the current user's existing Profiles. Opening requests a fresh
  Cookie-authenticated `GET /api/agent-profiles/:id/chat-entry` rather than
  trusting cached Workspace metadata. The server selects only an owned Web
  Workspace whose current effective Profile matches; Host execution requires
  current privilege. Chief resolves only the current user's Home. Multiple
  matching professional Workspaces are ordered by creation time, then JID.
- Chief is the display label for the default profile; existing backend identity and permissions are unchanged.
- Bot creation/configuration delegates to the existing Agent Profiles editor,
  including its avatar, model, Skills and MCP authorization rules.
- Existing `/chat`, `/goals`, Pocket, Pi Coding Agent, Node Durable, and Cloudflare opt-in Sessions remain authoritative.
- A professional Bot without a Workspace opens the existing creation dialog,
  prefilled with that Profile. Creation still requires user confirmation and
  the original Workspace API/permissions. Merely opening a Bot never allocates
  a Workspace, Host grant, Session or runtime. Chief without an authorized Home
  reports the missing entry instead of inventing one.
- Issue #32 now links the Group card to the [server-owned shared timeline](bot-groups.md). Native Bot execution remains a separate, not-yet-enabled Handoff milestone.

## Profile, Workspace and Session

A Profile is reusable identity/configuration, a Workspace owns resources and
permissions, and a Session owns a conversation/execution. The entry explicitly
opens the Workspace main conversation (`?bot=<Profile ID>`); it does not restore
a remembered child Session. Choosing a Session manually leaves Bot-entry mode.
This is not an independent immutable Bot runtime or a second profile store.

Bot-mode main messages carry `expectedAgentProfileId` through the existing HTTP
message API. The same optional precondition is supported by WebSocket admission.
Normal ACL/Host checks run first; a reassigned/archived/missing Profile or a child
Session target is rejected before storing the new message or dispatching work.
Legacy requests without the field retain their existing behavior. The check
protects admission against a stale Bot page; it does not freeze all subsequent
Workspace governance or replace the runtime's existing identity/lease rules.

Account changes fence pending navigation responses. Entry replies are private,
noncacheable and contain no credentials. The browser checks returned owner,
Profile, folder and main-conversation scope against refreshed state. Existing
`/chat`, `/agent-profiles`, `/goals`, Pocket and router basename handling remain
available. `VITE_BOT_FIRST_HOME=false` rolls back default-home/navigation entry
at build time; it does not migrate data or change any runtime ownership.

Deploy the additive backend entry/precondition support before the new client.
For rollback, disable the default UI entry while retaining these backend checks
for already-open Bot tabs. An older backend strips unknown message fields and
cannot enforce this precondition; replacing it is not a safe way to retire an
active Bot-mode client. Quiesce/reload those clients before a full code downgrade.
There is no new schema, data conversion, grant, scheduler or runtime owner.

## Next milestone (#32–#35)

Issue #32 introduces server-owned Bot Group, membership ACL and canonical group timeline; its current behavior and migration are documented separately. Next add directed `@Bot` routing and durable handoff receipts. Separate profile identity, group membership, and session ownership. Test duplicate dispatch, revocation, cross-workspace leakage, cancellation and Cloudflare recovery before enabling persistent Bot-to-Bot collaboration.

## Validation

Baseline: PR #29 `c9f836463b1aeac4deb2f3b6af11db19b1309853`, stacked on PR #26
`fd906b729e1ad6b3576bc88d92b2075337dde8ba`. The original validate run
`39114650513` failed formatting; a local full Typecheck then exposed an unused
icon import. Both were corrected without skipping checks. Existing Cloud and
Node recovery changes in other worktrees are not part of this Issue slice.

Five actual SQLite/Cookie cases cover owned entries, another administrator,
missing Workspaces, reassignment and live Host revocation; five pure routing
cases cover the UI hint without treating it as authorization. Existing Agent
Profile route regression passes. Builds and full Typecheck pass at the current
checkpoint. Two expanded actual-backend browser cases pass (53.1 seconds) on root and
`/mini` deployments. A private basename build and actual HTTP/WebSocket reverse
proxy cover the latter, including the bare `/mini` entry, deep navigation and an
iOS-style standalone/hash client. They create a Profile in the existing editor,
confirm its Workspace, obtain actual Pi Coding Agent replies, refresh/back on
the phone, deny another administrator, reject stale HTTP/UI/WebSocket inputs
without storing them, retain a rejected draft, revoke Host privilege through
the existing admin API and enforce logout. Anthropic HTTP model replies are
fixtures; iOS signals run in Chromium, not a physical Safari device. The first runs identified
an omitted owner field in the destination contract and the dialog's default-
selection race; fixes retain server authorization and explicit Profile binding.
The subpath test also reproduced Router's trailing-slash basename blank page;
the Router now accepts both `/mini` and `/mini/` while asset/API helpers retain
their deployment prefix. Fixture issues (an omitted prefix in a response filter,
bare-prefix proxy routing and an ambiguous sidebar-preview text locator) were
corrected without relaxing the product assertions. The old terminology assertion
was updated for the requested Bot-first navigation, retaining existing negative
terminology checks and adding a functional entry-rollback test.
Final Node regression passes **367 files / 3,038 tests / 23 existing skips**
(89.60 seconds). Full Typecheck, the final backend/Web/runner builds, runner
self-test, formatting and documentation checks pass. All **18 browser cases**
pass (2.5 minutes), including existing Cloud Session/approval, device-node,
Durable Session and mobile interaction regressions. An initial full run omitted
the isolated worktree's Worker bundle; after running the existing CI dry-run
build prerequisite, the complete suite passed. The expanded remembered-child
check also passes: a manual child selection stays remembered by the legacy
Workspace route, while reopening/reloading the Bot entry stays on main.
Remote CI remains pending at this checkpoint. The additional
empty-Profile-list check overrides only that list's GET to test UI presentation;
it does not delete the protected default Profile or provide ACL evidence.
No deployed Cloudflare,
vendor inference, real iOS device or production migration is claimed.
