# Issue #10 acceptance evidence

Status: implemented and verified locally on `feat/us-01-home-start-screen-issue-10`; remote push and pull request are intentionally pending.

## Scope

- Initial Rewind Home/start screen.
- Original Darkroom visual hierarchy created with React Native styles and no external assets.
- Accessible screen title and explicit `Local demo` status.
- A continuously moving decorative film strip based on the team's earlier Home direction, with a static fallback when reduced motion is enabled.
- Minimal wording and no claim that an account, cloud connection, upload, navigation, or later capability exists.

Excluded from this change: navigation, group/profile/contribution state, camera, chat, archive, authentication, cloud services, and final visual polish.

## Acceptance criteria

- [x] A clean app launch renders the Home/start screen from `App.tsx`.
- [x] `Moments worth waiting for.` is exposed with the `header` accessibility role.
- [x] The entry state is labelled `HOME` and `LOCAL DEMO`.
- [x] The visual treatment is original, code-native, and uses no copied assets or product text.
- [x] The screen contains no account, cloud, upload, navigation, or later-capability success claim.
- [x] Decorative film frames do not expose media, counts, group state, or interactive controls.
- [x] The film strip moves continuously when motion is allowed and stays static when reduced motion is enabled.

## Verification

- `npm ci` — passed; npm reported the 10 known moderate transitive Expo-toolchain findings already tracked by the foundation work.
- `npm run check` — passed: Prettier, ESLint, strict TypeScript, two Node scaffold tests, and two focused Home screen tests.
- `npm run build:web` — passed; Expo exported the web bundle to `dist/`.
- Expo web startup at `http://localhost:8081` — passed.
- Browser accessibility inspection — passed: `Moments worth waiting for.` is exposed as a level-one heading, `Local demo` is labelled, and the decorative film is absent from the accessibility tree.
- Browser boundary check — passed in an isolated Playwright browser: zero buttons, no account/cloud/upload claims, no horizontal overflow, and zero app console or page errors.
- Motion check — passed: the film transform changed during an 800 ms observation; with the browser reduced-motion preference enabled, it remained unchanged.
- Responsive visual inspection — passed in Chrome on Windows at 1280×900 and 390×844; both evidence screenshots were reviewed after capture.

## Synthetic screenshots

- `home-start-screen-desktop.png` — 1280×900 desktop viewport.
- `home-start-screen-mobile.png` — 390×844 mobile viewport.

## Traceability

- Issue: https://github.com/Collaboration95/rewind-app/issues/10
- Parent story: https://github.com/Collaboration95/rewind-app/issues/5
- Foundation dependency: https://github.com/Collaboration95/rewind-app/pull/13
- Pull request: pending until foundation PR #13 is merged and repository push access is available.
