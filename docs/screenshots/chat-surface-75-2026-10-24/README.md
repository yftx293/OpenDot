# Chat surface — issue #75

Chrome captures from the existing local Node service at `127.0.0.1:3000`,
using its saved WorkBuddy conversations. These screenshots exercise presentation
and preserved history; they do not represent additional inference or deployed
Cloudflare/physical-phone acceptance.

| View                  | Before                                   | After                                  |
| --------------------- | ---------------------------------------- | -------------------------------------- |
| Group, 1440×900 light | [Before](before-group-desktop-light.jpg) | [After](after-group-desktop-light.jpg) |
| Group, 390×844 light  | [Before](before-group-mobile-light.jpg)  | [After](after-group-mobile-light.jpg)  |

Additional captures: [mobile dark](after-group-mobile-dark.jpg),
[message details](after-group-mobile-details.jpg),
[private chat](after-single-mobile-light.jpg).

Normal messages retain independent IDs, bodies, author identity and actions.
Per-message timestamps and token counts are available through the message menu.
Group run counters are in Group settings → Discussion details. Completed runs
produce no default success banner. Stop, pending approvals and uncertain/error
states remain separate from presentation grouping.

Observed in Chrome: exact timestamp/source in both message-detail sheets; focus
returns to the original action; message actions are 44px; the mention list sits
above the input; 390×520 keyboard simulation leaves the latest reply and composer
visible; search finds the saved WorkBuddy group and navigation returns to the
existing private conversation. Light/dark Group views and reload retain history.
No console errors were observed. No fresh inference was sent for these captures.

Validation: Web build, full project typechecks and docs checks passed, as did
22 targeted presentation/control checks. The original four isolated browser
cases all exceeded the unchanged 120-second backend readiness deadline. After
loading the host helper Coding SDK only when queried (PR #81), creation/navigation,
lost-ACK creation, fresh native Group discussion and private chat passed. One
private cold-start attempt timed out during a concurrent backend rebuild; its
separate serial retest passed in 56.6 seconds (backend ready in 32.9 seconds).
Six further native Group browser cases passed, covering Stop/late replies,
approval waits, independent work return, composer geometry and history scrolling.
These use synthetic provider output through the actual native runtime. The full
repository suite and remote CI remain separate gates. Prior vendor three-turn
evidence is in [WorkBuddy acceptance](../workbuddy-acceptance-2026-10-24/README.md).

Rollback changes only these Web presentation files, then rebuilds the Web bundle.
There are no schema, runtime, dispatch, policy, grant or saved-data migrations.
