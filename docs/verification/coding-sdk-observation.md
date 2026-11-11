# Coding SDK invocation observation

The Pi Coding adapter emits a private correlation ID at each call to the SDK
stream function and an end event when that stream's result settles. The host
correlates these events with the exact product session and input and exports a
metadata-only `dot.model.sdk_invocation` span with host-observed timestamps.
The internal event is consumed before chat delivery; prompts, responses,
provider credentials and model context are not copied into the event.

This boundary counts SDK invocations, not HTTP attempts. Provider-internal
retries, precise transport start, usage and cost are unavailable here; the
span explicitly reports unknown usage and unpriced cost. An absent end at a
completed input is incomplete, not success. Observation is optional and must
not change dispatch or consume the stream. If the child exits without an input
receipt, the host also finalizes the pending SDK and tool events attributed to
that specific child as incomplete; it does not close unrelated sessions.

The product HTTP fixture in `tests/coding-observability-product-http.test.ts`
contains the planned end-to-end regression with a synthetic provider and a real
Coding Runner. This change has not yet been tested; run it with the remaining
PRs in the consolidated acceptance pass.
