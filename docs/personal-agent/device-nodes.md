# Personal device nodes

## Implemented boundary

`MINICLAW_DEVICE_NODES=true` opts into a local outbound Node process. The Gateway
keeps its existing authentication, Workspace ACL, Runtime, Scheduler and approval
system. First version exposes **only `files.read` for at most 50 explicitly named
relative files**. No filesystem-root access, wildcard, directory scan, shell,
write/delete, application or browser capability is offered. Tailscale remains a
separate optional network helper; no service/public-exposure configuration changes.

The existing logged-in owner creates a five-minute single-use pair ticket. The
local process reads its code through stdin, generates/persists its own bearer in
private SQLite before join, then sends only its SHA256 verifier and an immutable
manifest. A dropped join acknowledgement retries the same claim ID and manifest.
The Gateway derives owner from the ticket, never from a node-supplied account ID.
The owner separately reviews the node ID, directory label/fingerprint and finite
file declaration and approves identity. **Identity approval grants no file access.**
A separate confirmed grant binds an owned Workspace, declared path subset and
60–86400 second lifetime. Revocation is terminal; old receipt retries return
current state without recreating permissions. Node tokens authenticate only
heartbeat, command polling and result submission, never ordinary account APIs.

## Local usage

Install repository dependencies and use Node >=22.19.0 on Linux/macOS (POSIX state permissions; Linux exercised here). In the Goals page's
“个人设备” section, generate a code. On the local machine, prepare a real directory
and a private state location (new parent is created mode 700; existing unsafe
permissions/links are rejected rather than silently changed):

```bash
npm run device-node -- --gateway https://your-gateway.example/base \
  --root /your/research --state /your/private-node/node.sqlite \
  --allow-file research.txt --pair
```

Enter the code on stdin, then newline. Do not place codes/tokens in arguments,
chat, shell history or a shared file. Review the claimed identity in the Goals
page, then separately authorize `research.txt` for one Workspace and chosen TTL.
Restart with identical arguments **without `--pair`** to reuse identity and
receipts. Changing Gateway, root identity or declarations requires a new private
state file and explicit pairing/grants; it cannot silently expand access.
HTTPS is mandatory except literal loopback development addresses. Userinfo,
query/fragment and redirects are rejected. The CLI preserves inherited proxy/CA
behavior through `EnvHttpProxyAgent`; it does not disable TLS verification.

## Durable execution and offline behavior

New Durable roots register `list_personal_devices` and `read_device_file`. Listing
shows only current Workspace grants (bounded metadata); reading requires an exact
node ID/path. Before creating a product intent, the ToolTask commits a native
`miniclaw.device-command.v1` memo with stable command/owner/Workspace/Session,
conversation, ToolTask, ancestor generation, call, Goal Run, node, grant, manifest
and path identities. Replays reuse it. A database-only intent without the matching
native active checkpoint cannot dispatch. A memo ahead of the product intent may
recreate the same safe read only after fresh authority checks. This is checkpoint
recovery; the original prompt is not resubmitted as a new execution.

The device command ledger is an individual tool transport/receipt ledger, not a
second business Scheduler. The existing Scheduler retains the original Goal Run,
lease and budget charge. Every dispatch and result commit rechecks the live native
Task ancestry/memo plus current local execution claim and existing policy. Polls
lease one read for 30 seconds. The node durably caches the exact result by immutable
command ID/full-parameter digest **before** returning it. Lost replies/Node restart
return those original bytes even if the file subsequently changes. The Gateway
commits a digest-bound terminal receipt. A completed native ToolTask also uses its
existing Harness checkpoint, not a new local read.

Until the result arrives, a Goal projects `waiting_for_device` from committed
commands (pending approval takes priority). Browser detach does not stop it.
Pause retains the original intent and denies dispatch/results; resume reclaims
that same Run. Exact-generation abort cancels only that generation's commands;
terminal Goal/session cancel or node/grant revoke fences pending dispatch and late
results. Existing duration/model/run budgets continue across offline time,
approval waits, pause and restart; no infinite offline execution or budget reset.
There is no other-node/cloud fallback or automatic local data migration.

A real heartbeat in the preceding 15 seconds plus readiness determines the UI's
online indicator; it is not execution authority. Session device metadata travels
through the existing authoritative snapshot/invalidation/reconciliation flow.

## File and audit protections

The root must be a real non-filesystem-root directory. Paths reject traversal,
absolute forms, controls, Windows devices and backslashes. The reader checks root
identity, every path component, opened file identity before/after read, and rejects
symlinks, multiple hardlinks, FIFO/nonregular files, concurrent identity/content
changes, invalid UTF8 and files larger than 64 KiB. It uses `O_NOFOLLOW|O_NONBLOCK`
and bounded reads. The node's DB/WAL/SHM/journal paths and inode aliases cannot be
read even if declared. Parent/file permissions are 700/600; raw bearer and cached
file contents remain local private state. This is a cooperative local process,
not a sandbox against a compromised OS/same-UID attacker; no power-loss claim.

Gateway registry/audit never stores the raw bearer or local absolute root. Audit
records IDs, actions, outcomes and parameter/result hashes; Session snapshots omit
file contents. Authorized Tool results/native execution storage do contain the
read text, and the node caches it. Revocation blocks future authority; it cannot
undo a read already authorized/in flight or erase past conversation knowledge.
The owner audit endpoint returns the latest 200 metadata receipts. No raw file,
bearer or pair code is logged by the CLI. Native memo and immutable registry
identity prevent swapping the approved surface in place.

## Evidence and limits

`tests/device-local.test.ts` exercises real temporary files, symlink/hardlink/FIFO,
protected state, encoding/size/root replacement and persisted original-byte cache.
`tests/device-nodes.test.ts` exercises the actual database/Hono Cookie routes,
single-use claims/retries, independent approval/grants, cross-owner/workspace
access, native-owner dispatch gate, receipt conflict, abort generations, revoked
late results, admission flag, expiry/Host revocation and verified v76 backup.

`web/tests/e2e/device-node-product.spec.ts` drives actual compiled Gateway/pages,
two independent desktop/mobile logins and a separate local CLI process. It pairs,
approves identity, grants one file, waits offline, detaches, loses a read reply,
SIGKILLs the node and Gateway, changes the source file, and recovers the same
Run/input/command/checkpoint/cache before mobile approval and actual artifact/
completion delivery. Only the HTTP model and lease-clock expiry are simulated.
Physical device lifecycle, real external model, public network/TLS deployment,
production migration/restore and power loss remain unverified. General device
writes/apps/browser/remote desktop and external sensitive-write tools are not
implemented. See [evaluation.md](evaluation.md) for final gate counts.

The Gateway/Node and declaration-versus-grant boundary was compared with OpenClaw
source/tests at `83fab6f21417ae7cfb08907e344c1655abf9ef88` (`node-registry-pairing`,
`node-registry.dispatch-authority.test`, `node-registry-policy.test`, `nodes-policy`);
its authentication or runtime framework was not imported.

## Cloud Bot Team bridge (schema v84)

`MINICLAW_CLOUD_DEVICES=true` additionally opts **new Goal Team Cloud Handoffs**
into the reviewed `read_device_file` capability. Ordinary Cloud Sessions and
standalone Handoffs cannot acquire it. Local Node Sessions retain their original
protocol and grants. No new runtime, scheduler or node protocol is introduced.
Both device admission flags are required for new requests/grants; disabling
admission does not silently change existing Session execution ownership.

The model supplies only an already paired device ID and one declared relative
path. The server freezes owner, scoped Workspace, Goal, original Scheduler Run,
Handoff, Cloud Session, native ToolTask/generation/call, exact resource, operation
hash and deadline. It persists the choice, then waits for **separate owner
confirmation of this request**. Existing generic Workspace grants cannot satisfy
it. Conversely, a Cloud request grant cannot authorize a legacy Node read or
another Goal, Workspace, Handoff, device or path. Grant TTL is clamped to the
original request deadline (at most 15 minutes and the Handoff grant deadline).

The authenticated owner reads `/api/device-nodes/requests`, then uses the existing
`POST /api/device-nodes/:id/grants` with `cloud_request_id`, one exact `paths`
entry and `confirmed:true`. The server verifies the committed native intent and
receipt through a signed, read-only DO RPC before granting. Each command dispatch
and nonterminal result repeats the proof including the exact committed grant
memo, and rechecks current owner/Workspace/Host/Group/Bot/Goal/run authority after
remote I/O. No second Harness is opened for proof reads. Pending memo commits or
a paused/recovering original claim retain the command; invalid/revoked authority
cannot dispatch it. A terminal result retry returns the existing digest-bound
receipt and grants no new access.

The existing Lifecycle/Alarm parks the original ToolTask during permission or
device waits and closes the active Harness. Its persisted finite wake budget
cannot reset on duplicate events. Permission, online and result events use
fixed outbox IDs and at most eight transport attempts each. Status probes and
activation retries also have independent persisted limits of eight, plus the
original deadline; there is no model polling or indefinite retry loop. An
Alarm/RPC resumes the original native checkpoint, never resubmits the prompt.
Offline devices have no alternative-node/cloud fallback. Explicit pause/cancel,
removed membership, revoked capability and expired claims fence later use.

After the existing node returns its cached bytes, Cloud validates their hash,
commits a native result memo and confirms that digest to the product receipt.
Lost confirmation acknowledgements can replay the same ToolTask/result rather
than reread the file. Goal automatic completion additionally requires confirmed,
successful receipts for requested local reads; an artifact or Bot claim alone
cannot satisfy this gate. Missing receipts require human review. Revocation
cannot erase file contents already delivered into authorized native storage.

`tests/cloud-device.integration.ts` runs compiled Node/HTTP/Scheduler, actual
workerd SQLite/PiHarness reconstruction, the existing finite-file reader/cache,
owner grant, duplicate grant/result, offline wait, lost checkpoint-confirmation
ACK, a second workerd reconstruction, artifact approval and Goal completion. It
uses a synthetic model and test hostname routing. This test is neither deployed
Cloudflare acceptance nor physical Mac/phone acceptance. The existing separate
CLI/browser Node recovery test remains in the regression suite. New Cloud
request authorization UI and the final cross-device Team demo remain pending.
