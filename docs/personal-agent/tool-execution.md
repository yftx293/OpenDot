# Tool execution across cloud and local runtimes

Administrative Cloud PoC Sessions offer only `inspect_text`: bounded UTF8 byte count and
SHA256 over explicitly provided text. It is safe to replay and has no external
write effect. It does not acquire the computer's filesystem, shell or browser.
Actual workerd/provider/tool tests are in `apps/cloud-agent/test`; their HTTP
provider responses are simulated, not vendor model evidence.

Existing Node tools and explicit paired device file reads stay on their current
permission/receipt paths. Their behavior is documented in
[device-nodes.md](device-nodes.md) and [security.md](security.md). They have **not**
yet been exposed to a cloud Harness. Stdio MCP, native modules, Skills requiring
host resources and general Node filesystem/code tools do not run in Workers.

Additional Tool Gateway capabilities must preserve current owner/Workspace/Host checks and
native Task/Goal authority, then route a declared capability to Cloud HTTP,
a separately authorized sandbox or one explicitly paired local device. A node's
declaration alone is insufficient; grant, expiry/revocation and audit are checked
before dispatch, after return and before the model sees data. Offline local work
must wait for that exact device, without silently moving its data or execution.

Execution classifications remain distinct:

| Class                  | Recovery contract                                                      |
| ---------------------- | ---------------------------------------------------------------------- |
| Safe read/computation  | Bounded replay allowed while current authority remains valid           |
| Idempotent request     | Reuse immutable operation ID and full parameter digest; verify receipt |
| Receipt-required write | Confirm exact parameters, reconcile effect and committed receipt       |
| Uncertain effect       | Stop automatic replay and require explicit reconciliation              |

Pi's `replay: safe` is not permission to replay emails, deletes, PR writes or other
external effects. SDK unsafe interruption reporting is also not an external
receipt system. Existing Node exact-content artifact approvals and Device read
caches are retained; cloud versions, generic writes and external delivery are
Pending. No tool permissions are lowered to make the PoC run.

## Product Cloud Memory bridge — 2026-10-18

New product Cloud Sessions can freeze `tool_capabilities: ["read_personal_memory"]`
when both `MINICLAW_CLOUD_MEMORY=true` and `MINICLAW_PERSONAL_MEMORY=true` are set.
The bridge is off by default. Historical bindings omit this optional field;
they keep their original digest and tools. A model cannot add tools through the
Provider request: the proxy independently checks names against that binding.

The native tool host obtains Root/task/call identity from `ToolExecutionApi`,
commits an immutable parameter digest through `api.memo`, and signs the exact
request to the configured Node authority's private `/tools` callback. Neither
browser nor model parameters select a user, Workspace, endpoint or task ID.
The authority checks current placement, model fingerprint, Host/Workspace policy,
execution deadline, tool capability and rollout flag before and after recall.
It then uses the existing Personal Memory helper, preserving exact-revision
consent, Home ownership, bounded results, provenance and digest-only auditing.
No Workspace Memory is merged and no model memory-write tool is registered.

Read replay is safe but always rechecks current grants; only its intent, not its
result, is memoized. Native completed results and already authorized transcripts
remain historical data after revocation. They cannot be retroactively erased.
Uncertain transport never authorizes a different tool or local execution fallback.
The private callback has bounded request/response bodies and a 15-second timeout
covering response consumption. Result identity/digest must match the original
native task before data is returned to the model.

Actual workerd fault tests interrupt the read before its native checkpoint and
recover the same task through Alarm after source revocation. Actual Node/workerd
HTTP integration uses real product grants/audit/encrypted Provider storage;
its model output and test hostname routing are fixtures. Cloud Goal control, generic external writes and Local Device tools remain
separate integrations; the following section records the approval increment.

## Product Cloud approval/recovery increment

New Sessions may additionally freeze `create_approved_artifact` when
`MINICLAW_CLOUD_APPROVALS=true`. Historical tool sets do not change. This is the
existing MiniClaw private-artifact Tool Service on the authorized business host,
not a Worker filesystem or a paired computer. It accepts exact UTF8 content up
to 64 KiB, chooses its own private UUID path and cannot overwrite a file.

The native task first checks for an orphan Node proposal, commits the complete
intent memo, proposes the exact content and commits the returned approval
identity separately. The Node approval digest additionally freezes runtime,
generation, call, parameter digest and execution deadline. Approval expires no
later than that deadline. A missing original memo/receipt beside an ahead effect
blocks execution instead of constructing a replacement checkpoint.

`probe / propose / status / execute` are private tool phases, not new user APIs.
Only `execute` can invoke the existing exclusive-create/fsync/hash reconciliation
helper, and only after approval of those exact parameters. A lost response is
resolved using the original task/approval identity; the same file is verified,
not created again. A partial/mismatched effect or authorization loss after a file effect becomes
`uncertain` and stops automatic execution. A committed product Abort intent fences the exact
original generation before any late effect, even before the Native control ACK.
Generic email/delete/remote-write tools are not added.

Pending approval closes the in-memory Harness while retaining its native task
and memos. A persisted runtime Alarm checks at most once per minute; the normal
Cookie approval endpoint also sends a best-effort signed wake after its decision
commits. The Alarm covers a lost wake. Receipt transport failures have an eight
failure budget; an exhausted budget or uncertain/missing checkpoint exposes
`blocked`, with no automatic unblock/reconciliation API. A resume guard remains
until the owned Root is idle, including a later generation after the tool round.
There is no resident model loop or second business Scheduler.

Queue/Steer while waiting use the public raw Pi Tx API only for the verified busy
Root. They append the original submission/inbox item without enabling a scheduler.
A sole paused control Harness applies native control documents; it closes before
the execution owner resumes. Exact Abort cancels that wait and a late decision
cannot reactivate it. Approval-enabled conversations use sequential tools.
