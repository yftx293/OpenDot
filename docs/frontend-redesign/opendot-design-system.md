# OpenDot canonical design implementation

`DESIGN.md` from #63 owns the product contract. This change builds on the
conversation entry/geometry in #65 and addresses the presentation part of #64.
It does not mark the complete repository/deployment rebrand finished.

## Gap list addressed

1. Previous colors differ from the canonical light/dark palette.
2. Legacy `muted`/`accent` mean background to shadcn, but text/brand in DESIGN.
3. Shared radius aliases produce six unrelated corner sizes.
4. Settings primitives and conversation surfaces use different elevation.
5. Login overrides the entire theme with orange, aurora and animated gradients.
6. The app loading logo animates independently of execution state.
7. Default Dot names are overwritten with Chief in navigation/chat/detail.
8. Group snapshots and result author projections overwrite default Dot names.
9. Dot details lack a direct name editor using the existing protected API.
10. Web/PWA/Electron labels still show the previous product brand.
11. A native productName change can silently move Electron's user data.
12. Existing preview screenshots predate the canonical design.

## Actual implementation

`product.css` defines the canonical palette, spacing hierarchy, 8/13/20px radius,
flat/ring/raised elevation and 150/200ms motion. The shared Tailwind aliases make
existing advanced/settings pages participate without changing their controls.
Ordinary advanced sections are flat; popovers, dialogs, sheets, approval and
attention retain their visible surface. Local DM Sans remains the body face;
headings request Outfit with local/system fallbacks. Google Fonts access returned
HTTP 403 in this environment: Outfit is **not bundled or claimed as loaded**.
No external font request or new dependency was added.

The canonical `--muted` and `--accent` are text and brand. Legacy `bg-muted` and
`bg-accent` map separately to `--muted-surface` and `--accent-surface` so menus and
inputs do not become gray text/solid blue backgrounds accidentally. Small
metadata and status text use accessible foreground aliases; `--meta` keeps the
design value for non-body uses. Dark blue buttons use dark ink for contrast.
The pre-existing 4.5:1 browser assertions remain in force.

Login now inherits the same palette, uses a quiet authentication surface and has
no aurora, shimmer, decorative animation or scoped orange token override. The
chosen app mark stays static. Its generated assets remain the reviewed #59 robot;
only the wordmark text changes to OpenDot. Individual Dot avatar animation still
requires authoritative server state.

Navigation, private chat, contacts and Bot detail preserve actual Profile names.
Default role selection uses `is_default`/stable IDs. The existing Profile PATCH
and store handle renaming (including all existing capability locks and cleanup);
there is no optimistic authority. Every shell entry, including a direct Group
link, reads the existing Profile API. Its cache is fenced by authenticated owner
and read generation, and is refreshed on connection; a delayed old-account or
older-name response cannot overwrite a newer identity. Committed higher server
Profile versions also survive an earlier list response. Group read projections and result author labels
use the same actual name. Legacy input matching and Handoff execution semantics
are retained. Existing Dot names, including legacy names, are not overwritten.

Web, PWA and native shell show OpenDot. Custom site names remain supported. The
old default site brand is normalized only in presentation. Electron retains
`cc.miniclaw.desktop`, `MINICLAW_*`, its IPC bridge and the original `Miniclaw`
user-data directory. Cookie, storage, database, Runtime identity, receipts and
Scheduler are unchanged. Repository/package/release compatibility cleanup from
#64 remains a separate follow-up; npm package names and Docker tags stay stable.

## Validation and rollback

Name preservation tests first failed against the forced-Chief alias. Deferred mock-response race tests reproduced a previous-account response
overwriting the new Dot/Provider metadata, an older read rolling a renamed Dot
back, and an in-flight list overwriting a committed higher Profile version. All are checked independently of the live HTTP rename flow. The actual
HTTP/SQLite browser test renames a default Dot through its settings, opens new
independent logins on desktop and touch, verifies the same Profile ID/default role
and Group mention, and checks rendered canonical tokens in both themes without
model requests. New-test fixture errors (unsupported singular Profile GET and CSS
minifier duration spelling) were corrected to use the real list API and compare
milliseconds; these are not reported as application regressions.

Full Vitest passed **394 files / 3,190 tests**, with the same 23 existing skips
(123.59s). Full Playwright passed **36/36** on the final design/presentation tree
(5.8m); after the additional committed-version race fix, full Vitest passed and
the real rename/brand browser cases passed **2/2** (17.8s). Generated sources,
full typecheck, browser/Electron types, backend/Web/Runner/Electron builds and
Runner self-test passed. The review PR links exact-head hosted CI separately.
The 46 [captures](opendot/README.md) include canonical 1440×900 and 390×844 views.

Earlier full runs found stale old-brand/navigation assertions, corrected to the
new user-facing copy while preserving capability/protocol/security assertions.
One run of the untouched Durable ownership test returned `error` instead of
`owned` for the second opener; a deterministic temporary probe reproduces a
regular DB file being misclassified as a dangling symlink between path lookups.
The ownership suite subsequently passed 6/6 and the full run passed 3,190 tests.
This existing Runtime race remains a separate follow-up, not a visual fix, and
no assertion/retry/skip was relaxed to hide it. Keyboard/phone screenshots use Chromium emulation, not physical Safari.
Real Cloudflare, real Provider, native packaged Electron and physical phone
acceptance remain Pending. No production resource was changed.

Rollback: revert this presentation commit while retaining #65's conversation
entry and #59's selected logo exports. No database migration or ownership
conversion is needed. User edits made through the existing name API persist;
reverting CSS does not undo those authorized edits.
