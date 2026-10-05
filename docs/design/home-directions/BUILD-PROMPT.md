# Build prompt: the Warm Glass UI rewrite

Paste everything below the line into a fresh agent session started in
`/Users/speedpowermac/Documents/projects/CODE_MAIN/NUS/SWE5006/rewind-app`.

---

You are implementing the Warm Glass UI rewrite of Rewind's real-account app, end to end, in one
branch and one PR to `dev`. The design is finished and frozen. Your job is to build exactly what it
shows. Don't redesign anything. Work autonomously and keep iterating until every screen in the spec
is built and behaves as written. Ask the owner only when truly blocked: a decision only they can
make, a check that needs their physical iPhone, or a sign-in that needs their password.

## 0. Ground rules

- Read `AGENTS.md` and `CLAUDE.md` first. They apply, with one change for this run: **one PR for
  the whole rewrite**, and **one review pass at the end** (section 9), not one per change.
- Another agent may be working in the main checkout. **Never** switch branches, commit, stash or
  clean in `/Users/speedpowermac/Documents/projects/CODE_MAIN/NUS/SWE5006/rewind-app` itself, and
  never touch other worktrees (`git worktree list`). Do all work in your own worktree:
  ```sh
  cd /Users/speedpowermac/Documents/projects/CODE_MAIN/NUS/SWE5006/rewind-app
  git fetch origin
  git worktree add -b guru/warm-glass-ui ../rewind-warm-glass-ui origin/dev
  git worktree add --detach ../rewind-design origin/ui-concept/final-screens   # read-only reference
  ```
  Start from the latest `origin/dev`. Before opening the PR, merge `origin/dev` again if it moved.
- Product decisions (AGENTS.md, 4 October 2026) still hold:
  - The real-account app is the product.
  - **The synthetic Demo is frozen.** Keep it working and its tests green, add nothing to it, and
    don't restyle it unless it shares a component you are replacing anyway.
  - Reminders are web push only.
  - iOS ships as the PWA.
  - Media is `disk` locally and `s3` when hosted.
- **Never remove a test assertion.** When copy or structure changes, rewrite the assertion to check
  the new equivalent.
- Diagnosis rule: two focused attempts per problem. If still stuck, write the blocker down (it goes
  in the PR description) and move on.
- Add no new dependencies unless a screen truly can't be built without one. Prefer what the repo
  already has (Expo / React Native Web, `react-native-svg` if present, existing fonts setup).
- Add the `doing` label to the issues in section 6 when you start. Reference them in the PR without
  closing keywords.

## 1. The spec (source of truth)

The design lives on branch `ui-concept/final-screens`, folder `docs/design/home-directions/`. In
your read-only worktree it is `../rewind-design/docs/design/home-directions/`. View it with:

```sh
cd ../rewind-design/docs/design/home-directions && python3 -m http.server 8765 --bind 127.0.0.1
# open http://127.0.0.1:8765/index.html#final
```

Hosted copy:
https://htmlpreview.github.io/?https://github.com/Collaboration95/rewind-app/blob/ui-concept/final-screens/docs/design/home-directions/index.html#final

**The Final tab is the build spec.** Every phone on it is live and clickable.

- **Read `final.js` in full first.**
  - `FINAL` holds every flow (A Open, B Sign in, C Create account, D Get into a group, H Home, V
    Video, P Photo, M Your moments, G Group menu, S Settings, T Chat, R Archive, F Film, N
    Notifications).
  - Each step is `[code, kind, opts, title, how you get here, actions [label → code], behaviour
notes]`. Build every step, every action and every behaviour note.
  - `ARCHIVED` lists screens that are **out of scope**. Don't build them: A4, B4, C1–C5, H8, H9,
    S2, S8, S9, S18, T7, F2.
  - `STATUS` is how far `dev` already is per screen. `APPSTORE` holds per-screen App Store
    requirements: build them too. `APPSTORE_LIST` is the checklist.
  - `FIN_RULES` sets the transitions and motion timings: push 0.35 s cubic-bezier(0.2, 0.8, 0.2,
    1); menu 0.22 s; dialog dim with 3 px blur; toast 2.6 s; shutter tip 1.9 s; launch fade 0.5 s;
    Reduce Motion means cuts.
- **Exact copy and markup** come from the renderers. Match wording, order, states and error
  messages exactly.
  - `screens.js`: sign-in, sign-up, Settings and all its dialogs, Your moments, camera, film,
    report sheet.
  - `tabs.js`: chat, archive, group menu.
  - `states.js`: every Home state and its card.
  - `app.js`: Home body, dock, shutter ring, header, icons `I`.
- **Visual system** comes from the CSS. Port the tokens; don't eyeball them.
  - `styles-r2.css` `.c6` tokens: `--bg #f6ede3`, `--ink #33231a`, `--muted rgba(51,35,26,.74)`,
    `--line`, `--accent #e0703a`, `--ring-on #e8834a`, and the rest.
  - `styles-glass.css`: the glass recipe for cards, dock, shutter and buttons.
  - `styles.css` / `styles-r3.css`: the glow, the layout and the phone metrics. Design at 390 pt
    wide, with safe areas.
  - `styles-screens.css` and `styles-tabs.css`: per-screen styles.
  - Fonts: **Fraunces** (with `'SOFT' 100`) for display, **Geist** for UI, **DM Mono** for small
    labels.
  - React Native has no `backdrop-filter`. On web use CSS. On native use the closest available
    (`expo-blur` only if already installed, otherwise translucent fills). Never block on parity:
    the PWA is the delivery target.
- **Dock icons** are `I.home`, `I.chat`, `I.archive` and `I.camera` in `app.js`: warm duotone,
  where `.d` is the accent fill. Archive is the film reel, where `.f` is the ink fill.
- **App icon** is "Campfire" in `icons.js` (`APP_ICON.svg`, 512×512).
  - Export it to every icon slot the app has: `app.json` icon and adaptive icon, favicon, PWA
    manifest icons, apple-touch-icon, and the splash.
  - Export 1024×1024 PNGs, **square, no rounded corners, no transparency**: drop the `rx` from the
    background rect.
  - Inline the `blur18` filter (`feGaussianBlur stdDeviation 18`) from `index.html` into the SVG
    before rasterising. Use any rasteriser already on the machine (headless Chrome via Playwright
    works).
- The README in that folder summarises the product rules, and the Screens and States tabs show
  more states.

## 2. What `dev` has today (audited 5 Oct 2026; verify, line numbers drift)

- `App.tsx`:
  - the shell
  - welcome, sign-in and create-account (username, password, confirm password; `POST
/auth/register`)
  - the session-expired message
  - the Demo tabs
- `src/groups/RealAccountGroupExperience.tsx`: the real-account experience. Today it has:
  - Home / Chat / Archive tabs and no Settings tab
  - the groups list with "Switch to…"
  - create and join group
  - the members list
  - invites: create, revoke, copy or share code, and a "Copy invite link" button
  - sign-out with its recovery states
  - "Restoring your group…"
- `src/reminders/RealGroupSettings.tsx`:
  - owner: prompt and IANA timezone
  - member: "My group reminders" with Snooze for 7 days / End snooze
  - "Enable reminders on this device"
- `src/capture/*`: `CameraCaptureScreen`, `VideoCaptureScreen`, `video-review`, `retro-looks`
  (Disposable Flash, Compact Digital as the default, 8mm Home Movie, VHS Camcorder), permissions,
  upload cancel and retry, and the file-picker fallback.
- `src/contributions/ContributionLedger.tsx`: "My contributions", with delete-and-replace once a
  week.
- `src/chat/RealAccountChatScreen.tsx`, `ChatScreen.tsx`, unread store: replies, ✨ only, 2,000
  characters, connection states. Real accounts have no unread badge yet.
- `src/archive/ArchiveScreen.tsx`: premiere card, in-app player, Download film, Your released
  clips.
- `src/invites/deep-links.ts`: invite links. The product decision is codes only, ABC-DEF.
- Server, in `server/src/http.ts`:
  - `POST /auth/account/delete`, with a password re-check and a media purge
  - `/real/blocks` and `/real/groups/:id/reports`, which report moments
- Server rules: invite codes are 6 letters shown `ABC-DEF`, single use, 24 h by default
  (`server/src/groups/invites.ts`). Member limit is 2–10. Allowance is 5 moments / 30 s, 15 s per
  clip, and a photo counts as 3 s. The reminder is Sunday 19:00 in the group timezone. The
  premiere lasts 24 h.
- Recent merges #437 (App Store readiness: `app.json` purpose strings and export flag) and #439
  (still capture waits for a frame; sign-up field errors) are already in.

## 3. Scope: build every non-archived screen in the Final tab

Map each flow onto the real-account app. Notes on the parts that need decisions already made:

- **Shell.**
  - The header shows the group name centred, which opens the group menu G1/G2 and replaces the
    Home groups list.
  - The avatar sits on the right and opens Settings S1. That makes Settings a pushed screen, not a
    tab.
  - The dock has Home / Chat / Archive as glass tabs, plus a separate shutter with the 5-segment
    allowance ring.
  - Dock rules per Home state are in `states.js` (`SHUTTER_OFF`): no shutter in error, denied or
    no-group. No dock at all in denied or no-group.
- **A1 launch.** A web/PWA launch screen: Campfire icon and "Rewind" on cream, at least 0.6 s, then
  fade. It never auto-creates a Demo session. Use the same art for the PWA splash and the
  apple-touch startup image.
- **A2, A3, A5, B1–B3, B5, C6, C7.**
  - Username-only sign-in.
  - Create account is username + password + confirm, then the "Your account is ready. Sign in to
    continue." banner on sign-in.
  - Terms and Privacy line on C6.
  - No email, phone, verification code or password reset anywhere.
- **D1–D5.**
  - Join with a six-letter code, auto-formatted `ABC-DEF`, with the exact server error messages.
  - Create group has name, prompt (3 presets or custom) and a member limit stepper (2–10).
  - Remove "Copy invite link" and stop generating invite links in the UI.
- **H1–H7, H10, H11.** Every Home state, with the countdown, week, prompt card, allowance row and
  this week's moments as metadata only. Allowance row → M1. Premiere card → F1. After sealing:
  the row roll and the "Sealed" tip.
- **V1–V8, P1–P2 (this closes the layout notes in #413).**
  - Full-screen dark viewfinder; mode switch; the moments-and-seconds pill.
  - Record ring with auto-stop.
  - Review with a trim strip (0.5 s minimum) and the four looks.
  - Upload with cancel; upload failed (V7) with retry.
  - Sealed screen with Done only.
  - Pre-permission button says **Continue**, with no skip. Camera off (V2) has Open Settings and
    Check again.
  - Keep the file-picker fallback, restyled.
  - Don't regress the #401 or #329 fixes. If you touch the review preview, make it show the
    captured video.
- **M1–M4.** Your moments: delete one per week and retake; a failed moment offers retry or delete
  (not counted against the weekly delete).
- **S1, S3–S7, S10–S17, S19–S21.**
  - Account card.
  - Group block: owner gets Prompt, Time zone and Invite; a member sees them read-only.
  - Members, Switch group, Have an invite?, Create a group.
  - Reminder switch, with the S10 pre-prompt the first time it is turned on. Continue is the only
    button; S11 Add to Home Screen is shown on iPhone Safari only. Snooze for 7 days.
  - Help and support, Privacy Policy, Terms of use.
  - Sign out with confirmation (S12).
  - Delete account (S19–S20).
  - Members S15 → person S16 (Report, Block; no Remove member) → report sheet S17.
  - Demo-only rows stay Demo-only.
- **T1–T6, T8–T11.**
  - Restyled chat: "3 new messages" divider; message actions ✨ / Reply / Report.
  - Reconnecting and offline pills; "Not sent · Retry"; couldn't load; premiere banner (T10).
  - Give real accounts the unread badge the design shows.
  - T11 reports a chat message. If the reports route only takes moments, extend it with a message
    target, with a focused server test.
  - Blocked people's messages are hidden for the blocker.
- **R1–R6.** Archive: this cycle's step on top, then earlier films playing inside their card (one
  at a time), Show older films, first-cycle and error states.
- **F1, F3, F4.**
  - Full-screen film with segment bar, pause and "Talk about it".
  - End screen: cast, Talk about it in Chat, Replay, Save film, Save your own moments.
  - Report a moment (F4). #429 also needs report from the moment view: add Report for the moment
    on screen in F1, using the same sheet.
  - The owner gets "Remove this moment" there; contributors already delete their own in M.
- **N1.** The weekly reminder only. There is no film-ready notification. Tapping it opens H1 for
  the right group.
- **Issue halves this PR finishes:**
  - **#428** client: Delete account in S19–S20, calling `POST /auth/account/delete`, then back to
    A2 with "Your account is deleted."
  - **#429** client: report, block and owner remove, plus hiding blocked members' moments and
    messages.
  - **#430**: public `/privacy` and `/support` pages on the hosted web app (no sign-in), with the
    content listed in #430. Link them from C6 and S1.
  - **#413**: capture layout.

## 4. Out of scope

- Everything in `ARCHIVED`.
- Cognito (#363, #364), Postgres (#261), backups (#172), App Store listing tasks (#433–#436) and
  the frozen report (#362).
- Native-only push and compiled iOS.
- New Demo features.
- Don't edit `doc/planning/report/` or `doc/planning/archive/`.

## 5. Working loop

Repeat until done:

1. Pick the next flow, in this order: shell, H, V/P, M, S, D, A/B/C, T, R, F, N, launch and icons.
   Open the matching lane in the Final tab next to your build.
2. Implement it with small components shared across screens: glass card, glass button, sheet or
   dialog, toast, header, dock, shutter ring, list row, field.
3. Check it in the cheapest real environment (AGENTS.md tiers). `npm run web` is enough for UI
   only. For real-account flows, run `make run-real` (10-minute cycles) and open
   `http://localhost:8090` with two accounts in two browser profiles.
4. Compare it to the spec phone screenshot by screenshot at 390×844 (and one narrow and one wide
   width). Fix differences in spacing, type, colour, copy and states.
5. Run the focused tests for what you touched (`npm run test:focused -- frontend tests/<file>`),
   then `npm run test:fast`.
6. Commit with a clear message (follow the `git-commit` skill), then continue. Push the branch
   regularly.

Keep a local checklist of every spec code (A1…N1) with built and verified status. Don't commit it;
copy it into the PR description at the end.

## 6. Tests and checks before the PR

- `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run architecture:check`.
- `npm run test:fast`.
- Because this touches web export, routing, PWA and accessibility: `npm run test:slow`,
  `npm run test:a11y`, `npm run test:coverage:frontend`.
- New or changed server routes (the message report target, anything for #428 or #429) each get a
  focused server test.
- Text meets WCAG AA on the warm background. Every control has an accessible name. Touch targets
  are at least 44 pt.

## 7. Final walkthrough (do this before the PR, and fix what you find)

With `make run-real`, two accounts (A the owner, B a member) in two browser profiles, at iPhone
size, walk the **whole** app and tick every non-archived code:

- Sign-up:
  - A: launch → welcome → create account (taken username, too-short password, mismatch) → banner →
    sign in (wrong password, offline via devtools) → no group.
  - A: create group (limit 3) → invite code → revoke → new code.
  - B: sign-up → join with an unknown, malformed and revoked code → join with the right one → full
    group check with a third account.
- Home and capture:
  - Every Home state you can reach.
  - Capture a video (permission prompt, deny, then re-allow; trim; each look; cancel upload;
    offline upload failure; retry; sealed).
  - Capture a photo.
  - Your moments: delete and retake, then the weekly limit; quota-used and seconds-used shutter
    behaviour.
- Social:
  - Group menu and switching.
  - Chat: unread divider, react, reply, report with block (messages vanish), offline, retry.
  - Archive.
  - Let a 10-minute cycle end: developing → premiere card → film → end screen → save → report a
    moment → owner removes a moment.
- Settings, every row:
  - prompt, time zone, members, block and unblock, reminder pre-prompt, snooze
  - privacy and support pages, signed out too
  - sign out (confirm)
  - delete account for B: sign-in then fails, and A still sees A's own content.
- Then repeat the core path once in Safari's responsive mode with Reduce Motion on.
- Keep a findings list and fix everything before opening the PR.

## 8. Open the PR

- Merge the latest `origin/dev` first and re-run `npm run test:fast`.
- PR to `dev`. Title: "Warm Glass UI rewrite". Reference #413, #428, #429 and #430 without closing
  keywords. The body has:
  - what changed, by flow
  - the spec checklist (every code, built and verified)
  - before/after screenshots of H1, V5, S1, T1 and R1
  - the server changes
  - known gaps and blockers
  - what still needs the owner's iPhone (#329, #348, #401 checks; web push; PWA install)

## 9. One review, one fix loop

From a worktree of the PR head, run one Codex review:

```sh
codex exec review --base origin/dev -m gpt-6.1-sol -c model_reasoning_effort="high" -c service_tier="priority"
```

Fix every blocking finding in one loop, re-run `npm run test:fast` (and `test:slow` if routing or
PWA changed), push, and put the non-blocking or false-positive findings in one PR comment. Wait for
the aggregate Quality check to go green.

**Don't merge.** This PR touches authentication (account deletion) and is large; the owner merges.
Finish with a short report: PR link, checklist status, review findings and what you did about
each, blockers, and the phone checks left for the owner.
