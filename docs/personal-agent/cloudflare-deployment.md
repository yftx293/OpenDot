# Cloudflare deployment and local validation

## Current scope

`apps/cloud-agent` is a separately locked Cloud Runtime using official PiHarness
and real Workers SQLite Durable Objects. Opt-in formal Session creation,
message dispatch, authoritative snapshots, Queue controls and durable result
projection now integrate with MiniClaw's existing Node product authority. This
is a hybrid deployment: the trusted Node business API/Provider authority must
remain reachable; the Worker does not replace that service or upload its backend.
Opt-in Memory reads, exact-content approvals, formal Group Handoffs, Goals and
Goal-bound Device reads have local integration coverage. The existing Node
Scheduler still owns business occurrences and delivery; the Worker is not a
standalone replacement for Node authority. Direct member-discussion Device
execution remains unsupported. Local tests do not establish a production
deployment, platform hibernation, billing, backup or rollback rehearsal.

`workers_dev` and `MINICLAW_CLOUD_ADMISSION` default off. Without a configured
signing key, requests fail closed. PoC APIs are private gateway operations, not
anonymous chat or a replacement login system.

## Local development

Use Node 24 (the validated toolchain and CI) and npm:

```bash
npm --prefix apps/cloud-agent ci
npm --prefix apps/cloud-agent run typecheck
npm --prefix apps/cloud-agent test
npm --prefix apps/cloud-agent run build
npm --prefix apps/cloud-agent run dev
```

The tests use the Cloudflare Vitest plugin, Miniflare and real workerd SQLite/
Durable Objects/Alarms. A second Worker supplies explicitly simulated HTTP model
responses. Root `npm test` excludes these files because the Node runner cannot
execute `cloudflare:workers`; the independent CI `cloud-agent` job always runs
this actual Workers suite. Existing Node tests are retained. `build` is
`wrangler deploy --dry-run`; it does not deploy or authorize resources.

For manual local use, supply a private ignored `.dev.vars` through the supported
local configuration path, with actual deployment/test values; do not commit or
log them. Required Worker configuration:

| Binding / variable             | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `SESSIONS`                     | SQLite Durable Object namespace, class `CloudSession`                          |
| `MINICLAW_CLOUD_ADMISSION`     | Explicit `true` permits new PoC bindings only                                  |
| `MINICLAW_CLOUD_SHARED_SECRET` | Dedicated >=32-character HMAC key shared with trusted business gateway         |
| `MODEL_BASE_URL`               | Fixed configured HTTPS OpenAI Completions base URL; no userinfo/query/fragment |
| `MODEL_ID`                     | Exact selected model ID; provision requests cannot switch it                   |
| `MODEL_API_KEY`                | Deployment secret for the selected PoC model                                   |
| `MODEL_SERVICE`                | Optional trusted service transport; used by the test-only model Worker         |

Product mode uses the existing encrypted MiniClaw Provider authority described
below and ignores the PoC model key/base/model. The deployment-bound PoC provider
is not a substitute for product credential management. A proxy-backed secret placeholder may be valid as an HTTP
credential through its configured destination; it is **not** a raw HMAC key.
Provision a real deployment HMAC key through an approved secret-management path,
never by copying chat secrets into files/arguments or hashing a proxy placeholder.

## Private API and lifecycle

`POST /internal/cloud-sessions` provisions a caller-supplied stable Product
Session ID and runtime ID. The trusted gateway signs owner, Workspace, Session,
runtime and configuration fingerprint plus exact method/path/body SHA256 and a
60-second validity window. The DO verifies these again and binds identity once.
It cannot be moved to another owner/Workspace/model in place. No Cookie bypass,
username attribution auth or automatically exposed `routeAgentRequest` is used.

The other private routes use `/internal/cloud-sessions/:id`:

- `POST /messages`: stable `request_id`, bounded content and `when_busy` equal to
  `followUp` or `steer`; a changed full payload under the same ID conflicts.
- `GET /`: authoritative committed native view, original submission IDs,
  immutable object/conversation identity, persisted revision and instance epoch.
  A new epoch is reinitialization evidence, not proof of the platform's reason.
- `GET /events`: initial snapshot then ordered native event batches, with epoch,
  per-stream sequence and persisted revision. Slow consumers are bounded and
  detached; reconnect through a new snapshot. Closing the stream stops only its
  watch. SSE while attached can prevent hibernation; hibernating WebSocket client
  integration is not implemented in this increment.
- `POST /wake`: one frozen occurrence `{execution_id,not_before,input}` supplied
  by trusted business scheduling. It is not a cron definition. A Lifecycle job
  shares the physical Alarm with PiHarness. Occurrence/input receipts dedupe
  delivery across retries and completed-wake ACK loss; a persisted-intent/job
  gap is rearmed at startup. Existing MiniClaw business schedule definitions
  stay on the current Scheduler; this API is not yet connected to them.
- `POST /abort`: withdraw/abort the exact native operation by `request_id`, never
  whichever generation happens to be newest. Full queue edit/reorder and product
  control integration are not implemented yet.

PiHarness's factory opens paused Pi, validates native input checkpoints against
original product intents and full payload receipts, then allows SDK activation.
An intent committed before native Inbox admission can admit its original ID;
an already admitted submission is verified and reused. An unexplained native
submission blocks recovery instead of submitting its prompt again. Long future
occurrences are Lifecycle jobs, without an application polling interval. Native
context/document retention are both zero so idle cache timers do not prevent
hibernation. Model step/deadline budgets survive reset; model status is `unpriced`.
PoC limits include 100 inputs and 100 occurrence receipts per object; never delete
old dedup receipts to make room. Future retention/compaction needs a separate
versioned design. No externally mutating tool is offered; `inspect_text` is a
bounded replay-safe byte count/SHA256 operation.

## Deployment authorization and resources

Real deployment needs an explicitly authorized Cloudflare account/Worker target,
permission to create a SQLite DO namespace/class migration, routes and secrets,
and a valid model credential. The 2026-10-26 read-only check found Wrangler
unauthenticated and the current process's required live-test bindings absent.
This is not a search of all developer credentials or remote Cloudflare accounts.
A configuration draft is not active access or approval.
Do not invoke `wrangler deploy`, create billable resources or modify existing
production Worker configuration without authorization.

After an authorized staging target exists, operators can use:

```bash
npm --prefix apps/cloud-agent run build
# Only after explicit staging resource/deployment authorization:
npm --prefix apps/cloud-agent run deploy
```

Set model and control keys with the approved deployment secret mechanism
(e.g. Wrangler secret input); never put values in command arguments, committed
Wrangler vars, screenshots or logs. Keep the target name, namespace migration
and model binding explicit. No Worker route, account ID, secret value or production
endpoint is guessed by this repository.

`npm --prefix apps/cloud-agent run test:live` targets an already authorized
staging deployment; it does not deploy. It requires `MINICLAW_CLOUD_LIVE_URL`,
`MINICLAW_CLOUD_SHARED_SECRET`, `MINICLAW_CLOUD_LIVE_PROVIDER_ID`, the exact
`MINICLAW_ZEN_MODEL`, and explicit `MINICLAW_CLOUD_STAGING_AUTHORIZED=true`.
Missing bindings/authorization produce **exit 2 / Pending** before requests.
It creates one isolated administrative PoC Session, verifies an actual tool
result and future Alarm result using separate connections, and reports only safe
IDs/booleans. Its results do not establish formal product authorization, physical
devices or the platform's hibernation reason. Cloud test data remains durable;
any cleanup must use an approved operator procedure. No live run is claimed yet.

## Monitoring, costs and limits

Use Cloudflare Worker/DO request, alarm, exception, CPU, duration and SQLite
read/write/storage metrics. Correlate stable Session/runtime/occurrence/request
IDs and revisions, not prompts or credentials. A fresh object epoch helps
identify reinitialization. Platform logs distinguish hibernation, resets, code
updates, memory/CPU limits and transient failures. A successful dry-run or local
Miniflare test is not a cloud deployment or real vendor inference result.

See [cloud-runtime-decision.md](cloud-runtime-decision.md) for current pricing
assumptions, examples and resource limits. Model tokens, long attached SSE,
heartbeat activity and transcript/index writes matter. The SDK's placeholder
zero rates are never presented as a $0 execution price.

## Migrations, rollback, backup and recovery

Wrangler migration `v1` introduces SQLite class `CloudSession`; do not rename the
class/namespace or remove the migration tag on rollback. The SDK owns prefixed
Pi schema migrations; `mc_` tables hold immutable binding/admission/occurrence
receipts in the same object. Future table/checkpoint changes require explicit
version compatibility tests. This PoC has not migrated existing Node data.

Disabling new admission preserves stored identities and recovery. Roll back code
only to a version compatible with the current stored schema/registry. It cannot
roll back an already committed model/tool effect. Never redirect an existing
cloud Session to Node because a flag or network request failed.

DO SQLite is not a local database file. Use approved Cloudflare backup/PITR/
bookmark procedures with the current account retention policy; this application
ships no public restore/delete-all endpoint. Preserve deployment version,
namespace/class identity and business provisioning receipts alongside any native
checkpoint recovery point. Formal cross-store product/DO restores need a
coordinated reconciliation procedure; there is no global transaction. Production
backup, PITR, rollback and restore remain unverified and must be rehearsed in an
authorized staging account before rollout.

## Product authority foundation and signed callbacks

Product-mode bindings set immutable `execution_authority: miniclaw-product`.
Their Worker needs trusted HTTPS root origins `MINICLAW_CLOUD_ORIGIN` and
`MINICLAW_AUTHORITY_ORIGIN`, plus its dedicated signing secret. The first must
match the persisted gateway origin. `MINICLAW_AUTHORITY_SERVICE` is an optional
trusted service binding for controlled deployment/test transports; it never
comes from client JSON. Do not use the PoC model key to authorize product work.

The existing Node Gateway exposes private signed callbacks:

- `POST /api/cloud-runtime/:session/objects/:object/policy`: exact full-binding
  digest, gateway-origin agreement, live user/Workspace/Host/provider checks and
  recoverable first-object binding.
- `POST /api/cloud-runtime/:session/objects/:object/inputs`: full original
  product receipt digest, text/mode and native submission identity/state. Missing
  intent or a product acknowledgment ahead of its checkpoint blocks admission
  and resume.
- `POST /api/cloud-runtime/:session/objects/:object/model/:attempt`: exact model,
  text/tool surface and response-token bounds, persisted attempt receipt and
  budget, existing encrypted Provider credential resolution, streaming proxy.

Cookies do not authenticate these routes. Keys remain in the Provider store and
are never returned to the Worker. There is no client-controlled endpoint or
header forwarding; the supported bridge is OpenAI Completions only. Unknown
request fields, extra cloud tools, redirects and raw upstream error bodies are
rejected. Product execution depends on the trusted policy Gateway being reachable;
its unavailability fails closed. It does not prove a fully standalone cloud
identity/Goal service.

Model transport has a 60-second bound and a 4 MiB response bound. Active Host/
Workspace identity is checked every second and before each forwarded chunk;
revocation aborts the upstream request. Attempt IDs are signed into the URL;
replay never issues a second vendor request. Interrupted/unknown attempts consume
the bound budget and require a new native model attempt rather than replaying a
recorded response. `completed` denotes a finished SSE transport containing
`[DONE]`, not Goal completion. A crash may leave `started`; this is unknown and
cannot be replayed under that ID. Native Pi checkpoints remain the execution
source of truth.

The original signed-callback foundation did not itself enable public Session
creation or Scheduler/Goal controls. Subsequent opt-in product Sessions, result
projection, cancellation, approval and Goal integration are described below.
Their flags and live grants remain required; do not manually insert Cloud
selections into production to bypass admission.

Cross-runtime authority acceptance, after both locked installs and Cloud build:

```bash
npm run test:cloud-authority
```

This uses actual workerd, disk SQLite and Node HTTP/encrypted Provider authority,
with a local deterministic HTTP model and an explicit test-only service route.
The Miniflare 5 standalone constructor uses its exported
`convertV4MiniflareOptions` adapter; persistence is `resourcePersistencePath`.
The disk restart assertion must pass; in-memory test isolation is insufficient.
No credential, deployment or ordinary browser API is needed for this local test.

The opt-in formal path now has durable result projection/delivery and
cancellation/approval controls with local integration coverage. The bounded PoC
currently refuses Harness activation after that deadline, including its normal
snapshot route; it is not a complete long-lived Session history service.

Product-mode messages require `product_receipt_digest` from the original
MiniClaw input transaction. The Worker verifies that receipt through the private
`inputs` callback both on admission and before native recovery. The callback
binds full product payload identity, not merely prompt text. A product receipt
that acknowledges a missing/different native submission is rejected. Warm-object
snapshot/event/control requests also recheck current policy; a cached Harness
is not permission to read after revocation. Early internal product PoC data
without this proof cannot be auto-upgraded by resubmitting its prompt.

Recovery validates the complete set of product/native bindings and native digest
Docs before any original admission gap can be placed: native `Conversation.submit()`
enables scheduling even on a paused Harness. The factory therefore never calls
it; its persisted job performs original admission through PiHarness after startup. Never interleave per-row recovery
submission with validation of later rows. The fault suite explicitly corrupts
a later row and asserts zero new native submissions/model requests.

Input admission first persists a bounded Runtime wake for that exact request ID,
then its intent, before invoking PiHarness. After the native receipt is committed,
its ID is frozen and the extra wake is cancelled. A crash in that gap is covered
by Alarm: startup validates the complete ledger and admits only an original intent
with no acknowledged native ID. Its job only inspects/records an existing native receipt. If no native receipt
ever existed, it admits the original durable intent through PiHarness after
startup; it never re-submits an acknowledged prompt. This is Runtime recovery, not a business schedule.

The Node staging CLI uses `--use-env-proxy`, so control requests honor inherited
HTTPS proxy/CA policy. The product Gateway already configures its existing
`EnvHttpProxyAgent` in `src/load-env.ts`; the new Provider proxy uses that shared
fetch dispatcher. Test-only loopback routing is not an external-network bypass.

## Opt-in formal Session pilot

Deploy the execution fence and private callbacks to **all** Node executors before
admitting Cloud Sessions. The Node product authority needs these deployment
settings, supplied through the existing secure environment/provider mechanisms:

- `MINICLAW_CLOUD_RUNTIME=true`: allow explicit new Cloud Sessions; default off.
- `MINICLAW_CLOUD_ORIGIN`: exact trusted HTTPS Worker origin, without a path.
- `MINICLAW_CLOUD_SHARED_SECRET`: actual private HMAC material shared with Worker.
- An existing encrypted Provider with an explicit model and
  `MINICLAW_MODEL_API=openai-completions`; no client-supplied model endpoint/key.

The Worker separately needs the same HMAC secret, exact Cloud origin,
`MINICLAW_AUTHORITY_ORIGIN` pointing to the trusted HTTPS Node product API, its
SQLite namespace and `MINICLAW_CLOUD_ADMISSION=true` for initial object bindings.
`MINICLAW_DURABLE_RUNTIME` still controls default Node Durable creation; explicit
Cloud creation uses its own admission flag. Repeated creation with an existing
key is valid after either new-admission flag closes.

```text
POST /api/groups/:jid/sessions
{ name, description, requestId, runtime: "cloudflare-durable" }
POST /api/messages
{ chatJid, agentId, content, requestId, followUpBehavior: "queue" | "steer" }
GET /api/groups/:jid/sessions/:id/runtime
POST /api/groups/:jid/sessions/:id/controls
{ requestId, command }
```

`GET /api/groups/:jid/session-runtimes` returns configured options only to the
Workspace owner. Existing authenticated Web/PWA/Electron controls share these
routes. No signing credential reaches a browser. The creation action appears
only when admission/configuration is available. Existing Sessions retain their
runtime when flags change; no implicit runtime conversion is supported.

The pilot grants 24 model attempts/24 hours per Session. Expired execution cannot
make another model/tool request; its history and authorized result outbox remain
available. Native pending work is preserved, not silently restarted under a new
grant. Results retry with stable receipts and bounded backoff (eight failures
then `blocked`). Diagnose blocked results by the snapshot's `deliveryReceipts`
and the private product authority; manual rearming/export is not yet a public
API. An oversized result is blocked and retained in native storage, not truncated
into a fabricated successful answer. These limits must be reviewed before
broader rollout.

The product regression uses actual Cookie-authenticated APIs, encrypted Provider
records, Node HTTP, workerd and disk restarts. Only its HTTPS hostname routing and
model output are simulated. It proves lost input/control acknowledgments, cold
control recovery, detached completion, exact Abort and two authenticated clients;
it is not an actual Cloudflare account deployment or physical-device test.

### Optional Personal Memory tool

Enable `MINICLAW_CLOUD_MEMORY=true` together with `MINICLAW_PERSONAL_MEMORY=true`
on the trusted Node authority before creating a new Cloud Session. Current
per-item Workspace grants are still required; these flags grant no cross-owner
access. No vendor key or Home data store is copied into the Worker. Historical
bindings remain unchanged. The Worker uses its existing signed authority origin,
so no additional public tool endpoint or credential is required.

Lifecycle singleflight jobs retain the official default 30-second hung timeout
after an isolate exits mid-job. Recovery may wait for that Alarm rather than
starting a second delivery immediately. The integration test exercises this real
lease and original receipt; do not reset SDK job rows or add a competing poller.

### Optional exact-content artifact approvals

`MINICLAW_CLOUD_APPROVALS=true` on the trusted Node authority enables the artifact
capability for newly created Cloud Sessions. It is off by default and independent
of the Memory flag. The existing Cookie approval and artifact APIs are reused;
no new public credential or computer filesystem mapping is introduced. A signed
private `.../approval-decisions` request wakes an existing wait, but does not
itself grant approval. Its identity is checked against the existing Node receipt.

Pending waits use a one-minute runtime Alarm, finite transport retries and the
original execution deadline. A resume guard survives later generation/model
interruptions; native model/token budgets still apply. Include these Alarm/SQLite
and business-host costs when estimating deployment. Actual production hibernation,
resource billing and deployment are still unverified. Keep all admission flags
off on existing services while using the isolated local tests.

### Explicit Cloud Goal admission

On the trusted Node authority, `MINICLAW_CLOUD_GOALS=true` enables selection of
Cloud for a new Goal only when `MINICLAW_PERSONAL_GOALS`, `MINICLAW_CLOUD_RUNTIME`
and `MINICLAW_CLOUD_APPROVALS` are also true, the current user owns an authorized
Host Workspace, and its configured model supports `openai-completions`. It does
not require enabling new Node Durable Sessions. The normal Goal page queries
`GET /api/goals/availability?workspace_jid=...` and sends explicit
`runtime: "cloudflare-durable"` to the existing Goal creation API. The global
availability response remains compatible with older clients. No secret reaches
the browser and no historical Session is converted.

The existing Node Scheduler still owns business occurrences and delivery. Node
authority availability remains necessary; this is a hybrid runtime rather than
a Worker replacement for the Node product service. Alarms own only native
recovery/waits. Local browser acceptance covers actual background dispatch,
natural lease recovery after SIGKILL, exact approval and artifact evidence; the
model replies are fixtures. This does not establish production deployment,
Cloudflare hibernation/billing or vendor inference. See
[goals-and-tasks.md](goals-and-tasks.md) for context and quota limits, and
[migration.md](migration.md) for admission rollback without destroying Cloud data.

## Optional formal Cloud Group Handoffs

On the trusted Node authority, explicitly set `MINICLAW_CLOUD_BOT_HANDOFFS=true`
alongside `MINICLAW_BOT_GROUPS`, `MINICLAW_BOT_HANDOFFS` and
`MINICLAW_CLOUD_RUNTIME`. Reuse the existing HTTPS gateway/shared-secret and
encrypted OpenAI-Completions Provider configuration. The flag defaults off;
the separate `MINICLAW_CLOUD_GOALS` is neither required nor implicitly enabled.
For reviewed artifact effects also enable `MINICLAW_CLOUD_APPROVALS`. The Owner
must still explicitly grant the Bot's owned Workspace, tool list, model quota
and expiry through the normal Group UI/API. Cloud read-only text inspection is
computation only; no laptop filesystem, Shell, MCP or memory grant is inherited.

No additional Worker, DO class, queue or business Scheduler is deployed. Existing
hybrid availability/cost limits apply: the Node authority remains necessary for
policy, Provider proxy, tool approvals/effects and product projection. Disable
new admission for rollback and use existing controls on retained owners; follow
the schema-82 compatibility/backup boundary in migration.md. Local verification
uses the real production Node entry and workerd with synthetic inference and
loopback hostname routing. It is not evidence of an authorized cloud deployment.
