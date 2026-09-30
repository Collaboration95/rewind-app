# Project 11 delivery evidence

This branch groups the Project 11 entry, account, layout, and feedback work into one reviewable change. The owner resolved the Demo placement conflict with: **Keep Demo only on Sign in.** The Welcome screen offers account creation and sign-in; `Try Demo` is available after opening Sign in.

## Issue mapping

| Issue | Change and proof                                                                                                                                                                                                                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #243  | Branded cold-launch screen stays visible for at least 600 ms after its first render; a regression test covers fast session restoration. Welcome is shortened. See the cold-launch and Welcome captures below.                                                                                                                                               |
| #304  | The Sign in `Try Demo` path starts the seeded sample session. The screenshot flow reached the Home screen through the isolated local runtime. No live Demo data was changed.                                                                                                                                                                                |
| #305  | Real-account requests require the same-origin HTTPS boundary. The runtime distinguishes an absent browser session from a revoked session. The local smoke run exercised the UI over loopback HTTPS; auth integration tests cover the server contract.                                                                                                       |
| #306  | Native iPhone simulator capture confirms a hidden status bar and continuous dark surface through both safe areas. The installed web/PWA shell uses `viewport-fit=cover`, matching theme colors, safe-area framing, and a service-worker cache bump. The iPhone 14 Plus Add-to-Home-Screen report is recorded below; physical PWA verification remains open. |
| #307  | Added public self-registration using the existing salted password storage, bounded request body, and per-source rate limit. Registration creates no session, Demo identity, or group membership.                                                                                                                                                            |
| #308  | Added username/password/confirmation UI, inline outcomes, pending/disabled states, HTTPS guard, direct sign-in after account creation, and invite-intent retention. Fresh browser entry no longer shows a false expired-session warning.                                                                                                                    |
| #309  | Added pressed-control response and a short route transition that respects reduced-motion settings. Loading feedback is covered by the cold-launch screen.                                                                                                                                                                                                   |
| #296  | Home copy no longer exposes Demo or runtime diagnostics. Demo and local-runtime disclosure remain in Settings; see the Settings captures.                                                                                                                                                                                                                   |
| #267  | Research-only brief: [performance profiling research](../doc/planning/performance-profiling-research.md). It discloses Luna agent authorship and independent critique; it does not claim a performance campaign.                                                                                                                                            |
| #145  | `npm run test:production-e2e` passed twice against disposable local data (two tests per run, including reset-to-reveal). This is local synthetic evidence only; required hosted journeys and rollback/acceptance observations were not run. See the limitation below.                                                                                       |
| #232  | Launched this branch through `make run` on iPhone 15 simulator, iOS 17.5, Expo Go 57.0.9, using an isolated temporary database. The app reached Welcome; see the simulator capture below. This does not satisfy the issue's physical-iPhone collaborator check.                                                                                             |
| #314  | Investigation did not reproduce the reported native Video crash or produce an iOS exception. No speculative code change was made; the issue remains open for device logs.                                                                                                                                                                                   |

The five additional issues are grouped under the **Miscellaneous Epic** (#319) in Project 11. They remain open where the issue's device or live-host acceptance gate has not been met.

## Screenshots

Captured from the current branch against a disposable, seeded local runtime. Chromium used a **393 × 852 CSS-pixel viewport at DPR 3** (iPhone 15-sized emulation); these are browser captures, not screenshots from physical iOS hardware. The local app was served through a loopback-only HTTPS proxy so the secure-entry screens exercised their HTTPS-enabled UI state. The demo session used synthetic fixture data only.

### Cold launch

![Cold-launch screen at an iPhone 15-sized viewport](images/project11-cold-launch-iphone15-viewport.png)

### Welcome

![Simplified Welcome with Create account and Sign in](images/project11-welcome-iphone15-viewport.png)

### Registration

![Secure account registration form](images/project11-registration-iphone15-viewport.png)

### Sign in and Demo placement

![Sign in form with Try Demo available only on this screen](images/project11-sign-in-iphone15-viewport.png)

### Sample Home

![Home reached through the local synthetic Demo session](images/project11-home-iphone15-viewport.png)

### Settings and diagnostics

![Settings screen with Demo identity disclosure](images/project11-settings-iphone15-viewport.png)

![Local runtime diagnostics placed in Settings](images/project11-settings-runtime-iphone15-viewport.png)

### iPhone 14 Plus Add-to-Home-Screen report

![Owner-provided iPhone 14 Plus screenshot showing a white status-bar strip in the live dev PWA](images/project11-iphone14-plus-a2hs-white-bars-2026-09-30.jpg)

The owner reports white bands at both ends when opening the dev URL as a Safari Add-to-Home-Screen app on an iPhone 14 Plus. The supplied capture visibly shows the white top status-bar band. I reproduced the same live dev entry screen in the browser; it still has the older Welcome/Demo layout. The `dev` HTML shell does not include `viewport-fit=cover`, while this branch does. The service-worker cache version now advances so an already-installed copy fetches the corrected shell on deployment. The screenshot is evidence of the pre-fix live deployment; it is not a physical-device verification of this branch.

### Current branch on iPhone simulator

![Current branch Welcome on iPhone 15 simulator with edge-to-edge dark surface and no OS status bar](images/project11-iphone15-expo-go-welcome-simulator-2026-09-30.png)

The current branch loaded in Expo Go 57.0.9 on the iPhone 15 simulator running iOS 17.5. The app surface fills the top and bottom safe areas without white bars, and the native status bar is hidden. The blue floating gear is Expo Go's developer overlay. This is simulator evidence only; it does not replace the physical iPhone Add-to-Home-Screen check or the physical-device requirement in #232.

## Verification

- `npm run check` — passed (formatting, lint, architecture, types, server and app tests, and accessibility browser checks).
- `npm run test:responsive` — passed; 22 browser checks.
- `npm run test:production-e2e` — passed twice; two tests per run against disposable local data.
- Native simulator — `make run` launched the current branch in Expo Go 57.0.9 on iPhone 15 / iOS 17.5 with an isolated temporary database; the app reached Welcome and showed no white top/bottom bands.

## Remaining acceptance gates

- **#145:** the live CloudFront app was inspected read-only. Its current entry did not match the new branch. The reset-to-reveal test mutates groups, invitations, contribution state, and release state, and no safe hosted reset/rollback route was confirmed. The two required hosted runs, restart persistence, rollback/fallback observations, and non-author rehearsal remain outstanding; no deployment or live fixture mutation was performed.
- **#232:** the current branch now opens in iPhone 15 simulator / iOS 17.5 / Expo Go 57.0.9 with `make run` and an isolated temporary database. This verifies the simulator workflow only; the issue's physical-iPhone collaborator walkthrough and report remain outstanding.
- **#314:** Luna's investigation and the simulator attempt did not yield a native crash log or root cause. A physical iPhone exception is still needed before choosing a fix.
- **#267:** this is a research deliverable only. No profiling campaign or before/after performance claim was made.
