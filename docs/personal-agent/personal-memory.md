# Personal Memory

## Implemented scope

`MINICLAW_PERSONAL_MEMORY=true` enables explicit Personal Memory management on
the Goals page and through `/api/personal-memory`. It defaults off. The existing
Home Workspace Memory store owns the content, revisions, actor/provenance,
forget tombstones and mutation receipts. No second memory database or automatic
workspace merge is introduced.

Saving explicitly authorizes use in the actual owner's Home Workspace. Other
owned Web workspaces require a per-item grant bound to the current memory
revision. The UI states both scopes before its required confirmation. A private
fact in an ordinary Workspace, or an unpromoted Home fact, is never added to this
cross-task Personal Memory index automatically.

The four existing scopes remain distinct:

| Scope            | Current behavior                                                                        |
| ---------------- | --------------------------------------------------------------------------------------- |
| Personal Memory  | User-confirmed Home items, explicit destination/revision grants, read-only Durable tool |
| Workspace Memory | Existing per-workspace service, ACL, revisions, provenance and recall rules             |
| Goal Memory      | Frozen Goal contexts, recent verified results and scoped artifact/evidence history      |
| Session Context  | Committed native conversation/tool results and existing Session history                 |

## Save and revise

In **个人委托 → 个人记忆**, enter a fact or select a verified artifact from the
currently selected completed Goal. Review the text, choose additional workspaces,
and explicitly confirm saving to Home and sharing this revision. Source capture
accepts only an exact substring of the actual hash-verified private artifact.
It derives Goal/Session/artifact identity on the server; callers cannot claim
arbitrary source IDs, automatic completion or another user's evidence.

Source capture rechecks the original runtime's ownership, current Host privilege,
provider/profile/workspace fingerprint, completed Goal binding and verified
artifact evidence. A stale or unauthorized source fails closed. Ordinary manual
facts are labelled as the user's own input and do not claim artifact verification.

The immutable origin records the initial artifact and captured-content digests.
Later explicit user edits retain this lineage and are marked as revised since
capture. Current native provenance and revision history identify those edits;
the initial artifact is not presented as proof of newly edited text.

Editing through either this panel or the existing Home Memory editor increments
the native revision. Existing cross-workspace grants then stop matching. A
Personal Memory update explicitly confirms content and its complete new scope
set together in one transaction. An old request retry cannot restore scopes
revoked by a later update. An unknown browser outcome retains its original key
and requires explicit retry; reconnect/poll never reposts a mutation.

“遗忘并撤销读取授权” uses the existing revision-bound forget operation and clears
cross-workspace grants atomically. It stops subsequent recall while retaining
the existing revision/audit lineage. Expired, proposed, superseded and deleted
items are not returned. It does not erase facts already present in old Session
transcripts or delivered artifacts. Home Memory remains ordinary user-owned
data if the rollout flag is disabled; disabling a feature does not erase it.

## Runtime read

New Durable conversations can use `read_personal_memory({query?})`. Its query is
bounded to 500 characters. Session ownership determines the account and
destination workspace; the model cannot choose another owner or an arbitrary
source workspace. The existing runtime authorization runs before and after the
read, including live Host/Goal claim checks. The memory layer independently
checks current Home and destination ownership, active account/workspace,
recall eligibility and exact revision grants.

The snapshot returns at most 20 selected entries and 16,000 content characters,
with IDs, revisions, provenance, initial origin and truncation markers. Content
is reference data, not new system instructions. It does not grant write access
to memory or fetch unrelated Workspace Memory. Disabled reads return an explicit
disabled status with no entries. There is no automatic runtime fallback.

Read receipts record Session/tool-task identity, entry IDs/revisions and digests,
not raw fact text. Equivalent safe replay under the same task/snapshot is
deduplicated; a changed revision produces a different receipt. Pi Durable's
committed ToolResult remains the execution checkpoint. An uncommitted read may
be repeated only after current authorization; it is not a side-effect replay.

Already committed conversation history can retain previously authorized facts
after a grant is revoked. Revocation prevents future reads; it does not promise
retroactive erasure or model unlearning. No physical-device or live-model
acceptance is inferred from the local tests.

## API

All endpoints use existing Cookie authentication and exact ownership. The server
selects the user's actual Home; no owner or Home ID is accepted from the caller.

| Method/path under `/api/personal-memory` | Behavior                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `GET /availability`                      | Authenticated rollout status                                      |
| `GET /`                                  | Actual Home ID and latest 100 non-deleted Personal Memory entries |
| `POST /`                                 | Confirmed user fact or verified source excerpt                    |
| `GET /candidates/:artifactId`            | Current authorized, verified completed-Goal artifact              |
| `GET /:id`                               | Owned item, grants, recall status and origin                      |
| `GET /:id/versions`                      | Existing native revision/actor history                            |
| `PATCH /:id`                             | Revision-bound confirmed content and complete replacement scopes  |
| `POST /:id/forget`                       | Revision-bound confirmed forget/revocation                        |

Mutations require `Idempotency-Key`. Create accepts `content` (1–32,768 chars),
optional `title`, `kind`, nullable `expires_at`, `allowed_workspaces`,
`confirmed: true`, and optional nullable `source_artifact_id`. Update requires
`expected_revision` with the same content/scope fields and cannot rewrite the
initial source. Forget accepts `expected_revision` and `confirmed: true`.
Workspace destinations are explicit owned `web:` workspaces, at most 50.
Source and scopes participate in receipt digests. Requests over 192 KiB fail.

## Compatibility and limits

Schema v76 adds only Personal Memory origins, revision grants and read receipts.
Old workspace items are not promoted or shared. Existing Home APIs retain their
behavior and automatically invalidate old grants through revision changes.
Deleting/rebuilding Home Memory follows its existing deletion/retention contract;
this feature never moves it silently to another workspace.

The new read tool is registered for newly initialized conversations. Existing
conversation tool configuration remains governed by its saved Harness root;
no JSONL or existing execution checkpoint is converted. Native metadata and
Memory changes commit together in the product DB. Preserve that DB with the
Durable stores/artifacts before rollback; an older binary refuses the new schema.

Current acceptance uses actual routes, SQLite, files, process restart and browser
actions, with simulated model responses. Live-model inference, implicit memory
writing, automatic fact extraction/merging, semantic embedding retrieval and
retroactive transcript erasure are not implemented or claimed.

## Cloud Sessions

New product Cloud Sessions also register the existing read semantics when
`MINICLAW_CLOUD_MEMORY=true` and `MINICLAW_PERSONAL_MEMORY=true` are enabled at
creation. Their immutable Cloud binding records that explicit tool capability.
Old Sessions keep their existing tools. Current reads travel through the private
signed Tool Gateway and use the original grants, revision rules and audit table.
Disabling the Cloud Memory flag denies new recalls; disabling Personal Memory
returns `disabled`. This bridge adds no memory writes, automatic promotion,
Workspace merging or filesystem access. See [tool-execution.md](tool-execution.md)
for native task identity and replay boundaries.
