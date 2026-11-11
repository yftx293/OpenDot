# Cloud runtime decision

Status: implementation and local workerd validation in progress, **not deployed**.
Checked 2026-10-17; official npm metadata rechecked 2026-10-18 (Pi 1.3.0 / agents 0.28.1 unchanged). Existing `agent/personal-agent-integration` is `fe520f5`;
this increment builds on its tested descendants through `4a9a74d`, preserving
Node runtime, Pocket, Goal/Scheduler, Memory and Device Node code and tests.

## Versioned sources and choice

Choose **Cloudflare Agents `PiHarness` + `Lifecycle`** as the primary host of
`@earendil-works/pi-durable` **1.3.0**, pi-ai/chord **1.3.0**, `agents` **0.28.1**.
Wrangler **4.151.1**, Workers test plugin **1.4.4**, Miniflare
**5.20261012.1-beta**, Vitest **4.1.8** are independently locked under
`apps/cloud-agent`. Root Node dependencies are not upgraded. `PiHarness` is Beta;
package versions are pinned rather than adopting future API changes implicitly.

Read actual source/types/tests, not just diagrams:

- Cloudflare Agents `7dd51c518c517b0f9f92ec7e2c3ad1004222955e`:
  `packages/agents/src/harness/pi/{harness,session-store,types}.ts`, its
  `tests/{worker,harness,session-store}.ts` and `docs/agents/harnesses/pi.md`;
  `examples/next/harnesses/pi/src/{server,sockets}.ts`.
- Author example `earendil-works/pi-durable-cloudflare`
  `dcb56ce2d174babb3f00112ac5b8cd597e58ab45`: `src/{session,chat,schedule}.ts`,
  `test/{recovery,storage}.test.ts`, manifests/config. It pins Pi **1.2.0**;
  its code is evidence, not a drop-in MiniClaw auth or runtime framework.
- Installed Pi Durable 1.3.0 public Harness, Task, Inbox, event and portable
  SQLite/Cloudflare storage types and implementation.
- Official Cloudflare docs source in `cloudflare/cloudflare-docs` production:
  Durable Object lifecycle, alarms, limits, pricing; current PiHarness docs.
  Official site URLs and the two requested Earendil articles returned HTTP 403
  in this environment. Their network requirements are saved in the environment
  draft; **article reading remains Pending** until access is applied. No claim
  below is inferred from an unread article. Pi Pocket/OpenClaw source and tests
  were inspected in earlier accepted increments; their auth/UI are not copied. Current additional source checks: Pi Pocket `e5456a832d47e7154faf04320dd7602ae5051bf7` (`src/server/app.ts`, native snapshots, committed queue and detach handling) and OpenClaw `0167acd97b51b91545fafc8f2c430b9e765e14b1` (`src/gateway/node-registry.ts`, paired identity and published permission surface).

## Five feasibility answers

1. **PiHarness supplies hosting, not all product behavior.** Its public API has
   Session create/list/fork, submit/steer/abort/wait/messages/events and access to
   the underlying `Harness`. Native Tools, subagent conversations, checkpoints,
   replay-safe/unsafe execution and committed watches belong to Pi. Tests cover
   replay-safe/unsafe tools across object reset, events and subagent-created
   sessions; this does not imply MiniClaw ACL/approval/delivery parity. PiHarness
   does not implement MiniClaw's client protocol or complete-payload request
   conflicts. Those checks remain mandatory in our adapter.
2. **SQLite belongs to one object.** SDK store prefixes Pi tables under `pi_`,
   serializes async statements and transactions over `ctx.storage.sql`; Lifecycle
   owns separate durable jobs. Do not open a Node SQLite connection, use file
   paths or pretend a transaction spans Node/product and DO stores. Persist an
   immutable owner/Workspace/Product Session/runtime/config binding first.
3. **Memory is disposable.** Active requests, timers and non-hibernatable sockets
   can prevent hibernation. Set Pi `documentRetentionMs: 0` and `contextRetentionMs: 0`; dispose client watches
   on detach. PiHarness persists a wake job before Inbox admission, tracks live
   work with a bounded alarm heartbeat, and resumes native checkpoints after
   startup. Long model retry/deferred waits hand off to alarms. An arbitrary
   background `runtime.sleep` is not automatically a business schedule: source
   PiHarness wakes background work by heartbeat. Frozen future occurrences use a
   separate Lifecycle capability in the same physical alarm multiplexer, with
   stable occurrence/input IDs. No new cron parser/business Scheduler is added.
   Alarms are at-least-once, one physical alarm per DO, with platform retry;
   duplicate wakes must be harmless. No guaranteed shutdown hook is assumed.
4. **Compatibility is selective.** HTTP models, pure computations and portable
   capability descriptors can run in Workers. Host files/shell/git/build/test,
   native SQLite/node-pty, arbitrary stdio MCP, Docker and local apps cannot.
   `nodejs_compat` supports required SDK APIs, not Linux or arbitrary native
   modules. API-key OpenAI Completions is the initial tested provider path;
   Workers AI, other APIs/OAuth and MCP need separate configured adapters and
   validation. Do not import the Node backend into the bundle.
5. **Reuse business identity/model/Goal/Memory through a trusted boundary.** The
   Worker is an execution gateway behind MiniClaw's existing Cookie/Workspace
   authority, not a second user database. Signed requests bind owner, Workspace,
   Session, runtime ID, configuration fingerprint, exact method/path/body and
   expiry; the DO checks the same identity again. PoC uses one deployment-bound
   model and signed administrative requests only. This is **not yet formal user
   integration** or current Workspace revocation parity. Formal rollout must use
   live MiniClaw policy/provider authority before open/resume and every model/tool,
   retain immutable runtime choice and a recoverable provisioning state machine.

## Official versus manual host

| Concern                                  | Agents PiHarness 0.28.1                                                  | Author manual host                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Native checkpoints/Inbox/Tools/Subagents | Pi Durable; factory owns registry                                        | Pi Durable; application owns registry                              |
| SQLite                                   | SDK prefixed portable adapter                                            | Official Cloudflare SQLite adapter                                 |
| Wake/recovery                            | Lifecycle persisted jobs, heartbeat, backoff/circuit breaker             | Application task graph watches, alarm deadlines, explicit rearming |
| Transport                                | Application chooses; example uses hibernatable sockets                   | Example owns WebSocket command protocol and watches                |
| User authorization                       | Application responsibility                                               | Example's username is attribution, not MiniClaw identity           |
| Future business work                     | Must preserve existing Scheduler definitions                             | Example provides its own scheduling tool; do not transplant it     |
| Main risk                                | Beta API, startup automatically resumes: validate before factory returns | Owning/maintaining all alarm/recovery edge cases ourselves         |

Use the official host to avoid maintaining a second lifecycle/alarm engine. Keep
an explicit factory guard before PiHarness's automatic `resume()`. Read and
validate original input bindings before returning the native Harness. Retain the
manual source and existing Node adapter as reference/tests, not competing owners.

## Runtime / storage / tool matrix

| Existing component                       | Workers/DO                      | Responsibility / action                                                     |
| ---------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| Pi Coding Agent + JSONL                  | Local Node                      | Preserve, no forced conversion                                              |
| Node Pi Durable + exclusive SQLite guard | Node                            | Preserve all tests; never share ownership with DO                           |
| Pi Durable portable Harness/SQLite       | DO                              | Supported SDK host; immutable root ID and native task receipts              |
| User/Cookie/ACL/Workspace                | Existing MiniClaw control plane | Recheck through trusted product authority; never client-supplied owner      |
| Goal Store/API/UI, Memory/provenance     | Existing business plane         | Reuse through authorized adapters; no global Workspace merge                |
| Scheduler/task definitions               | Existing Scheduler              | Sole business schedule; occurrence-ID-bound runtime wake only               |
| Pure read-only `inspect_text`            | Cloud                           | Bounded UTF8 byte count/SHA256, safe replay, no external side effect        |
| API-key HTTP model                       | Cloud                           | Deployment-bound PoC; existing encrypted Provider authority for formal path |
| HTTP MCP/Skills resources                | Adapter required                | Preserve exact selection/ACL; no stdio/host path fallback                   |
| FS, Shell, Git, Build, Browser/apps      | Granted local Node / sandbox    | Explicit pairing, finite capability, expiry/revocation/audit                |
| External writes / IM delivery            | Existing Tool/Channel gateway   | Idempotent ID/receipt/uncertain state, never blind tool replay              |
| Product SQLite ↔ DO SQLite               | Separate stores                 | Provisioning/admission receipts; no distributed transaction claim           |

## Cost, limits and rollback

Official current pricing includes SQLite-backed DOs on Free (quotas) and Paid.
Paid typically has a $5/month Workers minimum; DO allowance: 1 million requests,
400,000 GB-s duration/month, then $0.15/million requests and $12.50/million GB-s.
SQLite allowance: 25 billion rows read, 50 million written/month; above allowance
$0.001/million read and $1/million written; 5 GB-month stored then $0.20/GB-month.
Check current account/pricing before activation; model/provider tokens, AI Gateway,
Sandbox/browser, other Workers and external tools are additional costs.

Example: one personal object active 1 hour/day is about 13,824 GB-s/month at
128 MB; 100,000 requests and 1 million SQL writes/month fit the quoted Paid DO
allowances. This is **an illustrative estimate**, not a billing measurement or
promise of a $5 total. A permanently active object can cost much more. Streams,
heartbeat frequency, transcript commits, indexes and SQLite row reads/writes must
be measured. SDK zero-valued placeholder token rates remain `unpriced` in product
projections and are never represented as free execution.

Relevant limits: object SQLite up to 10 GB (Free account 5 GB total), 2 MB row,
100 KB SQL statement, 100 bindings/query, six outgoing connections/request;
request CPU default 30 seconds, configurable up to five minutes. Alarm execution
has a 15-minute wall limit; SDK bounds its active wait. Model I/O is not a license
for indefinite loops. Use explicit model-step/duration/occurrence budgets.

Deploy only with explicit resource/account authorization. `workers_dev` and new
admission default off. Use `wrangler deploy --dry-run` for bundle validation.
Disabling new admission cannot switch or delete existing Sessions. Rollback must
preserve object class/binding/migration tags and stored data; reverting code is
not rolling back SQLite state. Native/product checkpoints need coordinated,
versioned backup/restore procedures; DO point-in-time recovery is not a JSONL
migration and is not tested by an in-memory mock. No cloud resources, billing
settings, production data or existing service configurations have been changed.

## Product pilot validation update — 2026-10-18

Official npm metadata was rechecked on 2026-10-18: Pi Durable is still 1.3.0 and
Agents is still 0.28.1, matching the pinned packages/type/source contracts. The
formal product adapter shares a package-free Queue mutation/wire core with Node;
each host supplies its own SDK transaction and hashing implementation. Importing
the backend SDK wrapper leaked root dependencies into the independent Cloud CI;
the portable leaf removes that dependency and preserves native receipt bytes.
The adapter verifies native control receipts before resume and delivers results
to the product ledger.
This pilot authorizes exactly Root 1; extra conversations/tasks are refused.
Official SDK Subagent support does not grant MiniClaw product Subagent authority.

History opens portable Storage, not another Harness. A paused Harness also
reconciles live tasks, which the real red/green test catches. Dedicated snapshot
read adapters avoid executor queue/transaction lock inversion. Execution expiry
stops native/admission wake scheduling while preserving read access and bounded
result-delivery Alarms. These behaviors are locally verified in actual workerd;
production Cloudflare deployment/hibernation and real model billing remain
Pending. See [evaluation.md](evaluation.md) for exact evidence classifications.

## Bot Team integration boundary

[Cloud Bot foundations](cloud-bot-teams.md) preserve the existing one-Session/DO
owner rather than sharing a privileged Harness across a Group. Optional marker
and producing-Task receipt support are implemented, but Cloud Group admission
remains closed pending durable progress, explicit lifecycle and formal business
association recovery. Public Cloud Goals are independently available only behind
the existing verified Goal flag; this does not grant Group execution rights.
