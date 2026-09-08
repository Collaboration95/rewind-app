# Issue #10 acceptance evidence

Status: implemented and verified on `feat/us-01-home-start-screen-issue-10`; pull request and human review remain pending.

## Scope

- Darkroom Home/start screen recreated from the approved `rewind-home-iphone-preview.html` reference.
- Matching 390 px layout, darkroom palette, countdown, angled 35 mm film strip, weekly prompt, member progress, quota, and primary action.
- Three bundled blurred demo images used only inside sealed film frames.
- Explicit `LOCAL DEMO` status so static sample names, counts, and moments cannot be mistaken for real account data.
- The primary action opens the Camera route; Home, Camera, Chat, and Archive remain reachable from the bottom navigation.

Excluded from this change: real accounts, private media, persistence, camera capture, chat behaviour, archive data, cloud services, and backend integration.

## Acceptance criteria

- [x] A clean app launch renders the Darkroom Home/start screen from `App.tsx`.
- [x] The visual hierarchy and palette follow the approved iPhone reference.
- [x] `Weekend People` is exposed with the `header` accessibility role.
- [x] The countdown is labelled `Reveal in 2 days 14 hours`.
- [x] The film strip clearly presents three locked, blurred demo moments.
- [x] The weekly prompt, member progress, quota, and `Add to the roll` action are visible.
- [x] Static sample content is explicitly labelled as a local demo.
- [x] The four main navigation entries remain available, with exactly one selected entry.

## Verification

- `npm run check` — passed: Prettier, ESLint, strict TypeScript, two scaffold tests, and four focused app tests.
- `npm run build:web` — passed; Expo exported the web bundle and all three bundled WebP assets.
- Accessibility inspection — passed: the Home heading, countdown, film description, progress labels, primary action, and selected tab are exposed.
- Navigation checks — passed: each bottom tab opens its matching route, and the Home primary action opens Camera.
- Responsive visual inspection — passed at 390×844 and 1280×900 after the demo images finished rendering.

## Synthetic screenshots

- `home-start-screen-mobile.png` — exact 390×844 app frame.
- `home-start-screen-desktop.png` — centered 390 px app frame in a 1280×900 viewport.

## Traceability

- Issue: https://github.com/Collaboration95/rewind-app/issues/10
- Parent story: https://github.com/Collaboration95/rewind-app/issues/5
- Navigation task: https://github.com/Collaboration95/rewind-app/issues/8
