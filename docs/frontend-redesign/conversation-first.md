# Conversation-first integration (#61)

This follow-up replaces the Dashboard entry in #57 on the reviewed functional
integration tree. #57 remains Draft; its earlier green checks do not establish
the new product criterion. #60/#62 retain their separate avatar review scope.

## Gaps addressed

1. Chief opened a dashboard and used a separate first-message composer.
2. Workspace, session and navigation columns competed with the conversation.
3. Composer height and keyboard padding could obscure the last message.
4. Group keyboard handling subtracted height from the entire conversation.
5. Opening desktop Context changed the conversation/composer width.
6. Standalone deep links could lose explicit Bot identity or team query state.
7. Work, team Goal creation and attention belonged in secondary views.
8. Vendor inference, Cloudflare staging and physical-phone acceptance remain
   separate external gates; this frontend change does not establish them.

## Implemented behavior

`/bots` resolves the existing authenticated `chat-entry` and enters its verified
workspace main conversation. Viewing Chief performs no message/session POST and
never calls the model. All messages use the existing `MessageInput`. Explicit
Bot entry, remembered child selection and legacy workspace URLs retain their
existing admission and selection rules. Unavailable entries show a retry/team
route; no fallback execution owner is selected.

Desktop has one primary navigation column: search, Chief, Bots, Groups and recent
conversations, with Work/attention/settings below. Existing workspace management
and session CRUD remain explicit secondary controls. Product Context and native
file Context overlay the canvas instead of resizing the composer; each contains
its own close control. Tablet/mobile retain Radix Sheets and focus handling.

Private and Group conversations share a measured bottom dock. `ResizeObserver`
reserves the actual dock height in the scrolling timeline. Desktop keeps a
12px bottom gap; mobile uses safe-area-aware spacing and raises only the dock
with `visualViewport` keyboard occlusion (including offsetTop). The canvas
height stays stable. Active conversations hide bottom navigation. Group mentions
continue using the existing keyboard/touch/IME composer above the dock.

Team Goal creation and the existing attention cards are available in My Work;
`/goals?view=attention` selects attention directly. State and sensitive controls
still come from the existing authoritative APIs. Read-only navigation indexes
are owner/generation fenced; stale responses cannot restore a previous user's
Group or attention badges. No Runtime, ACL, Scheduler, Approval, Device protocol,
receipt, database or dependency change is included in this follow-up.

Standalone conversion preserves only supported route identity/query keys and
strips unrelated parameters, including credentials. Existing hashes and login
routes are left alone; URLs confer no access rights.

## Validation and evidence boundary

The initial geometry test failed on the old `/bots` destination. A separate
canonical-link test reproduced the dropped `bot` parameter. Intermediate browser
runs exposed a close button obscured by Context and outdated test navigation;
these were corrected without loosening security/receipt assertions.

The focused six product tests pass against actual isolated HTTP/SQLite/native
execution and a finite-file Device CLI. Inference is a fixture; keyboard/touch,
iPhone UA and PWA are Chromium emulation. The geometry test checks real rendered
rectangles, measured timeline padding, one rail, context width stability,
keyboard-only dock movement, scroll-to-last-message visibility, mention geometry
and zero automatic submissions after reconnect/reload.

The integrated browser suite passed 35/35. Generated types, full typecheck and
backend/Web/Runner builds passed. Full Node validation initially reported
3185 passes and one stale manifest start URL assertion; the corrected canonical
root assertion and the link/logo regressions passed 10/10. A fresh full Node run
is required on the final design head. Screenshots in `after/` capture this
conversation baseline before the subsequent OpenDot token/name migration.

The user-authored `DESIGN.md` from #63 is preserved as the canonical contract.
Its token and Dot naming implementation follows separately; these baseline
captures must not be described as the completed OpenDot redesign.
PNG captures disable animation for reproducibility. They are not proof of live
Cloudflare lifecycle, vendor inference, physical-device performance or native
Electron behavior.

## Review and rollback

Review the conversation-only diff from #62 as well as the replacement integration
against main. The replacement contains the already reviewed functional frontend
and avatar ancestors; it does not require merging #57's intermediate Dashboard.
Revert the conversation-first commit to return to the previous frontend tree.
There is no data migration or Runtime reassignment. Existing server state and
receipts remain intact. Keep #30/#34/#35 open for their outstanding real gates.
