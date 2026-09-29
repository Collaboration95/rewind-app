# Home visual directions — round 3 review

Presentation-only prototypes of the Rewind **Home** screen, prepared for the #189 concept review.
Nothing here changes app code, runtime contracts or data. All members, counts and textures are synthetic;
sealed moments are drawn as abstract textures, never as media.

## Open it

- Hosted from this branch: https://htmlpreview.github.io/?https://github.com/Collaboration95/rewind-app/blob/ui-concept/bibi45c-home-directions/docs/design/home-directions/index.html
- Backup host (shows a one-click notice first): https://raw.githack.com/Collaboration95/rewind-app/ui-concept/bibi45c-home-directions/docs/design/home-directions/index.html
- Or open `index.html` locally in a browser.
- Jump to one direction with its anchor, for example `index.html#c7`.

## Vote and comment

Voting happens in the review issue (number set in `review-config.js`). Each direction has its own comment there.

- 👍 up to **three** directions you would take forward.
- ❤️ **one** favourite.
- Use **Quote reply** on a direction's comment for specific feedback, or start your comment with the direction number (for example `07:` or `Dock A:`).

The page reads the review issue through the public GitHub API when it loads (60 unauthenticated requests per hour per network). Each direction shows its 👍 and ❤️ counts, how many comments refer to it, the two latest comments, and a link to vote or comment on GitHub. Comment text is escaped before it is shown. Before the issue exists, tick _preview vote bar_ to see the layout with sample numbers.

## What to try on the page

- Drag **group size** (2–10) and use **shuffle contributions**. No direction assumes a fixed number of moments.
- Switch **waiting members** between _not named_ (default) and _named_.
- Tap the avatar for the merged profile and settings sheet, tap the dock tabs, and press the shutter.
- Compare the **dock variants**. A–C keep three tabs and a separate shutter: A icons with the active label, B labels always, C shrinks while scrolling. D–G change the structure: D centre shutter (Home · shutter · Archive, Chat at the top right), E shutter only (Archive and Chat at the top right, like Locket or BeReal), F timeline (past films W33–W35 on the left, this cycle on the right), G live pill (shows “2d 14h · 3 left”; tap it for the tabs).
- Switch the page between **EN** (default) and **中文** at the top of the sidebar; open it with `?lang=zh` for Chinese. The phones stay in English.
- Switch the **shutter state**: collecting, allowance used up, sealing, just sealed, and premiere (the shutter becomes _watch together_, with the time left on its ring).
- Toggle **chat unread** to see the badges; the Archive tab shows a dot during the premiere.
- **Play** (next to each phone) resets that phone and plays the whole cycle: ① a friend joins, and a light in their colour drifts into the main visual; ② you press the shutter, and a photo flies in and flips to its sealed back; ③ at 8 PM everyone opens it at once. Each direction has its own reveal: the film develops, the ticket stub tears off, the wax seal cracks, the jar lid comes off, a 3-2-1 leader counts down, a playhead sweeps the reel.
- **Motion:** pressing the shutter on its own also seals a moment. Use _replay entrance_ to see the Darkroom film slide in and the Premiere ticket drift down. The photos are generated on the page (out-of-focus lights, grain, a light leak); they contain no people and no member media.
- **Data scope (proposal A):** Home shows who is in (yes or no) but never how many moments each other person added. Your own count comes from your contribution ledger and the group total from the cycle summary, as on `dev` today; who is in needs a new, small API.

## Shared decisions across all directions

- Navigation: one glass dock for every direction, tinted by its theme. Home / Chat / Archive plus a separate shutter; its ring shows the member's weekly allowance (5 moments, 30 seconds). Settings moves into the avatar. Every tab has an accessible name, including unread counts.
- Information architecture: prompt → action → status.
- From the product scan: waiting members are not named (Reveal), each member has a colour (Reveal), sealed copy says _not even you can peek_ (Capsule, Reveal), and the reveal is framed as everyone opening at once (Capsl, Reveal).

## Files

| File                                           | Purpose                                             |
| ---------------------------------------------- | --------------------------------------------------- |
| `index.html`                                   | Review page shell and review table                  |
| `styles.css`, `styles-r2.css`, `styles-r3.css` | Directions 01–05, 06–08 and 09–11                   |
| `i18n.js`                                      | English and Chinese text for the review page        |
| `styles-nav2.css`                              | Language switch and dock variants D–G               |
| `styles-nav.css`                               | Shared dock, variants, shutter states, badges       |
| `styles-story.css`                             | Play sequence, reveal motion, who-is-in visuals     |
| `styles-motion.css`                            | Realistic film and ticket, entrance and seal motion |
| `app.js`                                       | Synthetic data, direction markup, vote reading      |
| `review-config.js`                             | Review issue number                                 |
| `shots/`                                       | Screenshots for the issue: phones, dock, shutter    |

## References

[Capsl](https://www.capsl.app/) · [Capsule](https://getcapsuleapp.com/) · [Reveal](https://joinreveal.app/) · [Retro](https://retro.app/ethos) · [POV](https://pov.camera/disposable-camera) · [Lapse](https://lapse.com/) · [Locket](https://techcrunch.com/2022/01/11/locket-an-app-for-sharing-photos-to-friends-homescreens-hits-the-top-of-the-app-store/)
