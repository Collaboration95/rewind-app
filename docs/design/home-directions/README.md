# Home · Warm Glass

Presentation-only prototype of the Rewind **Home** screen and the screens around it, from the #189 concept review.
Nothing here changes app code, runtime contracts or data. All members, counts and textures are synthetic;
sealed moments are never shown as media.

The page only shows the design and how it behaves. Feedback goes in the team chat, not on the page.

## Open it

- Hosted from this branch: https://htmlpreview.github.io/?https://github.com/Collaboration95/rewind-app/blob/ui-concept/bibi45c-warm-glass-cleanup/docs/design/home-directions/index.html
- Or open `index.html` locally in a browser.

## Follows the product docs on `dev`

The prototype follows the newest plan, `doc/planning/sprints/sprint-2-user-journey-plan.md` (27 September 2026), and otherwise `doc/planning/proposals/proposal-rewind.md`, `doc/planning/ideation/rewind-product-discovery-handoff.md` and `UX-CONTRACT.md`:

- A cycle lasts **4 weeks**, counted from the group's start. The allowance resets every 7 days: **5 moments, 30 seconds in all, 15 seconds each**. Once a week you can delete one moment and retake it.
- The camera takes **video or a photo**. A video is up to 15 seconds and can be trimmed, with a look picked before sealing; **a photo counts as one moment and 3 seconds** of the film. After sealing, nobody sees it before the film, not even you; you only see when and how long.
- When the 4 weeks end, the film **premieres for 24 hours** and everyone watches it when they like. The next cycle starts straight away. Short films may use older moments, labelled _From the archive_. The film then stays in Archive.
- The group has **one owner**, who renames the group, picks the prompt and sends invites that expire. A group has up to 10 people. Anyone can switch group. The Sunday reminder time can be changed, snoozed or turned off.
- Accounts are made by the Rewind admin: **username and password**, no sign-up. The welcome page has _Sign in_ and a separate _Try Demo_; Demo controls live in Settings, apart from the real account.
- Home shows the countdown, the prompt, **your own** allowance and this week's moments; it does not show the group total or who is in.

The retro modes are not designed yet: the prototype keeps the looks `dev` has today (Original, Soft focus, High contrast), picked after recording as in the Sprint 2 plan.

## Warm Glass

- Header: the group name in the middle and the avatar on the right; the avatar opens Settings.
- Home: days until the film, the week of the cycle, and the prompt card with your allowance and this week's moments; tapping the allowance opens _Your moments_.
- Dock: Home / Chat / Archive are always shown, plus a separate shutter. The shutter's ring shows your 5 moments for the week.
- The dock, the shutter and the cards use the newer iOS glass look. Text meets WCAG AA contrast on the warm light.

## Tabs

- **Home**: the phone you can tap. The avatar opens Settings, the shutter opens the camera, your allowance opens _Your moments_ and, during the premiere, _Watch_ opens the film. **Play** resets it: ① you add a moment, ② the 4 weeks end and the film premieres.
- **App icon**: pair Warm Glass (or the scratchpad skin) with an icon and see it on the home screen, the launch screen, in sizes, in a notification and as colours. The default icon is the two dots from the local build. `#mix=c6+r%3Adots` links to a pairing.
- **States**: every Home state side by side, with when it shows and what the dock does. The buttons add a moment and end the cycle on the Collecting phone. `#states` opens it.
- **Screens**: the flows around the Home, each step side by side and every phone live. `#screens` opens it.
  - Welcome and sign in: username and password (in the prototype the password is `rewind`), with wrong password, offline and expired session; _Try Demo_ pulls up synthetic members.
  - Settings: the account, the group (owner: group name, prompt, invite; members see the prompt only; a full group can't invite), switch group, join with a code, create a group, the Sunday reminder with time and snooze, sign out, and Demo controls in a Demo session.
  - Your moments: metadata only; delete one and retake it, once a week.
  - Record a video: camera and mic access, the viewfinder with moments and seconds left, recording, trim and look, upload with cancel, sealed.
  - Take a photo: the photo mode and a quick look before sealing; it counts 3 seconds.
  - The film: plays straight away during the 24-hour premiere, labels _From the archive_ moments, then the cast with Replay, Save film and Save your own moments.
- **Dock icons**: try six icon sets in the dock. `#dock=ios` links to a set.

## Home states

| State               | Dock                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| Collecting          | Three tabs and the shutter                                            |
| 5 moments used      | The shutter is grey with a full ring; tapping it says when it resets  |
| 30 seconds used     | The same, with a note about the seconds                               |
| A moment failed     | As usual; a card offers Retry                                         |
| Film developing     | As usual: the next cycle is open; a card shows the film is developing |
| Taking longer       | As usual; the card says it is taking longer                           |
| Premiere (24 hours) | As usual; a card with _Watch_, and Archive gets a dot                 |
| No capsule · owner  | Tabs only; the owner can start one                                    |
| No capsule · member | Tabs only; waiting for the owner                                      |
| Failed to load      | Tabs only; Try again is on the page                                   |
| No access           | No dock: chat and archive belong to the group too                     |

## Sidebar

- Drag **group size** (2–10; at 10 the owner can't invite) and **shuffle** contributions.
- Simulate the **shutter state**, **chat unread** and the **Home state**.
- Switch the page between **EN** (default) and **中文**; `?lang=zh` opens it in Chinese. The phone stays in English.
- **Zoom** sets the phone size on every tab.

## Files

| File                                                     | Purpose                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `index.html`                                             | Page shell, sidebar and tabs                                          |
| `app.js`                                                 | Synthetic data, the Warm Glass Home, dock, shutter and motion         |
| `states.js`, `styles-states.css`                         | Home states and the States tab                                        |
| `screens.js`, `styles-screens.css`                       | Sign in, Settings, Your moments, the camera and the film; Screens tab |
| `mix.js`, `styles-mix.css`, `icons.js`                   | App icon tab and the icon candidates as SVG                           |
| `dockicons.js`, `styles-dock.css`                        | Dock icons tab                                                        |
| `i18n.js`                                                | English and Chinese text for the page                                 |
| `styles.css`, `styles-r2.css`, `styles-r3.css`           | Page and phone shell, Warm Glass                                      |
| `styles-glass.css`                                       | iOS glass for the dock, shutter, cards and buttons                    |
| `styles-nav.css`, `styles-nav2.css`                      | Dock, shutter states and badges                                       |
| `styles-story.css`, `styles-fx.css`, `styles-motion.css` | Play and the shutter feedback                                         |
| `styles-side.css`                                        | Sidebar, tap hints, version tag, toast                                |
| `shots/`                                                 | Earlier screenshots of Warm Glass and the shutter states              |

## References

[Capsl](https://www.capsl.app/) · [Capsule](https://getcapsuleapp.com/) · [Reveal](https://joinreveal.app/) · [Retro](https://retro.app/ethos) · [POV](https://pov.camera/disposable-camera) · [Lapse](https://lapse.com/) · [Locket](https://techcrunch.com/2022/01/11/locket-an-app-for-sharing-photos-to-friends-homescreens-hits-the-top-of-the-app-store/)
