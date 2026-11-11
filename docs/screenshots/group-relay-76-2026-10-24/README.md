# First explicit Group relay enable — issue #76

Actual Chrome on the existing local Node service (`127.0.0.1:3000`),
390×844 viewport. The configured Magpie/WorkBuddy model was retained.

1. [Create](chrome-create-multi-dot.jpg): name a fresh Group and invite both
   existing Dots together. No Workspace or per-Dot grant form was used.
2. [Enable](chrome-relay-enabled.jpg): the ordinary button saves `relay-v1`.
   Before a message, the Group has zero Runs and zero native Group sessions.
3. [Real replies after reload](chrome-live-relay-reloaded.jpg): helson computes
   80 − 25 = 55, Miniclaw quotes that actual reply and checks it, and helson
   publishes the conclusion. Both names and the project/owner remain correct.

The frozen Run uses `relay-v1`, protocol 2, with three successful native inputs
and three model attempts; its speaker count is two. Reload keeps the same three
reply IDs and spends no additional attempt. The earlier WorkBuddy acceptance
Group keeps `coordinator-v1`. This evidence covers sequential relay with the
existing native runtime; it does not establish member Inbox/concurrent delivery,
Cloudflare deployment or a physical-phone keyboard. The original three-round
acceptance remains in [WorkBuddy screenshots](../workbuddy-acceptance-2026-10-24/README.md).

Implementation: one browser-safe settings builder is used by the ordinary
enable button and the advanced form. Unsaved settings start with relay only
when the user explicitly enables them. Saved strategy, participants and limits
are retained; current valid roster IDs and server revision supply the command.
Backend missing-policy defaults and frozen active Runs are unchanged.

Validation: the initial regression failed because the request omitted policy;
31 policy/context/protocol/Stop checks now pass, including old-client default,
same-key retry, non-owner rejection and active-Run freezing. Web build and
Web/E2E TypeScript checks pass. The first browser matrix exposed a desktop race:
the automatic default-chat redirect closed a creation drawer opened from the
rail. A deterministic delayed-entry regression fails on the old bundle. After
preserving creation through that automatic redirect, all seven creation/navigation/
private/history cases pass, including desktop disable/re-enable with saved
coordinator policy and limits. All six further native Group Stop/approval/work/
keyboard cases also pass. These thirteen cases use synthetic provider output
through the native runtime; the vendor evidence above remains separate. The
full repository suite and remote CI remain gates before merge.

Full-suite follow-up: at `70a257afcb0794b8a2418620f9914e7bb631aa08`,
411 files passed and 10 failed (3288 tests passed, 11 failed, 23 skipped).
The Workflow source contract still expected a direct Markdown component after
the shared-body refactor; it now follows the actual shared component, whose
sanitized rendering is also checked by the existing rendering tests. A serial
diagnostic run with that correction passed 67 tests and failed 11 across 11
selected files; it is not a full-suite pass. Group work/Stop, UTF-8 file checks,
ZIP import and the conversation rendering checks passed in that run. Restore,
native process startup and several bounded unit cases still failed. No test
deadline was increased. Experimental worker compilation did not resolve all
startup failures and was not retained.

GitHub CI run 119 for the same commit reports failure for validate,
cloud-agent and cloud-authority. Job logs returned 404, so the remote cause is
unconfirmed. These changes remain Draft and have not been merged.

Rollback reverts these Web parameter/default changes and rebuilds the Web bundle.
No schema or saved-data migration is introduced.
