# Kimi browser device integration (work in progress)

## Current status (2026-10-31)

The product settings now include **电脑与浏览器**, where an administrator can
enable device nodes and set up a local KimiCU window or a dedicated WebBridge
tab. Pairing, device grants and per-call approvals still apply. The WebBridge
integration exposes page reading only; model-driven navigation and clicking
are not enabled because the redirect fence described below was insufficient.
KimiCU screenshot isolation and image-bearing model behavior have not been
reverified for this configuration; the settings UI states this limitation.

With the device node's optional `--kimi-status` flag, a host that advertises
`kimi_cu_readiness` on an authenticated heartbeat can receive the KimiCU
service registration and the permission lines reported by the local doctor
process. The device list labels those lines as doctor-process reports; actual
service-process permissions and target grants remain unknown. Older hosts get
the previous browser-only heartbeat. If a host is rolled back and rejects the
new optional field, the node retries subsequent heartbeats in the legacy form.
This diagnostic does not grant or enable desktop or browser control.

KimiCU now has an opt-in device MCP adapter pinned to an owner-configured app,
PID and window. KimiCU processes for the same macOS account share an
OS-account-derived lock directory and one desktop-input resource, including
when different app windows are selected. A real isolated app was observed, clicked and screenshotted
through a paired node with separate exact-call approvals and an image grant;
the model in that test was a fixture. See
[local evidence](../verification/kimi-local-2026-10-28/README.md). The doctor
reported Accessibility and Screen Recording granted for its process, while
the actual product fixture also demonstrated desktop interaction. This does
not prove every application, race or Cloud path.

WebBridge has an opt-in, read-only device MCP adapter pinned by the local
owner declaration to a dedicated session, tab, origin and loopback daemon. It
generates a fixed synchronous page read and exposes no model-supplied
JavaScript. On head `e4b61b2`, the real daemon v2.0.27 / extension 2.0.24,
a paired node, a device grant, startup consent and exact-call approval were
exercised with a synthetic page and model. The page read counter remained zero
before approval and became one after approval; after the test navigated that
same tab to an outside origin, its synthetic secret was not returned to the
model. This is not real-model or UI acceptance. At the time, provisioning a
dedicated session required explicit local setup; the settings UI now creates one.

On source head `f581206`, the same opt-in product test also passed with the
user-authorized local Magpie `opencode-go-3/beam-free` provider. The real model
requested the fixed read tool, the fixture counter was zero before approval,
and the resulting reply contained the synthetic allowed-page marker. After a
test-induced move to the other origin, the synthetic outside marker did not
appear in the conversation. The synthetic model endpoint received zero calls.
This establishes two real-model product turns for read and rejection only; it
does not establish screenshots, browser actions, redirect prevention, UI setup,
Cloud, or a general model reliability guarantee.

Critically, this version accepts `args.tabId`; `args.tab_id` was silently
ignored in the fixture, so the latter must never be used as a fence. WebBridge
actions, redirect prevention and screenshots remain unavailable. The following
sections preserve earlier observations as historical implementation context.

## Redirect-fence probe (2026-10-28)

In an isolated WebBridge-owned tab with two synthetic loopback origins,
`Network.setBlockedURLs` was configured with an allow pattern for the first
origin and a block-all pattern. A direct cross-origin `fetch` produced no
request at the other fixture. However, navigating to an allowed URL that sent
an HTTP 302 to the second origin did reach that second origin. Consequently
this CDP rule, as observed in the installed daemon/extension/browser, is not
a sufficient redirect fence. The exact underlying cause was not established.
It must not be used to enable navigation or click under an origin-only grant.
The tests used only synthetic pages and the test session was closed.

## Earlier implementation notes

Issue #101 depends on the shared device MCP channel in #103. Kimi's official
browser-extension documentation describes a local WebBridge daemon, an
`/command` envelope, and session-scoped tabs. Those descriptions are a lead,
not proof that a particular installed binary offers an atomic target fence.

The device-side target policy defines explicit origins, a server-owned session,
a short-lived observed target, exact action approval, and per-process resource
serialization. It accepts only text reads, bounded navigation, and click/fill
using observed element references. It rejects arbitrary script, CDP, network,
file upload, screenshot paths, and application launch. The backend interface
requires a target fence and redirect enforcement inside the trusted device
adapter; a URL check before or after a WebBridge call does not provide that
property. No WebBridge adapter is registered until those semantics are proven.

The device policy uses an OS-backed SQLite exclusive lock for each resource in
an owner-private device directory, including across cooperating node processes;
a separate-process test verifies blocking and release after SIGKILL. This tests
cooperating SQLite lock users, not an actual Kimi browser backend. Real Kimi protocol/version
and licensing verification, a trusted backend,
startup readiness, binary attachment/image adaptation, approvals wired to this
policy, actual Mac browser/desktop acceptance, and the Cloud path remain open.
The initial implementation did not install a daemon or grant OS permissions.
Screenshots and KimiCU desktop control remain unsupported.

The device-local `scripts/kimi-webbridge-status.ts` diagnostic invokes only the
installed binary's documented read-only `status` command, with a deadline and
output limit. It projects connection state and version metadata without paths,
logs, suggested shell commands, or browser content. A connected extension does
not establish scoped-control readiness: that flag remains false until target
and redirect enforcement are implemented. The diagnostic has since been run against a real daemon as recorded below. A node explicitly started with `--kimi-status`
periodically reports only the validated readiness projection over the authenticated
device heartbeat; the owner device panel displays it while the node is online.
The diagnostic does not grant or enable browser control. This path is untested.

The device-side screenshot output helper now issues one-use paths in an
owner-private real directory. It accepts only the exact issued path, rejects
symlinks and hard links, checks bounded PNG header/dimensions and bytes, and
rechecks authorization and directory identity after reading. Supported
non-interlaced 8-bit RGB/RGBA PNGs are decoded with CRC validation and
re-encoded from pixels to discard metadata, then bounded again. Model image integration and actual browser target serialization remain
necessary before enabling it.

The Host now has bounded, encrypted, per-command PNG attachment storage with
owner/session/device/binding identity, digest checks, short expiry and an
aggregate quota. A device-only upload endpoint accepts an image only during an
exact authorized command lease and live MCP approval, with a separately
selected screenshot grant. It verifies the raw digest, decodes and normalizes
the PNG again at the Authority, and rechecks the grant before committing.
The receipt separately identifies the uploaded source digest and stored canonical
image digest, so a valid re-encoding need not have byte-identical output.
Expired ciphertext is pruned periodically. The device MCP adapter now uploads
one approved PNG and persists its attachment receipt with the original command;
the Authority verifies the receipt against encrypted bytes. Text-only sessions
receive an explicit notice instead of a fake image interpretation. Model image
input and the actual Kimi backend remain unconnected; this path is untested.

Reference: https://github.com/MoonshotAI/kimi-code/blob/main/plugins/official/kimi-webbridge/skills/kimi-webbridge/SKILL.md

## Local Kimi readiness observed on 2026-10-28

On an arm64 Mac, the official Kimi Browser Extension 2.0.24 and the official
WebBridge daemon v2.0.27 reported a connected state. The downloaded WebBridge
binary is ad-hoc signed; the official installer does not provide a signed
checksum manifest for it. This readiness observation does not establish
origin fencing, action approvals, or any OpenDot-to-browser call.

The official KimiCU 0.6.8 application was checked against the vendor's SHA-256
manifest and verified with macOS code signing before installation. Its
`service-status` reported registered, and a local MCP initialize plus
`tools/list` returned 20 tool declarations. The inventory contains broad
operations such as `launch_app` and `js`; none were invoked or registered with
OpenDot. OS Accessibility and Screen Recording permissions were not inferred
from service registration, and no desktop state or screenshot was read.

`scripts/kimi-computer-use-status.ts` provides a device-local read-only
projection of service registration. It reports OS permission status as unknown
and scoped control as unavailable. Browser and desktop operations remain
unavailable until the target, application, approval, and result boundaries in
#101 are actually enforced and exercised. Connected and registered status alone
are not product acceptance.

The desktop policy skeleton binds a device-local application allowlist, PID,
window and native observation identity to one exact approved click or value
change. It serializes through the same process-safe resource lock as browser
operations, consumes an approval before dispatch, and invalidates an old
observation when a fresh observation fails. It is not a KimiCU backend: a
trusted adapter must still enforce those identities atomically at execution,
connect the device approval ledger, and demonstrate real app and screenshot
handling before exposing desktop tools. The optional `doctor` projection
reports only permission lines observed by that process and never implies that
the device service has permission or that an application grant exists.
