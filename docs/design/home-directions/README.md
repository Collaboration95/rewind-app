# Home · Warm Glass

Presentation-only prototype of the Rewind **Home** screen, from the #189 concept review.
Nothing here changes app code, runtime contracts or data. All members, counts and textures are synthetic;
sealed moments are never shown as media.

The page only shows the design and how it behaves. Feedback goes in the team chat, not on the page.

## Open it

- Hosted from this branch: https://htmlpreview.github.io/?https://github.com/Collaboration95/rewind-app/blob/ui-concept/bibi45c-warm-glass-cleanup/docs/design/home-directions/index.html
- Or open `index.html` locally in a browser.

## Warm Glass

- Header: week on the left, group name in the middle, the avatar on the right. The avatar opens the profile and settings panel (a draft; it could become a full Settings page).
- Dock: Home / Chat / Archive are always shown, plus a separate shutter. The shutter's ring shows your 5 moments for the week.
- The dock, the shutter and the prompt card use the newer iOS glass look (clearer glass, a bright rim and a highlight).
- Copy is kept short: a placeholder _Group name_, no extra lines.

## Tabs

- **Home**: the phone you can tap. **Play** resets it and plays a whole cycle: ① a friend joins (a spark of warm light drifts into the count), ② you press the shutter (the count rolls up), ③ at 8 PM everyone opens it at once (the film is released).
- **App icon**: pair Warm Glass (or the scratchpad skin) with an icon and see it on the home screen, the launch screen, in sizes, in a notification and as colours. `#mix=c6+G` links to a pairing.
- **States**: every Home state side by side, each with when it shows and what the dock does. The buttons play a friend joining, the shutter and the reveal on the Collecting phone. `#states` opens it.
- **Dock icons**: try six icon sets in the dock. `#dock=ios` links to a set.

## Home states

| State             | Dock                                                                              |
| ----------------- | --------------------------------------------------------------------------------- |
| Collecting        | Three tabs and the shutter                                                        |
| No capsule yet    | Tabs only                                                                         |
| Failed to load    | Tabs only; Try again is on the page                                               |
| No access         | No dock: chat and archive belong to the group too                                 |
| Allowance used up | The shutter is grey with a full ring; tapping it shakes it and shows a short note |
| Film developing   | Tabs only                                                                         |
| Taking longer     | Tabs only                                                                         |
| Film released     | Tabs only; _Watch together_ is on the page and Archive gets a dot                 |

## Sidebar

- Drag **group size** (2–10) and **shuffle** contributions; switch friends who haven't added a moment yet between an empty spot (default) and their names.
- Simulate the **shutter state**, **chat unread** and the **Home state**.
- Switch the page between **EN** (default) and **中文**; `?lang=zh` opens it in Chinese. The phone stays in English.
- **Zoom** sets the phone size on every tab.

## Data scope (proposal A)

Home shows who is in (yes or no) but never how many moments each other person added. Your own count comes from your contribution ledger and the group total from the cycle summary, as on `dev` today; who is in needs a new, small API.

## Files

| File                                                     | Purpose                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| `index.html`                                             | Page shell, sidebar and tabs                                  |
| `app.js`                                                 | Synthetic data, the Warm Glass Home, dock, shutter and motion |
| `states.js`, `styles-states.css`                         | Home states and the States tab                                |
| `mix.js`, `styles-mix.css`, `icons.js`                   | App icon tab and the icon candidates as SVG                   |
| `dockicons.js`, `styles-dock.css`                        | Dock icons tab                                                |
| `i18n.js`                                                | English and Chinese text for the page                         |
| `styles.css`, `styles-r2.css`, `styles-r3.css`           | Page and phone shell, Warm Glass                              |
| `styles-glass.css`                                       | iOS glass for the dock, shutter, prompt card and buttons      |
| `styles-nav.css`, `styles-nav2.css`                      | Dock, shutter states and badges                               |
| `styles-story.css`, `styles-fx.css`, `styles-motion.css` | Play, reveal, a friend joining and the shutter feedback       |
| `styles-side.css`                                        | Sidebar, tap hints, version tag, toast                        |
| `shots/`                                                 | Earlier screenshots of Warm Glass and the shutter states      |

## References

[Capsl](https://www.capsl.app/) · [Capsule](https://getcapsuleapp.com/) · [Reveal](https://joinreveal.app/) · [Retro](https://retro.app/ethos) · [POV](https://pov.camera/disposable-camera) · [Lapse](https://lapse.com/) · [Locket](https://techcrunch.com/2022/01/11/locket-an-app-for-sharing-photos-to-friends-homescreens-hits-the-top-of-the-app-store/)
