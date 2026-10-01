# Home visual directions — round 3 review

Presentation-only prototypes of the Rewind **Home** screen, prepared for the #189 concept review.
Nothing here changes app code, runtime contracts or data. All members, counts and textures are synthetic;
sealed moments are drawn as abstract textures, never as media.

## Please leave pros and cons

Write them right on the page, under each phone and each dock. We will combine everyone's notes and pick one direction together.

## Archived after the first review

01 Darkroom Editorial, 02 Contact Sheet, 03 Glass Capsule, 04 Premiere Ticket, 05 Quiet Swiss, 08 Sealed Letter and 11 Shared Reel are archived. The page folds them at the bottom (open them with _Show the 7 archived directions_ or the _Archived_ heading), greys them out, and keeps the votes and notes they already had behind _Show review_, read-only. Review progress counts only the four directions still in review and the four docks. If your ❤️ is on an archived direction, sending asks whether to move it first.

## Home states

_Simulate → Home_ in the sidebar switches every phone between the states the Home has on `dev`: collecting, loading, no capsule yet, failed to load, no access, allowance used up, film developing, taking longer and film released. Each state keeps the direction's own header and colours and opens with a small drawing in its metaphor (Warm Glass's glow, Hearth's fire and seats, Firefly Jar's fireflies, Movie Night's countdown leader and reel) that changes with the state. The shutter follows: disabled while loading, on errors and while the film develops, _used up_ for the allowance, and _watch together_ once the film is out. _Try again_ shows loading and then recovers; _Play_ returns to collecting. The copy is a draft.

The third tab at the top, _States_ (or `index.html#states`), shows them on their own: _By state_ puts the four directions side by side in one state, with a note on when it shows and what the shutter does; _By direction_ shows all nine states of one direction. It does not change the state chosen in the sidebar, which still applies to the other tabs. Links keep the choice, for example `#states=developing` or `#states=c7`.

## App icon · mix and match

The second tab at the top of the page (or `index.html#mix`) pairs a Home direction with an app icon and shows them where people will meet them: the launch screen opening into that Home, a home screen among common apps (white or black wallpaper), the sizes from 120 px down to 29 px, a notification, and the two palettes side by side with a note when one is light and the other dark. There is no voting on this tab yet.

- Icons are numbered. Letters (1–15) spell Re in the scratchpad hand; symbols (16–20) draw one idea without letters: two dots, a rewind doodle, a circle of friends, a sealed envelope and an hourglass. 11, 12 and 16 grow out of the two-dot icon tried locally. Each direction's own icon and the current icon are there for reference.
- _Icon background_ (white, cream, black or the Home's own colour) applies to the white scratchpad icons; black switches the ink to light.
- _Dot follows the Home accent_ recolours only the accent in the icon.
- _Scratchpad skin_ is a sixth Home option: the same Home drawn with wobbly black outlines on white.
- The launch animation is a placeholder fade; ideas for later are noted under the phone.
- The pairing is kept in the link, for example `#mix=c6+G+t` (Warm Glass, icon 7, dot tinted). `+bg-cream` (or `black`, `home`) keeps the background. The link uses each icon's internal letter so older links keep working.

## Open it

- Hosted from this branch: https://htmlpreview.github.io/?https://github.com/Collaboration95/rewind-app/blob/ui-concept/bibi45c-home-directions/docs/design/home-directions/index.html
- Backup host (shows a one-click notice first): https://raw.githack.com/Collaboration95/rewind-app/ui-concept/bibi45c-home-directions/docs/design/home-directions/index.html
- Or open `index.html` locally in a browser.
- Jump to one direction with its anchor, for example `index.html#c7`.

## Review on the page, then send it to the issue

Everything happens on the page; nobody has to write in the issue by hand.

1. Under each phone: 👍 **Shortlist** (as many as you like), ❤️ **Top pick** (one), and a pros and a cons box; press Enter to add a note. Under _Dock · pick up to two_, 👍 one or two docks and write their pros and cons. If you haven't picked a dock, sending first reminds you.
2. Everything is saved in your own browser (`localStorage`) until you send it. The bar at the bottom shows how many of the 15 you have reviewed.
3. When you have reviewed them all, press **Copy, then comment in the issue**. The page copies one formatted comment and opens the review issue (number set in `review-config.js`); paste it into the comment box and click Comment.
4. Changed your mind? Edit on the page and send again. For each person, only their latest comment counts.

The page never signs in and stores no token. It reads the review issue through the public GitHub API when it loads (60 unauthenticated requests per hour per network), splits each person's comment by direction and shows everyone's votes, pros and cons under each phone. A comment written by hand that starts with a direction number (for example `07:` or `Dock D:`) is listed under that direction as another comment. Comment text is escaped before it is shown. Before the issue exists, tick _Preview with sample data_ to see the layout.

The comment format is plain Markdown: a hidden first line holds the votes (`<!-- rewind-review v1 … -->`), then one `#### 07 · Hearth` section per direction with **Pros** and **Cons** lists.

## What to try on the page

- Drag **group size** (2–10) and use **shuffle contributions**. No direction assumes a fixed number of moments.
- Switch **waiting members** between _not named_ (default) and _named_.
- Tap the avatar for the profile and settings panel (a draft; it could become a full Settings page), tap the dock tabs, and press the shutter. The orange rings on the phones mark what you can tap; turn them off under _Things you can tap_.
- Compare the **docks**: A keeps three tabs and a separate shutter; D centre shutter (Home · shutter · Archive, Chat at the top right); E shutter only (Archive and Chat at the top right, like Locket or BeReal); G live pill (shows “2d 14h · 3 left”; tap it for the tabs).
- The four directions still in review sit in one row; the zoom fits four phones per row on a landscape screen.
- Switch the page between **EN** (default) and **中文** at the top of the sidebar; open it with `?lang=zh` for Chinese. The phones stay in English; in Chinese each direction also shows its English name.
- Switch the **shutter state**: collecting, allowance used up, sealing, just sealed, and premiere (the shutter becomes _watch together_, with the time left on its ring).
- Toggle **chat unread** to see the badges; the Archive tab shows a dot during the premiere.
- **Play** (next to each phone) resets that phone and plays the whole cycle: ① a friend joins, ② you press the shutter, ③ at 8 PM everyone opens it at once. The first two are deliberately different. A friend joining comes from outside the screen and uses the direction's own metaphor, never a photo, because you cannot see what they captured: a safelight sweeps the film, an enlarger flashes, their seat is stamped, their stamp slaps down, a firefly in their colour circles into the jar and turns gold, their name types into the credits. Your own moment starts at the shutter and turns into that metaphor: the photo flips to its own negative, melts into light, becomes an ember added to the fire, slips into the envelope, shrinks into a firefly in your colour, or is loaded into the projector. Each direction also has its own reveal.
- **Motion:** pressing the shutter on its own also seals a moment. The photos are generated on the page (out-of-focus lights, grain, a light leak); they contain no people and no member media.
- **Data scope (proposal A):** Home shows who is in (yes or no) but never how many moments each other person added. Your own count comes from your contribution ledger and the group total from the cycle summary, as on `dev` today; who is in needs a new, small API.

## Shared decisions across all directions

- Navigation: one glass dock for every direction, tinted by its theme. Home / Chat / Archive plus a separate shutter; its ring shows the member's weekly allowance (5 moments, 30 seconds). Settings moves into the avatar. Every tab has an accessible name, including unread counts.
- Information architecture: prompt → action → status.
- From the product scan: waiting members are not named (Reveal), each member has a colour (Reveal), sealed copy says _not even you can peek_ (Capsule, Reveal), and the reveal is framed as everyone opening at once (Capsl, Reveal).

## Files

| File                                           | Purpose                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `index.html`                                   | Review page shell and review table                                          |
| `styles.css`, `styles-r2.css`, `styles-r3.css` | Directions 01–05, 06–08 and 09–11                                           |
| `i18n.js`                                      | English and Chinese text for the review page                                |
| `styles-side.css`                              | Sidebar layout, the pros-and-cons banner and tap hints                      |
| `styles-fx.css`                                | Themed motion for a friend joining and for sealing your own moment          |
| `styles-nav2.css`                              | Language switch and dock variants D–G                                       |
| `styles-nav.css`                               | Shared dock, variants, shutter states, badges                               |
| `styles-story.css`                             | Play sequence, reveal motion, who-is-in visuals                             |
| `styles-motion.css`                            | Realistic film and ticket, entrance and seal motion                         |
| `app.js`                                       | Synthetic data and direction markup                                         |
| `review.js`                                    | On-page review: local draft, copy to the issue, reading everyone's comments |
| `styles-review.css`                            | Review blocks under each phone, dock section, send bar                      |
| `icons.js`                                     | App icon candidates as SVG (family, per-direction icons, references)        |
| `mix.js`, `styles-mix.css`                     | App icon mix-and-match tab                                                  |
| `review-config.js`                             | Review issue number                                                         |
| `shots/`                                       | Screenshots for the issue: phones, dock, shutter                            |

## References

[Capsl](https://www.capsl.app/) · [Capsule](https://getcapsuleapp.com/) · [Reveal](https://joinreveal.app/) · [Retro](https://retro.app/ethos) · [POV](https://pov.camera/disposable-camera) · [Lapse](https://lapse.com/) · [Locket](https://techcrunch.com/2022/01/11/locket-an-app-for-sharing-photos-to-friends-homescreens-hits-the-top-of-the-app-store/)
