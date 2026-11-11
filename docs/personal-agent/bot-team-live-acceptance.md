# Bot Team real-model acceptance

## Latest repaired Node acceptance — 2026-10-21

The final transport implementation passed two consecutive complete real-model
runs, with unchanged `cat-jam-free`, `openai-completions`, six-request grants,
180-second business assertions and all eleven original checks. Both runs used
three actual dispatches per Bot. No synthetic fallback was used.

| Completed (UTC)     | Checks  | Bot requests | Initial / restarted process readiness |
| ------------------- | ------- | ------------ | ------------------------------------- |
| 2026-10-21 13:06:16 | 11 / 11 | 3, 3         | 8.884s / 9.248s                       |
| 2026-10-21 13:07:50 | 11 / 11 | 3, 3         | 8.784s / 10.852s                      |

Both runs killed the real backend with SIGKILL, retained the original Handoff,
Session, Submission and approval identities, approved exact proposals through
mobile Chromium, verified one private artifact and one delivery per Bot, and
confirmed reconnect did not add a request or result. Native read/artifact Tool
receipts were inspected after completion.

Repairs move charging out of API-key resolution and into actual stream dispatch,
start Web controls before Session recovery, and bound each Node model stream to
60 seconds. A timeout is an error governed by the original Harness retry policy;
user cancellation remains aborted, and late output cannot turn an error into
success. Transport retries are explicitly zero so every retry crosses the same
persisted grant counter. Node's bundled fetch used Undici 7 while the configured
proxy dispatcher came from Undici 6 on this host; model transport now uses fetch
from that same installed Undici package. Custom fetch remains supported. Only
allowlisted transport codes are added to safe diagnostics; no headers, prompts,
keys, file bytes or raw provider errors are exported.

The pre-final-transport reruns are retained: one stopped after recovery with one
Bot complete at three attempts and another waiting at four; a later run recorded
repeated connection errors and exhausted six real attempts. These are failures,
not accepted runs. The generic original connection errors do not prove every
underlying network cause; the incompatible client/dispatcher pair was an observed
configuration defect, and the final consecutive results are the acceptance proof.

The bounded cold-process fixture allowance is now 120 seconds rather than 30;
one earlier valid cold restart took 33.252 seconds. Actual durations are exported.
The separate controlled recovery-hold regression checks Web/auth while recovery
is deliberately held. Its full-graph preload receives a 120-second cold-bootstrap
allowance after a 60-second cold-load timeout on this host. Business assertion deadlines and the
six-request grant were not increased. The CLI forces non-incremental TypeScript
emission so a stale entry timestamp cannot masquerade as a fresh product build.

This is local Node Durable plus mobile browser emulation. It does not establish
physical phone/PWA or deployed Cloudflare vendor-inference acceptance.

An earlier local run on 2026-10-21 passed with the explicitly configured
OpenCode Zen Go `cat-jam-free` model through Pi's `openai-completions` API.
**Historical repeatability status on `9cce601`: failing**. This supplements the
[deterministic product scenario](product-convergence.md); it does not replace
[deployed Cloudflare acceptance](cloudflare-real-acceptance.md).

## Reproduce

Provide `MINICLAW_ZEN_API_KEY`, `MINICLAW_ZEN_BASE_URL` and `MINICLAW_ZEN_MODEL`
through a secure process environment, then run:

```sh
npm run test:bot-team-live
```

The existing live runner freshly builds the production backend, Web and agent
runner before starting the isolated scenario. It invokes installed Node tools
directly so macOS hosts with non-executable npm shims work too. It preserves
existing public icon assets. Missing credentials return Pending with exit 2;
invalid endpoints fail before build or inference. The provider stays bound to
the approved HTTPS `opencode.ai` host, with no fallback to another model.

`test:personal-agent-live` still selects only its original Goal scenario.
The Bot Team case is separate and opt-in; ordinary CI never sends vendor
requests. Screenshots, video and network traces stay disabled. Only a safe JSON
result is printed, without credentials, cookies, prompts or provider responses.
Temporary accounts, encrypted configuration, grants, SQLite state and artifacts
are deleted after the run. Production accounts/configuration are not modified.

## Verified scenario

1. Configure two separate Bot Profiles/workspaces with the real provider and
   bounded grants for `read_workspace_file` and `create_approved_artifact`.
2. Select Researcher and Developer through the real desktop mention picker,
   submit one Group message, and detach the desktop page.
3. Each Bot reads a different randomly generated proof file from its own
   authorized workspace. Both propose exactly that file's bytes for approval.
   The proof is absent from the user prompt; a fabricated read cannot pass.
4. Kill the actual backend with SIGKILL. Restart it and verify original Handoff,
   Session, input, native Submission and approval identities remain unchanged.
5. Open the Group on an emulated iOS standalone/hash client. Review each exact
   proposal and approve it through the product's mobile work sheet.
6. Verify two completed native Group deliveries, two private files with mode
   0600, one artifact per Bot and model attempts within each explicit grant.
7. Disconnect/reconnect and reload. Verify no extra Handoff, model attempt or
   result delivery. Read the committed native histories to confirm successful
   file-read and artifact Tool receipts for each Bot.

The earlier successful run passed all 11 exported checks. The helper's synthetic model
received **zero requests**; the authenticated product provider bindings and
committed real Tool results were checked independently.

## Latest real-model reruns — 2026-10-21

Two later attempts on `9cce601` failed. The earlier success remains historical
evidence; it is not evidence that the current path is reliably green.

- Attempt 1 passed both explicit mentions, separate workspace/session checks and
  both exact-content proposals. It then failed inside `f.start()` after actual
  SIGKILL, before mobile approval/recovery checks could complete. The retained
  safe DTO identifies the call site, but does not establish whether startup
  timed out or the process exited.
- Attempt 2 failed while waiting for both Bots to reach approval. A read-only
  observation during that run found one Handoff waiting for approval with three
  model attempts and the other failed with six attempts. No budget was raised.
  The root cause of the extra attempts is not established.

The retry added temporary, allowlisted error categories without changing
assertions or deadlines; that instrumentation was removed after retaining its
safe DTO. It reused freshly built product artifacts. Neither attempt verifies
mobile approval, final artifact delivery or reconnect for that attempt. Do not
combine successful stages from separate attempts into an end-to-end pass.

Provider connectivity and real workspace reads have positive evidence.
Repeatable recovery, bounded completion and the complete approval/delivery path
remain open. Future failures need safe per-Handoff lifecycle, attempt and Tool
outcome summaries retained before scratch cleanup; raw provider responses,
keys, cookies and prompts must stay out of shared evidence.

## Boundaries and findings

This establishes real-model **directed two-Bot Group work on Node Durable**.
It does not establish automatic multi-Bot planning, deployed Cloudflare Group
lifecycle/cost, external IM delivery, Electron GUI, physical iOS/Android or
physical keyboard/background behavior. #34/#35/#30 retain those gates.

Initial live attempts exposed missing iOS/hash-router setup in the new test
client. Both iPhone UA and standalone state are now explicit, and the Group
timeline must be visible before approving. Live actions have a bounded timeout.
Those harness failures were not counted as product passes.

Local regression also reproduced a managed-filesystem rename behavior that left
an extra legacy plugin staging sibling. Independent temporary-directory names
remove the prefix collision; existing migration checks still verify separate
inodes, rollback/cleanup and idempotence. Test scratch roots now use the canonical
temporary path, and process-heavy Node tests cap worker concurrency. Existing
security assertions and test/lease deadlines remain unchanged.

## Regression evidence

The final Node regression passed **395 files / 3195 tests**, with 23 existing
skips. Full type checks and production builds passed. Four browser acceptance
cases passed across actual Group/Handoff backends and the local Cloud/Device
Goal flow. The completed Goal view also hides its obsolete next-action prompt;
a separate rerun verifies that terminal mobile view. These browser dimensions
are emulated and the Cloud/Device scenario uses synthetic inference.
