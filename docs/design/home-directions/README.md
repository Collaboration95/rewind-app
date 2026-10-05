# Home · Warm Glass

Presentation-only prototype of the Rewind **Home** screen and the screens around it, from the #189 concept review.
Nothing here changes app code, runtime contracts or data. All members, counts and textures are synthetic;
sealed moments are never shown as media.

The page only shows the design and how it behaves. Feedback goes in the team chat, not on the page.

## Open it

- Hosted from this branch: https://htmlpreview.github.io/?https://github.com/Collaboration95/rewind-app/blob/ui-concept/final-screens/docs/design/home-directions/index.html#final
- Or open `index.html` locally in a browser.

## Follows the product docs on `dev`

The prototype follows the newest plan, `doc/planning/sprints/sprint-2-user-journey-plan.md` (27 September 2026), and otherwise `doc/planning/proposals/proposal-rewind.md`, `doc/planning/ideation/rewind-product-discovery-handoff.md` and `UX-CONTRACT.md`. Chat and Archive follow `src/chat/ChatScreen.tsx` and `src/archive/ArchiveScreen.tsx` on `dev`:

- A cycle lasts **4 weeks**, counted from the group's start. The allowance resets every 7 days: **5 moments, 30 seconds in all, 15 seconds each**. Once a week you can delete one moment and retake it.
- The camera takes **video or a photo**. A video is up to 15 seconds and can be trimmed, with a look picked before sealing; **a photo counts as one moment and 3 seconds** of the film. After sealing, nobody sees it before the film, not even you; you only see when and how long.
- When the 4 weeks end, the film **premieres for 24 hours** and everyone watches it when they like. The next cycle starts straight away. Short films may use older moments, labelled _From the archive_. The film then stays in Archive.
- The group has **one owner**, who renames the group, picks the prompt and sends invites that expire. A group has up to 10 people. Anyone can switch group. The Sunday reminder time can be one of four presets or a custom time, snoozed or turned off.
- The welcome page has _Sign in_, _Create an account_ and a separate _Try Demo_; Demo controls live in Settings, apart from the real account. **This differs from the Sprint 2 plan**, where the Rewind admin makes every account and there is no sign-up: the prototype adds sign-up with an **email or phone number and a 6-digit code**, then a name and password. Sign in takes an email, phone number or username.
- Home shows the countdown, the prompt, **your own** allowance and this week's moments; it does not show the group total or who is in.
- **Chat** is one chat per group: text, replies and a ✨ reaction, up to 2,000 characters. No attachments, read receipts, typing indicators, edits or deletes; the proposal leaves those out.
- **Archive** shows the current cycle's step, then every released film, streamed right in its card; nothing to download there. Saving the film or your own moments stays at the end of the film. A cycle that never got a film keeps only its prompt and dates.
- Home, Chat and Archive all belong to the group you are in. Each group has its own cycle, your moments, prompt, chat and archive; a new group starts week 1 the day it is created. A new account with no group lands on a Home that offers joining with a code or creating a group.

The retro modes are not designed yet: the prototype keeps the looks `dev` has today (Original, Soft focus, High contrast), picked after recording as in the Sprint 2 plan.

## Warm Glass

- Header: the group name in the middle and the avatar on the right. The group name opens a menu to switch group, join with a code or create one; the avatar opens Settings. Home, Chat and Archive share this header.
- Home: days until the film, the week of the cycle, and the prompt card with your allowance and this week's moments; tapping the allowance opens _Your moments_.
- Dock: Home / Chat / Archive are always shown, plus a separate shutter on every tab. The shutter's ring shows your 5 moments for the week. Opening Chat clears its unread count; opening Archive clears the new-film dot.
- Chat: messages from the bottom up, others on the left with their colour, yours in peach on the right. Tap a message to add ✨ or reply. Coming in with unread messages draws a _3 new messages_ line. Reconnecting and offline show as a small pill under the header; a message that didn't send says _Not sent · Retry_.
- Archive: the current cycle on top (collecting, developing, taking longer, or the premiere with Play), then _Earlier films_. Tapping one plays it in the card with progress, time, pause and full screen; one film plays at a time. _Show older films_ loads more.
- After sealing, the camera waits on _Sealed_ with _Tell the group_ and _Done_. _Tell the group_ opens Chat with an editable draft, so you can say what you just caught; only the words go to Chat, the moment stays sealed.
- The dock, the shutter and the cards use the newer iOS glass look. Text meets WCAG AA contrast on the warm light.

## Tabs

- **Final**: the build spec. A state diagram of every screen group, the rules for moving between screens (push, full screen, tabs, menu, dialog, feedback, launch, Reduce Motion), then one row per flow with every screen as a live phone. Each screen has a code (A1 Launch, H1 Home, V3 Viewfinder…), what leads to it, every action and the code it goes to, and how it behaves at the edges. Tapping a diagram node or an action jumps to that screen. `#final` opens it. An **App Store (iOS) checklist** lists what Apple's review checks (guidelines 1.2, 2.1, 4.2, 4.8, 5.1.1, 5.1.2, age rating, export compliance, icon) with the screens that handle each, and every affected screen has its own blue App Store section. App Store screens: members with report, block and remove (S15–S17), leave group (S18), delete account (S19–S20), report a message (T11) and a moment (F4), Terms and Privacy at sign-up (C5), Help, Privacy Policy and Terms in Settings; the camera and notification pre-prompts say Continue with no skip. Screens only designed here: the launch screen (A1), the invite link (A4), reset password (B4), camera off (V2), upload failed (V7), allow notifications (S10), add to Home Screen on iPhone (S11), sign-out confirmation (S12) and the lock-screen notifications (N1).
- **Home**: the phone you can tap. The dock switches between Home, Chat and Archive; the group name switches group; the avatar opens Settings, the shutter opens the camera, your allowance opens _Your moments_ and, during the premiere, _Watch_ opens the film. **Play** resets it: ① you add a moment, ② the 4 weeks end and the film premieres.
- **States**: every Home state side by side, with when it shows and what the dock does. The buttons add a moment and end the cycle on the Collecting phone. `#states` opens it.
- **Screens**: the flows around the Home, each step side by side and every phone live. Each flow folds away; they start folded and the page remembers which ones you opened. `#screens` opens it.
  - Welcome, sign in and sign up: sign in with a password (in the prototype it is `rewind`), with wrong password, offline and expired session; sign up with an email or phone number, a 6-digit code (`123456` in the prototype), a name and password, then Home with no group yet; _Try Demo_ pulls up synthetic members.
  - Settings: the account, the group (owner: group name, prompt, invite; members see the prompt only; a full group can't invite), switch group, join with a code (with an unknown, expired or used code, or a full group; `BOOK CLUB` works in the prototype), create a group, the Sunday reminder with a preset or custom time and snooze, sign out, and Demo controls in a Demo session.
  - Your moments: metadata only and always the same as Home; delete one and retake it, once a week. A moment that didn't finish can be retried or deleted without using the weekly delete.
  - Record a video: camera and mic access, the viewfinder with moments and seconds left, recording, trim and look, upload with cancel, sealed with _Tell the group_.
  - Take a photo: the photo mode and a quick look before sealing; it counts 3 seconds.
  - Switch group: the menu under the group name (another group's unread count shows there), what someone removed from a group sees, and Home with no group yet.
  - The film: plays straight away during the 24-hour premiere, labels _From the archive_ moments, then the cast, a main button that opens Chat, and Replay, Save film and Save your own moments.
  - Chat: new messages, tap a message, reply, no messages yet, reconnecting, offline, not sent, couldn't load, and after the premiere.
  - Archive: collecting, the premiere, developing, a film playing in its card, the first cycle and couldn't load.
- **App icon**: the chosen icon, Campfire, on the launch screen opening into Home, the home screen, in sizes and in a notification, with the App Store export rules. `#mix` opens it.
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
| No access           | No dock: chat and archive belong to the group too; pick another group |
| No group yet        | No dock; join with a code or create a group                           |

## Sidebar

- Drag **group size** (2–10) and **shuffle** contributions. Home only shows your own moments, so the size shows in Settings (no invites at 10), the film's cast and Archive.
- Every Home state is on the **States** tab, so the sidebar doesn't switch states.
- **Zoom** sets the phone size on every tab.

## Files

| File                                                     | Purpose                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `index.html`                                             | Page shell, sidebar and tabs                                          |
| `app.js`                                                 | Synthetic data, the Warm Glass Home, dock, shutter and motion         |
| `states.js`, `styles-states.css`                         | Home states and the States tab                                        |
| `screens.js`, `styles-screens.css`                       | Sign in, Settings, Your moments, the camera and the film; Screens tab |
| `tabs.js`, `styles-tabs.css`                             | Chat, Archive and the group menu                                      |
| `mix.js`, `styles-mix.css`, `icons.js`                   | App icon tab, page tabs, and the Campfire icon as SVG                 |
| `final.js`, `styles-final.css`                           | Final tab: diagram, transition rules and every screen with its notes  |
| `dockicons.js`, `styles-dock.css`                        | Dock icons tab                                                        |
| `i18n.js`                                                | Page text                                                             |
| `styles.css`, `styles-r2.css`, `styles-r3.css`           | Page and phone shell, Warm Glass                                      |
| `styles-glass.css`                                       | iOS glass for the dock, shutter, cards and buttons                    |
| `styles-nav.css`, `styles-nav2.css`                      | Dock, shutter states and badges                                       |
| `styles-story.css`, `styles-fx.css`, `styles-motion.css` | Play and the shutter feedback                                         |
| `styles-side.css`                                        | Sidebar, tap hints, version tag, toast                                |
| `shots/`                                                 | Earlier screenshots of Warm Glass and the shutter states              |

## References

[Capsl](https://www.capsl.app/) · [Capsule](https://getcapsuleapp.com/) · [Reveal](https://joinreveal.app/) · [Retro](https://retro.app/ethos) · [POV](https://pov.camera/disposable-camera) · [Lapse](https://lapse.com/) · [Locket](https://techcrunch.com/2022/01/11/locket-an-app-for-sharing-photos-to-friends-homescreens-hits-the-top-of-the-app-store/)
