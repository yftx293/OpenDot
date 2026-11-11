# Bot Avatar foundation — Issue #58

The foundation (#60) provides the shared rendering primitive and pure presentation
mapping. The product follow-up integrates it with the reviewed frontend (#57),
based on main `e890e0240137a3c1de1beedf3de26e75a274a040`. Both dependencies were
still open at inspection. The follow-up remains separately reviewable and does not
alter #57, main, execution ownership or permission semantics. User avatars,
unsaved Profile editor previews and the static application icon remain separate.

## Identity and compatibility

`web/src/components/common/BotAvatar.tsx` accepts a stable Profile ID, accessible
name, optional uploaded image/emoji/color, presentation state and xs/sm/md/lg size.
Those sizes are 20/24/32/40 CSS pixels, preserving existing avatar geometry. An
interactive parent still needs its own minimum 44px target; the avatar is an image,
not a control. Use `decorative` when the surrounding control already supplies its
accessible Bot name and status. No live region announces every avatar update.

```tsx
<BotAvatar
  botId={profile.id}
  name={profile.name}
  imageUrl={profile.avatar_url}
  emoji={profile.avatar_emoji}
  color={profile.avatar_color}
  state={avatarState({ source: 'handoff', status: handoff.state })}
/>
```

An uploaded image wins. If loading fails, an explicit emoji remains the user's
fallback; without either, the generated face is used. A changed image URL gets a
fresh image attempt. Emoji behavior delegates to the existing component. Existing
user customization is not silently replaced. Generated shell colors accept hex;
other values fall back to the deterministic palette. The eyes adapt to custom
light/dark shells. Uploaded images and explicit emoji keep their content and now share the same subtle motion layer as generated faces.

A deterministic Profile-ID hash selects a soft silhouette, restrained palette,
small tilt, gaze and phase. Name, execution state, theme, route, device size and
socket status are not identity inputs. Nothing is stored in localStorage, and no
random value, model request, Canvas, WebGL or extra package is used. A small finite
palette can be shared by different Bots; their other identity features still derive
from their own seed. Keep the identity algorithm stable in subsequent integration.

## Motion and authoritative state

| Presentation | Generated body behavior           |
| ------------ | --------------------------------- |
| idle         | 6.4s subtle breathing             |
| working      | 2.8s small tilt/lift              |
| thinking     | 4.5s asymmetric drift             |
| waiting      | static                            |
| attention    | one 240ms emphasis                |
| completed    | 220ms settle, then idle breathing |
| error        | static                            |

Status glyphs and an accessible text alternative remain; color is supplementary.
Only the inner visual layer transforms; generated, emoji and uploaded avatars all breathe. The SVG keeps its stable identity tilt. The container, status glyph and click target do not animate.
A shared IntersectionObserver pauses offscreen avatars. A hidden document pauses
all registered avatars. The last unmount disconnects the observer/listener.
Reduced-motion disables all generated CSS animation and transitions, including
those inherited from theme changes. There is no JavaScript animation timer.

`bot-avatar/state.ts` is pure presentation. Handoff and Goal enums are imported
as types only. A caller must supply its existing current authorized snapshot;
the mapper does not authenticate a snapshot or infer any capability.

- A running Handoff/Goal maps to working. Queued, paused, cancelled and device
  waits settle; explicit approval/input/uncertain-effect states require attention.
- A conversation works only when its server execution state is active AND its
  live snapshot is busy. Warm/idle executors, reconnecting sockets and unknown
  states never imply work. Terminal/wait states take precedence over busy.
  The neutral pose is labelled “常态”, not a claim that a task has stopped.
- Thinking is available to the primitive but is not invented by these helpers:
  current generic execution snapshots do not provide a verified thinking phase.
- Do not copy a Goal's aggregate status onto every participant. Each Bot uses
  its own current Handoff/conversation; the Goal mapper represents Goal context.
- Do not drive controls, approval, completion or permission decisions from the
  avatar state. Existing product state remains authoritative.

## Validation and boundaries

The isolated browser fixture is explicitly labelled simulated presentation state.
It checks stable identity across viewport/theme/reload, image loading/fallback,
reduced-motion, finite emphasis, waiting, real CSS movement, offscreen pause and
unchanged click geometry. It is not a Bot execution or live-provider demo.
The six screenshots cover 1440×900 desktop, 390×844 touch and 900×1000 tablet:
[desktop dark](bot-avatars/screenshots/desktop-dark-avatars.png),
[mobile light](bot-avatars/screenshots/mobile-light-avatars.png).

The browser also records 60 requestAnimationFrame intervals in an emulated touch
viewport. This is a sanity sample, not a claim of 60fps on physical mobile hardware.
The [raw local sample](bot-avatars/emulated-frame-cadence.json) contains 60
intervals with 30 mounted avatars: median 16.7ms, P95 16.8ms, maximum 16.8ms.
The sample came from the complete browser suite on this host; it is not a
production workload benchmark. Physical iPhone/Android/PWA performance remains Pending.

Initial checks found an invalid fixture JSX closing bracket and incomplete mock
IntersectionObserver entry types; both were corrected. A browser reduced-motion
check then found active theme transitions; the component now disables those too,
retaining the zero-animation assertion. No existing assertion/timeout/skip changed.
Focused checks passed 28 tests across two Node/DOM files and both browser cases
(8.5s). The complete main-based Playwright regression then passed **28/28 (5.0m)**,
including the existing actual local HTTP/workerd/Device cases with fixture model
responses. Full typechecks, generated-source consistency and backend/Web/Runner
builds plus Worker dry-run passed. After the marker review, the complete Node suite passed **388 files / 3,165 tests**,
with 23 existing skips (132.07s). Electron build and Runner self-test passed. Formatting/docs/credential
checks run before commit; exact-head remote CI is linked from the PR before ready.
The Worker and authority sources/tests remain untouched; their full remote jobs
are still required. No existing test was changed.

```sh
make typecheck
npm run build:all
npm --prefix apps/cloud-agent run build
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm --prefix web run test:e2e
npm test -- --run
```

Use installed locked Playwright Chromium when no system executable is supplied.
Worker build is a dry-run for existing product test fixtures, not deployment.

## Product integration and rollback

Chief, My Bots, Bot details, Group task activity and replies, mention options,
Context/Sheet, Goal Team members, Work, Bot-linked attention, desktop sidebar and
mobile Chief navigation now use the same Profile-ID avatar. Historical replies
remain neutral instead of animating every old message for a new task. Unknown
identities retain existing generic navigation; no synthetic Profile ID is created.

Per-Bot Handoff state drives its activity. Goal members use only Handoffs belonging
to that Goal; the aggregate Goal state is never copied to every participant.
Unverified snapshots, archived Bots and committed recovery settle to waiting.
Native conversation work also requires an exact existing main-conversation run; a
warm process or socket alone never starts working animation. Sidebar/navigation
use neutral identity where no per-Bot execution snapshot is available.

The existing authorized Group snapshot adds display color/image URL beside emoji.
The existing Team overview includes the same display identity on activity,
participants and Bot-linked tool/device attention. No new endpoint, permission,
Profile prompt, grant, Scheduler or execution state is introduced. Existing public
avatar file behavior is unchanged. Goal review without an identified Bot keeps
its ordinary attention UI. Every action still uses the original server authority.

This follow-up is stacked on the reviewed #57/#60 versions so it can be developed
without mixing into #57. Dependency merge/main reconciliation remains **Pending**;
re-read live main and rerun checks after those dependencies land. The app icon
change #59 remains independent. Physical iPhone/Android performance remains Pending.

Roll back product consumers before removing the foundation component, shipping
matching frontend assets together. The new display fields are optional, so older
clients ignore them and newer clients tolerate an older server. There is no data,
Profile identity, session, receipt, approval, device or Runtime migration. Do not
remove the component while deployed pages still import it. Issue #58 stays open
until dependency/main integration and applicable mobile acceptance are complete.

The final accessibility pass gives attention an exclamation, error a cross,
working a clock and thinking an ellipsis, in addition to their text alternatives.
They remain distinguishable without color. A focused regression covers that
contract; browser captures and geometry checks wait for font readiness.

Final neutral-copy/font-readiness checks passed all 29 avatar Node/DOM cases
(5.01s) and both browser matrices (8.7s); the six captures/raw frame sample were
refreshed. The complete browser run above preceded this final rendering review;
exact-head remote CI runs the complete suites again before ready.

A separate follow-up on #57 (`6d30574`) repairs its omitted Group page and Chief
login destination. Local validation passed 30 browser cases and 3,144 Node tests;
its new remote checks and merge remain separate prerequisites. This avatar slice
does not include those integration changes.

## Product browser evidence

`bot-avatar-product.spec.ts` starts actual isolated Node/SQLite/Pi Durable with a
controlled HTTP inference fixture. Researcher executes one held task while
Developer stays idle. Desktop 1440×900, mobile 390×844 and tablet 900×1000, both
themes, compare the same ID/seed in contacts, Group activity and Context/Sheet.
Reconnection submits nothing; the original task waits for approval, is approved
on the phone and completes. An actual authenticated image upload then replaces
the generated face in both contacts and Group. Emoji customization is retained.
PNG captures disable animation; actual CSS motion/visibility/reduced-motion tests
remain in the foundation fixture. These are product pages with real local task
and approval receipts, not static simulated dashboard state. Inference and device
viewports remain simulated; no physical-device/real-provider/cloud deployment claim.

The first new browser run revealed an incorrect test setup: standalone was set
without an iPhone UA, so its hash URL used the normal browser router. The fixture
now declares the intended iOS UA; no production router check was changed. The
corrected product case passed (19.5s). The existing complete Goal → Researcher →
Developer → local CLI → approval → evidence scenario also passed with additional
per-member Goal-avatar assertions. It now checks that old Bot avatars disappear
after account switching, including a deliberately delayed former-owner response.

| View               | Dark                                                      | Light                                                       |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------------------- |
| Chief, desktop     | [dark](bot-avatars/product/desktop-dark-chief.png)        | [light](bot-avatars/product/desktop-light-chief.png)        |
| Group, desktop     | [dark](bot-avatars/product/desktop-dark-group.png)        | [light](bot-avatars/product/desktop-light-group.png)        |
| Context, desktop   | [dark](bot-avatars/product/desktop-dark-work-context.png) | [light](bot-avatars/product/desktop-light-work-context.png) |
| Chief, mobile      | [dark](bot-avatars/product/mobile-dark-chief.png)         | [light](bot-avatars/product/mobile-light-chief.png)         |
| Group, mobile      | [dark](bot-avatars/product/mobile-dark-group.png)         | [light](bot-avatars/product/mobile-light-group.png)         |
| Work Sheet, mobile | [dark](bot-avatars/product/mobile-dark-work-context.png)  | [light](bot-avatars/product/mobile-light-work-context.png)  |
| Context, tablet    | [dark](bot-avatars/product/tablet-dark-work-context.png)  | [light](bot-avatars/product/tablet-light-work-context.png)  |

[Bot-linked attention on mobile](bot-avatars/product/mobile-dark-attention.png).
All captures use disposable fixture accounts and tasks.

The first complete browser run passed 32/33. Its existing Shell screenshot setup
read a just-created automatic Goal revision while the Scheduler committed a new
one, so the intended pause correctly received GOAL_REVISION_CONFLICT (409). The
setup now retries only that exact typed conflict with a fresh authorized read, at
most four times, and explicitly requires the final Goal state to be paused. Other
errors remain fatal. Production CAS/ACL checks, existing safety assertions, test
timeouts and skips are unchanged. This repairs fixture preparation, not Runtime
recovery. The actual Team Goal [member states](bot-avatars/product/mobile-team-goal-avatars.png)
come from that Goal's own Handoffs.

Final edge checks reproduced a real `/mini` uploaded-avatar failure: a successful
upload still requested its root `/api/auth/avatars/...` URL outside the deployment
proxy. BotAvatar now applies APP_BASE only to those local upload paths; external,
data and already-based URLs are unchanged. Root and actual subpath builds test
real authenticated uploads on desktop and iOS-style hash clients. Independent
child-session runs are no longer attributed to the Workspace Bot without an
exact main run; they may use another Profile. Navigation reuses existing owned
Profile snapshots and does not fetch private Profile configuration just for an
icon; unknown identity retains the ordinary navigation icon.

## Final local product gate

After the subpath/native attribution fixes: full Playwright **33/33 (5.7m)**;
full Vitest **391 files / 3,181 passed / 23 existing skips (124.96s)**; focused
authority/rendering/state tests **53/53**. Final generated-source/full typechecks
and Web build passed. Backend/Runner builds, Cloud typecheck/dry-run, Electron
type/build and Runner self-test passed. Full local workerd **61/61 (273.99s)** and
actual Node/workerd authority **11/11 across 7 files (136.14s)** passed before the
last Web-only URL/attribution changes; those Cloud/authority sources remain
unchanged. Final exact-head remote CI is required before ready. No existing test
assertion, timeout or skip was removed or relaxed; the Shell setup adds a bounded
fresh-revision reconciliation and an explicit paused-state assertion.
