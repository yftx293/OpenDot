# Group real-model acceptance, 2026-10-28

The isolated Node Durable product fixture ran on PR #109 source `dfd2b285`
against the user-authorized local Magpie route with `opencode-go-3/beam-free`.
The fixture used no synthetic fallback and exercised three sequential requests
in the same Group, an actual host restart after the first request, stable Dot
sessions, three ordered participant replies and one final summary per request.
Each participant's result used the expected shared values 100, 120 and 115;
the fixture checked that later participants read prior public replies. The
configuration explicitly used relay-v1 with three turns, at most one turn per
Dot, and an 8192-token output limit. The machine-readable result contains no
credentials or conversation text.

This is one successful real-model Node/API run with those explicit bounds, not
Chrome, mobile, unrestricted relay, container-workspace, or Cloudflare
acceptance. The independent Docker bind-mount test still fails for host-encrypted
prompt bytes. Earlier failures and their limitations remain documented.

The companion `test-single-three-rounds-live.ts` ran the same actual provider
against a fresh owner-private Node Durable conversation. The product API
accepted three turns, returned exactly one assistant reply for each, and each
reply contained the expected current balance (100, 120, 115). The fixture
restarted the Host after turn one and the same Session accepted subsequent
turns. It asserts that the synthetic fixture provider received no requests.
It checks expected numeric values, not every word or the visual presentation.

## Colima bind-mount content probe

On the same Mac, Node created six synthetic 23-byte files in one host directory
and the existing `helsome/miniclaw-agent:latest` image read them through a
read-only Colima bind mount. The extensionless `env`, `.json`, `.jsonl`, and
`.txt` files matched the synthetic plaintext; `.md` and `.ts` appeared as TSD
ciphertext. The probe used no real configuration or session data. This narrows
the reproduced problem but does not prove the behavior of every real workspace,
filesystem location or encryption policy. In normal release mode the image
supplies its own runner source and prompts; the affected host overlay is an
explicit developer option. Other actual host-mounted data remains unverified.
