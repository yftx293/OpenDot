# KimiCU screenshot scope fixture

This opt-in fixture opens two partially overlapping solid-colour windows inside one
synthetic app. Compile `main.swift` into a temporary `.app` with bundle ID
`net.opendot.kimi-screenshot-fixture`, start it only with an unlocked Mac, and
use KimiCU's `list_windows` to select that process's green and red window IDs.
Then run `tests/kimi-cu-screenshot-scope-live.test.ts` with
`OPENDOT_TEST_KIMICU_COLOR_PID`, `OPENDOT_TEST_KIMICU_GREEN_WINDOW`, and
`OPENDOT_TEST_KIMICU_RED_WINDOW` set to those exact IDs.

Alternatively, after unlocking, run `node scripts/diagnostics/run-kimicu-window-scope.mjs`.
It compiles and starts only this temporary fixture, takes its process and window
IDs from the fixture itself, runs the live test, and removes the fixture on exit.
It refuses to start when the session is locked or its state cannot be determined.

The test calls the real KimiCU backend for each fixed window, checks its
accessibility text for the selected label and absence of the other label,
decodes the two images in memory, and checks that each image contains its own dominant colour
but almost none of the other window's colour. It does not write screenshots or
use a user's application. A skipped test is not a pass. This direct backend
test does not prove product approval, model vision, race-free capture, every
window arrangement, or deployed Cloud behavior.
