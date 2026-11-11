# Server-owned Bot Groups (Issue #32)

Implemented behind `MINICLAW_BOT_GROUPS=true`. `/bots` links to `/bot-groups`;
`/bot-groups/:groupId` is the shared chat view. The existing `/groups` compatibility
redirect and all private Workspace conversations remain unchanged. The new view
uses the same Web/PWA/Electron app, authentication, components and WebSocket.

## Identity and authority

A Group is a persisted internal UUID, not an IM chat JID, Workspace, Profile or
Runtime Session. The creation UI asks for a name and lets the Owner select
multiple existing Dots, with their names and avatars. One transaction adds the
Owner and the complete selected roster; invalid, disabled or foreign Profiles
reject the entire request. Deselected Dots are not added implicitly.

`POST /api/bot-groups` accepts optional `bot_profile_ids` (1–49 UUIDs,
deduplicated and sorted for receipt identity). The server automatically chooses
an accessible owned Web Workspace, preferring Home, as its storage anchor.
`workspace_jid` remains an optional explicit API override for existing clients;
omitting `bot_profile_ids` retains legacy creation with the default Dot. Exact
retries return the original receipt without selecting an anchor or roster again.
Creation does not create a Profile, Workspace, Goal, scheduler job, model request
or runtime. When Group execution is available, selected Dots automatically get
baseline text-chat configuration using an existing owned conversation and model:
public Group context, bounded model calls and public replies, with no tools.
A Dot whose model is not ready can still join the saved roster; preparing or
sending later reports model readiness rather than asking for per-Dot permission.

Owner message submission and enabling discussion prepare/renew model-only
configuration in the same transaction. Existing Groups are supported without
manual scope/grant forms. One-click “开启群聊讨论” uses current active Dots. An
unmentioned message targets an actual roster Dot even if the default Dot was not
invited. An already reviewed non-empty tool grant is never silently renewed by
ordinary chatting. Extra file/tool capabilities remain in advanced settings;
user invitation, foreign-owner access and external effects retain their existing
checks. Model-only defaults do not trigger or replay a message.

Each operation rechecks the active caller, active membership, active Owner,
current registered Workspace/mirror identity, ownership and Host policy. Another
administrator has no Group override. Explicitly invited users may read/post in
this shared timeline; this does not grant access to the Owner's Workspace files,
private conversations, provider credentials, memory or tools. Copying private
information into a shared user message is an explicit disclosure to its members.

Owner can configure the Group and members. Moderator can invite ordinary users
and disable/remove ordinary users. Moderator cannot promote moderators, change
Owner, add/configure Bots or grant Workspace scope. Owner identity is immutable.
Disabled/removed users cannot read, post or receive subsequent Group updates.
Archived Groups remain readable by their current members; no new message is
accepted. Authorized revocation remains possible with new-admission disabled.

Bots reuse the Owner's existing active Profile IDs. An optional explicit scope
must be an owned, currently accessible Workspace whose effective Profile matches
that Bot (Home always uses Chief). A changed mapping or revoked policy makes the
Bot unavailable; it cannot borrow a different Workspace. Disabling/removing a
Bot does not require its stale scope to remain usable. User and Bot membership,
Workspace configuration and execution capabilities are separate authorities.

With only `MINICLAW_BOT_GROUPS=true`, Bots cannot execute. Optional
`MINICLAW_BOT_HANDOFFS=true` enables the explicit, expiring execution-grant and
[native Handoff](bot-handoffs.md) flow for Owner requests. A mention or Workspace
scope alone never grants model/tool authority. Native replies use actual
Submission/producer-Task/answer receipts; no synthetic Bot identity is admitted.

## Persistence and receipts

Schema 80 adds four independent tables: `bot_groups`, `bot_group_members`,
`bot_group_messages`, `bot_group_receipts`. Group/member identity and committed
message/receipt fields are immutable. Author, timestamp, UUID, sequence and
source are server-generated. The strict message API rejects forged identity,
Bot author and runtime fields. `source` records the authenticated actor and
system mutation details; runtime/task are null until native execution exists.

A SQLite transaction commits the ordered message, revision, quota and receipt
together. Each user-scoped `Idempotency-Key` binds operation, Group and normalized
payload. Exact retry returns the original message/sequence and a current,
authorized snapshot. Changed payload or cross-Group reuse conflicts. A removed
member cannot recover an old receipt to regain access; replaying an old invitation
cannot restore membership. Stored receipt provenance is verified against its
immutable canonical message before returning it.

Limits are 100 Groups per Owner, 50 roster entries including removed identities,
and 10,000 user messages per Group. System revocations/archival do not consume
user-message quota. A removed identity is reactivated by explicit member PATCH,
not re-added as a different identity. No external delivery guarantee or model
budget is implied by these limits.

## Snapshot and multi-device reconciliation

Snapshot reads provide `epoch`, `revision`, `last_seq`, current membership, roster
and ascending canonical messages. The newest 50 messages are default; pagination
uses `before_seq` and at most 100 messages per page. New process = new epoch,
while persisted message IDs, sequence and receipts remain unchanged.

The existing authenticated WebSocket broadcasts only Group IDs/version/event ID
as best-effort invalidation to currently authorized members. A removed user gets
a minimal revocation notice, no message body. The browser then reads the canonical
snapshot; ordered versions and gaps do not require replaying chat events. A
foreground/online/reconnect refresh and a visible-page 15-second read fallback
repair lost invalidation and policy changes. This fallback never submits input,
starts a runtime or schedules an Agent. Snapshot requests are serialized; an
invalidation, disconnect, Group/account change or revocation fences a response
already in flight. Revocation immediately clears rendered private content.

One pending command journal is retained in `sessionStorage` per user/Group (and
one for creation). It stores the exact request ID/path/payload before sending.
Unknown acceptance blocks another command and offers explicit same-key retry.
Refresh/reconnect/remount only reads server state. Confirmed rejection allows
correction. A browser session ending or clearing its session storage loses this
local journal; the canonical server message/history remains. This is local
pending-input continuity, not a server runtime checkpoint or cross-device draft
synchronization. Timeline history and accepted state are shared across devices.

## Migration, backup and rollback

Normal startup performs the existing verified private pre-migration SQLite backup
before changing schema 79 to 80. The new tables start empty. No legacy chats are
converted to Groups, and no Node/Cloud runtime changes ownership. Existing Cloud
placement bytes, Root identity, model-attempt budget and Coding JSONL identity are
preserved. Version 80 does not rebuild the unrelated version-79 Cloud ownership
trigger; the migration test distinguishes its retained SQL explicitly.

Deleting the anchoring Workspace or Owner follows the existing FK cascade policy:
its Groups, membership, history and receipts are permanently removed. Ordinary
Workspace rename uses the existing in-place upsert and preserves all Group data.
The existing Workspace deletion confirmation now includes this Group impact.
Back up consistent database and filesystem state before destructive operations;
a running service's WAL/database files must not be copied independently.

To roll back admission, set `MINICLAW_BOT_GROUPS=false` and retain schema-80-aware
code for history, snapshots and revocation. Existing native runtimes are unaffected.
A schema-79 binary cannot open schema 80. Full code downgrade requires quiescing
writers and restoring an explicitly selected consistent pre-upgrade backup to
an isolated/verified deployment, accepting the loss of later Group writes.
Never edit the schema version marker or delete tables to force a downgrade.

## Reproducible checks

```sh
npx vitest run tests/bot-groups.test.ts tests/schema-v80-bot-groups.test.ts tests/bot-group-client.test.tsx tests/db-upgrade-safety.test.ts
make typecheck
npm run build:all
npm --prefix apps/cloud-agent run build
npm --prefix web run test:e2e -- bot-groups.spec.ts
```

The browser acceptance launches a private compiled backend, database and four
independent authenticated browser contexts (desktop, iOS-style Hash mobile,
invited user and outsider administrator). It creates a Group through the actual
UI, invites through the UI, sends real HTTP/WS timeline updates, drops a receipt
after a real backend commit, verifies explicit retry deduplication, disconnects
mobile, submits concurrently, SIGKILLs/restarts only its private child process,
pages real persisted history and revokes membership through the UI. It asserts
no runtime inbox or scheduler job was created. Private fixtures are removed.

This is real local HTTP/WebSocket/SQLite/browser/process acceptance, **without
model execution**. The iOS client is Chromium emulation with a standalone hint,
not a physical iPhone or Safari. No Cloudflare deployment, billing, live provider,
native Bot response, Handoff or device execution is accepted by this milestone.
Exact full-suite results are recorded in [evaluation.md](evaluation.md).
