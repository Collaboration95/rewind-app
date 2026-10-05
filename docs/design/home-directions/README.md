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
- When the 4 weeks end, the film **premieres for 24 hours** and everyone watches it when they like. The next cycle starts straight away. The film then stays in Archive.
- The group has **one owner**, who picks the prompt and the group time zone and shares **six-letter invite codes (ABC-DEF)** that work once and expire in 24 hours. There are no invite links. The owner sets a member limit of 2–10 when creating the group. Anyone can switch group. The reminder is fixed at **Sunday 7 PM in the group's time zone**; members can snooze it for 7 days or turn it off.
- The welcome page has _Sign in_, _Create an account_ and a separate _Try Demo_; Demo controls live in Settings, apart from the real account. Sign-up and sign-in are a **username and password** only (password 12+ characters). There is no email, phone, verification code or password reset; an administrator resets passwords.
- Home shows the countdown, the prompt, **your own** allowance and this week's moments; it does not show the group total or who is in.
- **Chat** is one chat per group: text, replies and a ✨ reaction, up to 2,000 characters. No attachments, read receipts, typing indicators, edits or deletes; the proposal leaves those out.
- **Archive** shows the current cycle's step, then every released film, streamed right in its card; nothing to download there. Saving the film or your own moments stays at the end of the film. A cycle that never got a film keeps only its prompt and dates.
- Home, Chat and Archive all belong to the group you are in. Each group has its own cycle, your moments, prompt, chat and archive; a new group starts week 1 the day it is created. A new account with no group lands on a Home that offers joining with a code or creating a group.

The looks are the ones `dev` has: Disposable Flash, Compact Digital (picked first), 8mm Home Movie and VHS Camcorder, picked after recording.

## Warm Glass

- Header: the group name in the middle and the avatar on the right. The group name opens a menu to switch group, join with a code or create one; the avatar opens Settings. Home, Chat and Archive share this header.
- Home: days until the film, the week of the cycle, and the prompt card with your allowance and this week's moments; tapping the allowance opens _Your moments_.
- Dock: Home / Chat / Archive are always shown, plus a separate shutter on every tab. The shutter's ring shows your 5 moments for the week. Opening Chat clears its unread count; opening Archive clears the new-film dot.
- Chat: messages from the bottom up, others on the left with their colour, yours in peach on the right. Tap a message to add ✨ or reply. Coming in with unread messages draws a _3 new messages_ line. Reconnecting and offline show as a small pill under the header; a message that didn't send says _Not sent · Retry_.
- Archive: the current cycle on top (collecting, developing, taking longer, or the premiere with Play), then _Earlier films_. Tapping one plays it in the card with progress, time, pause and full screen; one film plays at a time. _Show older films_ loads more.
- After sealing, the camera waits on _Sealed_ with _Done_.
- The dock, the shutter and the cards use the newer iOS glass look. Text meets WCAG AA contrast on the warm light.

## Tabs

- **Final**: the build spec. A state diagram of every screen group, the rules for moving between screens, an App Store (iOS) checklist, a build-status key, then one row per flow with every screen as a live phone. Each screen has a code (A1 Launch, H1 Home, V3 Viewfinder…), a build status against `dev` (Built, Planned with its issue, Partly built, Design only, App Store need), what leads to it, every action and the code it goes to, how it behaves at the edges, and its App Store notes. Tapping a diagram node or an action jumps to that screen. `#final` opens it.
  - **Archived screens** sit folded at the bottom: screens for features that aren't built or planned, with the reason, keeping their codes so they can come back (remove the code from `ARCHIVED` in `final.js`). Archived now: invite link (A4), reset password (B4), email or phone sign-up with a code (C1–C5), start a capsule (H8, H9), rename group (S2), reminder time (S8, S9), leave group (S18), Tell the group (T7) and From the archive moments (F2).
- **Home**: the phone you can tap. The dock switches between Home, Chat and Archive; the group name switches group; the avatar opens Settings, the shutter opens the camera, your allowance opens _Your moments_ and, during the premiere, _Watch_ opens the film. **Play** resets it: ① you add a moment, ② the 4 weeks end and the film premieres.
- **States**: every Home state side by side, with when it shows and what the dock does. The buttons add a moment and end the cycle on the Collecting phone. `#states` opens it.
- **Screens**: the flows around the Home, each step side by side and every phone live. Each flow folds away; they start folded and the page remembers which ones you opened. `#screens` opens it.
  - Welcome, sign in and sign up: sign in with a username and password (in the prototype the password is `rewind`), with wrong password, offline and expired session; create an account with a username, password and confirmation, then sign in to Home with no group yet; _Try Demo_ pulls up synthetic members.
  - Settings: the account, the group (owner: prompt, time zone, invite code; members see them read-only; a full group can't invite), members, switch group, join with a six-letter code (with an unknown, expired or used code, or a full group; `BOO-KCL` works in the prototype), create a group with a member limit, the Sunday reminder with snooze, help and privacy links, sign out, delete account, and Demo controls in a Demo session.
  - Your moments: metadata only and always the same as Home; delete one and retake it, once a week. A moment that didn't finish can be retried or deleted without using the weekly delete.
  - Record a video: camera and mic access, the viewfinder with moments and seconds left, recording, trim and look, upload with cancel, sealed.
  - Take a photo: the photo mode and a quick look before sealing; it counts 3 seconds.
  - Switch group: the menu under the group name (another group's unread count shows there), what someone removed from a group sees, and Home with no group yet.
  - The film: plays straight away during the 24-hour premiere, then the cast, a main button that opens Chat, and Replay, Save film and Save your own moments.
  - Chat: new messages, tap a message, reply, no messages yet, reconnecting, offline, not sent, couldn't load, and after the premiere.
  - Archive: collecting, the premiere, developing, a film playing in its card, the first cycle and couldn't load.
- **App icon**: the chosen icon, Campfire, on the launch screen opening into Home, the home screen, in sizes and in a notification, with the App Store export rules. `#mix` opens it.

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
| `i18n.js`                                                | Page text                                                             |
| `styles.css`, `styles-r2.css`, `styles-r3.css`           | Page and phone shell, Warm Glass                                      |
| `styles-glass.css`                                       | iOS glass for the dock, shutter, cards and buttons                    |
| `styles-nav.css`, `styles-nav2.css`                      | Dock, shutter states and badges                                       |
| `styles-story.css`, `styles-fx.css`, `styles-motion.css` | Play and the shutter feedback                                         |
| `styles-side.css`                                        | Sidebar, tap hints, version tag, toast                                |
| `shots/`                                                 | Earlier screenshots of Warm Glass and the shutter states              |

## References

[Capsl](https://www.capsl.app/) · [Capsule](https://getcapsuleapp.com/) · [Reveal](https://joinreveal.app/) · [Retro](https://retro.app/ethos) · [POV](https://pov.camera/disposable-camera) · [Lapse](https://lapse.com/) · [Locket](https://techcrunch.com/2022/01/11/locket-an-app-for-sharing-photos-to-friends-homescreens-hits-the-top-of-the-app-store/)
