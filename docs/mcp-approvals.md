# MCP approvals and native Durable execution

This is the next #103 implementation slice, based on the catalog/client contract
in #112. It adds persistent approval/dispatch receipts and a real Pi Durable
tool adapter. Product-facing startup/session consent and registration inside
`ProductRuntimeService` remain to implement; importing the adapter does not
enable external tools for existing sessions.

## Common approval service

The existing approval database lifecycle initializes MCP storage. Artifact
approvals retain their `create_private_artifact` SQL CHECK, positive Durable
ToolTask requirement and immutable intent triggers. Typed `mcp.call` records
live in the MCP call ledger, which also holds their approvals and receipts.
There is no second browser/device approval service.

Each immutable MCP intent binds owner, Dot, Workspace, Product Session, original
and registered tool names, catalog/schema/server-configuration digests, exact
argument digest, location, grant identity/revision, deadline and cancel
generation. Durable provenance records actual conversation/ToolTask/generation,
the immutable task ancestry and the inputs consumed by that generation. Coding
uses conversation/business-turn/tool-call strings; it cannot insert fake
positive Durable task IDs. Coding transport provenance is a later adapter.

Arguments and original results use the existing host encryption key with
AES-256-GCM. Additional authenticated data binds owner, record and purpose;
swapping ciphertext between owners, calls or argument/result columns fails.
Metadata projections omit ciphertext and bodies. Runner processes receive
neither this key nor database access.

`pending → approved → dispatching → completed` is the successful path. Denial,
expiry and cancellation cannot return to approval. A persistent conditional
update wins dispatch once, before any `tools/call` bytes leave the process.
Neither read-only annotations nor an enabled Profile auto-approve a call.

Once dispatched, a lost ACK, server error, invalid result or interrupted owner
is uncertain and cannot automatically retry. Recovery runs only after the
Runtime acquires exclusive ownership. A proven pre-marker intent remains
approved; a post-marker intent becomes uncertain even when the process died
before sending bytes. There is no rollback claim for an external effect.

Original error and late results are encrypted and retained when available.
Result delivery rechecks current authority: revocation can withhold a completed
result without rewriting the receipt as though the operation never happened.
Cancellation during execution retains uncertainty and any late receipt.

## Native adapter

The Durable generation hook freezes its MCP grants in a native memo before the
first provider request. A ToolTask records its exact call intent in its own
memo. Verification checks committed native ancestry, assistant/nested tool
call, repaired execution arguments, original consumed input IDs and exact
Product Input admission bindings. These reads do not modify payloads, digests,
control receipts or model accounting.

The active member lease, immutable Group grant, cancel epoch and current user
control are rechecked when member provenance is present. An older generation
cannot borrow a newer grant or lease. The same checks run after asynchronous
catalog validation, immediately before the persistent dispatch marker.

Registered definitions and selected tools stay separate; the adapter exposes a
selection function for the current explicit grants. Existing model-only Group
grants do not acquire external tools from Profile configuration. Member
communication grants do not authorize devices.

The existing private-session abort, queue/task abort, Group Stop and session
deletion paths persist MCP fences. Session cancellation generations are
idempotent per control receipt: replaying an old Stop cannot cancel new work
admitted at the later cancellation generation. Trusted cleanup still binds the
immutable owner after account revocation. A task fence also covers nested MCP descendants
through their verified ancestry while preserving unrelated parallel calls.
Pausing a Goal does not silently cancel a still-valid approval for unexecuted
work.

Generic results currently deliver text and bounded structured JSON. Binary,
image and resource-link bodies remain in the authorized receipt and require a
separately approved adapter. No resource is fetched automatically; #101 owns the
image/model and target-scope adaptations through the shared device channel.

## Migration and acceptance

Schema v93 adds the MCP ledger, decision receipts and cancel controls after the
existing private pre-migration backup. The migration test starts from v92,
checks the backup and retained artifact/member records, and verifies that no
historical session receives MCP approval. v89–v92 provenance is not replaced.

The isolated suites cover real stdio/loopback HTTP, exact approval/denial,
cross-owner access, ciphertext scope, immutable SQL guards, concurrent
connections, lost ACK and revocation during execution. Native integration uses
the actual Pi Durable SDK with a synthetic model, including nested parent Stop,
forged provenance rejection and a terminal ToolTask refusing another effect.

The process recovery fixture runs compiled JavaScript with native Node. It
kills an actual Durable owner before the dispatch marker, after the marker, or
after a real stdio effect but before its ACK. Restart retains the same native
ToolTask, generation and call ID. The pre-marker case executes once; dispatched
cases retain uncertainty and do not replay the effect.

These are fixture MCP services and synthetic model answers. Real model/vendor,
Coding native IPC, Group-member product admission, device/Kimi, workerd and
deployed Cloud acceptance are distinct remaining scopes. The factory is not yet
wired into the product's startup/session-grant UI or ordinary chat service.
Mem0 and Langfuse work remains in #110 and #111.

Earlier test failures are retained in the development history. The independent
SQLite reader must check a checkpointed database when its live cross-engine
WAL view lacks a newly written row; the artifact CHECK itself was unchanged.
The full Runtime module is initialized outside the Stop test's five-second
operation budget. Neither adjustment weakens the business assertions or
changes a Runtime execution deadline.

The recovery fixture reports readiness after module/storage initialization. Its
30-second startup watchdog is separate from the unchanged 15-second execution
watchdog; both are asserted, and a watchdog kill never counts as the expected
crash point. The earlier combined-watchdog failure is retained in the private
intermediate report, rather than relabeled as a successful crash proof.

Final validation on the recorded source bytes: root build and root/personal-agent
types pass; all 29 complete relevant test files (148 tests) pass. The source
audit covers 2,092 files with no changes during that run. Formatting and the
108-file documentation check pass. [Source hashes and crash-window receipts](testing/mcp-approvals-2026-10-26.json)
retain the exact command and distinguish this final run from the earlier
superseded failure.

The compiled managed client also passes native Node 24.20.0 and the cached Agent
image `1c4900d908dc` (Node 24.22.1): one actual stdio fixture call, zero duplicate
dispatches, no inherited HOME and child process closed. The image test copies
only the fixture/compiled modules into a disposable, network-disabled container.
It proves client loading, not a clean image build, Coding IPC or product consent.
