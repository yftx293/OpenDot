# Device vision preflight

The local Magpie `/v1/models` response advertised
`opencode-go-3/space-bunny-free` as accepting text and images. A direct
OpenAI-compatible request with a generated solid-red PNG returned HTTP 400:
the upstream reported that the model was unavailable. This was not a successful
vision-model test. Only synthetic pixels were sent; no device screenshot,
conversation text or private data was used.

The currently working `opencode-go-3/beam-free` model is advertised as
text-only. Model-list capability metadata alone is therefore insufficient to
claim actual image understanding. The product's Device attachment path remains
separate from model input, and real Kimi, visual-model and end-to-end screenshot
acceptance remain pending.

## Node Durable image-input implementation

A Node Durable Session may explicitly opt its configured provider into image
input using `MINICLAW_MODEL_VISION_INPUT=true` in the provider's custom
configuration. The model editor exposes this as a default-off ‘模型支持图片输入’
switch and explains that an authorized screenshot is sent to the provider.
Changing the opt-in changes the
frozen runtime configuration identity; it does not prove the upstream model
actually supports images.

For an explicitly image-authorized paired-device MCP result, the Host verifies
the exact completed approval, original device command and still-active device
and session grants before decrypting its bounded PNG. It holds the bytes in a
small in-memory, expiring one-use registry and rechecks authorization when the
native model request is dispatched. Only the current tool result receives the
image, in a copied provider-request context. The Durable transcript retains a
text notice, not image bytes; a later user turn and an owner restart do not
replay the screenshot. Text-only models continue to receive an explicit
unavailable notice. Tool execution is never retried to restore an image.

The paired-device product fixture uses a synthetic MCP server and simulated
model to exercise one approved image input, a later text turn, and absence of
PNG content from the Durable, message and device databases. Unit checks cover
revocation during model admission, duplicate receipts, expiry and clearing.
These are not Kimi, Cloud, Coding Runner, actual-model vision or physical Mac
acceptance; those remain open. A real Kimi backend must enforce origin, target
and revision constraints before it can be exposed.
