# Integrated fixture acceptance, 2026-10-27

The combined, unmerged acceptance branch `codex/issues-integrated-acceptance`
was tested at commit `405c77d3573b53cf2443f3c1c16c66cda897c5ab`. It contains
the then-current Group, MCP, Mem0, Kimi device and observability branches plus
integration conflict resolutions. This is not an exact-head result for any
single PR; later commits require their own verification.

- Root and personal-agent TypeScript checks, Web TypeScript check and runner
  TypeScript check passed; backend, Web and runner production builds passed.
- One combined run of 36 Vitest files passed 207 tests after the first run
  exposed six failures. Corrections were committed to their respective PRs.
- Eight Playwright mobile-project cases passed, including Group creation and
  relay, owner MCP configuration and a paired file-device process recovery. The
  model was simulated. Two earlier runs failed the device fixture because of
  a macOS temporary-directory symlink and a stale UI label; both were fixed.
- `fixture-regression.json` is the isolated runner's actual report: four
  fixed suites and 19 tests, synthetic model/fixtures, no external network
  sandbox. The report's revision refers to the integration branch above.

No real Kimi backend, vision model, Mem0 service, Langfuse project, Cloudflare
staging or physical GUI device acceptance is implied. WebBridge and KimiCU were
not installed at their documented local paths when checked. The evaluation
runner has no OS network fence and is not yet a production-backed dataset or
judge experiment.

## Real free-model Group pilot

On the same integration snapshot, an isolated actual Node Durable Group used
the user-authorized local Magpie route with `opencode-go-3/beam-free`. The first
two attempts failed before any Dot spoke: the coordinator received an empty
answer and the run ended with `GROUP_DISCUSSION_INVALID_DECISION`. The second
report records only response shape, not message text. A separate direct, short
model request returned content; it does not explain the two failures.

A third attempt inserted a loopback observer that forwarded the original SDK
request to Magpie without replacing the model output. It completed one Group
run: three persistent Dot Sessions, three speaker turns, seven committed native
turns and four canonical public messages. The fixture asserted that later Dots
received earlier actual public replies, and the Host restarted during the run.
There were eight observed attempts; one in-flight request was aborted during
restart, and the seven completed responses had nonempty output. This single
successful run does not explain or erase the earlier failures and does not
establish three separate user discussion rounds, Chrome UX, or production
stability. The observer's binding in this diagnostic was a synthetic label;
identity and causality assertions come from the native Group fixture.

The three JSON reports contain counts, hashes and bounded diagnostic metadata;
they do not contain the API key, prompts or generated replies.

A fourth direct Magpie Group attempt used a temporary instrumented compiled
transport to count stream fields without retaining content. Its five completed
provider streams each had nonempty text and finished with `stop`; the run
finished after only two speakers even though the test required three, so the
acceptance failed. Reasoning and output lengths are recorded in the JSONL, not
reasoning text. This is a separate early-finish failure, and does not identify
why the first two direct attempts returned empty content. The instrumented
compiled file was temporary and is not part of the PR.

## Explicit participation guidance follow-up

Integration commit `6ba6c23` includes the PR #109 coordinator guidance change:
explicit requested participants, order and contribution count should be honored
when eligible and within budget. The protocol and Group HTTP regression passed
18 tests across two files. In real-model follow-up, the first direct attempt
still failed with an invalid first coordinator decision. Two subsequent direct
attempts completed three speakers, seven native turns and a Host restart each.
Those two used temporary stream-count instrumentation; it recorded lengths,
usage and termination only. They demonstrate individual runs, not three user
rounds in one conversation or a guarantee against the remaining empty-output
failure. No model response content, credentials or hidden reasoning were saved.

## Three consecutive Group prompts and output-budget diagnosis

The new three-round acceptance sends three sequential arithmetic requests into
one Group, checks three distinct ordered speaker replies and a final answer
in each run, checks the values 100 → 120 → 115, verifies later peers see the
actual earlier canonical messages, and restarts the Host after round one.
No private conversation or synthetic model is used. The first 4096-token run
failed at the first coordinator decision; captured stream metadata showed a
`length` finish with 4096 output tokens, 4095 reported as reasoning tokens,
and zero visible text. Earlier failures without stream capture cannot all be
attributed to this cause.

PR #109 adds a bounded per-provider `MINICLAW_MODEL_MAX_OUTPUT_TOKENS` setting
(256–16384, default unchanged at 4096); changing it is included in the frozen
runtime fingerprint and the normal model budget reservation. Empty Group
responses now produce a distinct user-facing error. A combined run of the
Group protocol, product model metering and Group HTTP suites passed 26 tests.
The real three-round fixture explicitly used 8192 output tokens. It still did
not pass: in the diagnostic repeat the first discussion finished with fewer
than three speaker turns. Increasing the cap addresses the observed reasoning
truncation, not deterministic adherence to participation instructions, and
increases the reserved output budget for explicitly configured providers.
No three-round success is claimed.

## Three-round relay with explicit bounds

The first relay attempt retained here had four speaker turns: the three selected
Dots spoke, and the model nominated the first Dot again. The successful repeat
explicitly configured the existing `relay-v1` Group settings with three total
turns and one turn per Dot, matching the test's requested participation bounds.
With the authorized `opencode-go-3/beam-free` route and a configured 8192 output
limit, the isolated actual Node Durable Group completed three sequential user
prompts in one Group. All three rounds produced the ordered three Dot replies
and final summary with the expected balances 100, 120 and 115. The fixture
asserted that later Dots read each previous public reply, preserved all three
Session IDs, and restarted the Host after the first run. Each run used four
model attempts; there was no synthetic model fallback. The tested integration
source is commit `c53e189` on `codex/issues-integrated-acceptance`.

This is one successful API/Node pilot under explicit limits. It is not a Chrome
or physical-device acceptance, does not establish reliability for unrestricted
relay or coordinator policy, and does not erase the previously recorded empty
response and extra-speaker failures.

## Per-Dot limit in product settings

PR #109 now exposes the existing `max_turns_per_dot` setting as a one-to-three
choice in the discussion settings, so an owner can select the one-turn bound
used in the real relay pilot. On integration commit `d6e0ca5`, the Group UI,
settings and HTTP regression passed 19 tests. The Group creation Playwright
suite passed six cases; the desktop case saved the bound and checked it again
at a 390-pixel viewport. An earlier browser run timed out because the fixture
was still serving a Web build from before this change; rebuilding the Web app
and rerunning the complete suite resolved that fixture issue. This browser
suite uses synthetic responses; it is not the real-model three-round pilot.

## Model output setting in product UI

At integrated commit `6127e16`, the provider editor exposes an optional
256–16384 output-token bound under advanced settings, identifies its Durable
conversation scope and warns that reasoning consumes the budget. A mobile
Playwright product fixture saved 8192, verified that other provider environment
values were preserved, reopened the editor and observed the saved value. Web
TypeScript and the production Web build passed. The browser scenario uses an
isolated provider configuration and performs no inference. The three-round
real-model result above remains separate from this UI test.
