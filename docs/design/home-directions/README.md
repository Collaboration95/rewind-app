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
- Use **Quote reply** on a direction's comment for specific feedback.

The page reads the reaction counts from the public GitHub API when it loads (60 unauthenticated requests per hour per network).

## What to try on the page

- Drag **group size** (2–10) and use **shuffle contributions**. No direction assumes a fixed number of moments.
- Switch **waiting members** between _not named_ (default) and _named_.
- Tap the avatar for the merged profile and settings sheet, tap the dock tabs, and press the shutter.
- Compare the **dock variants**: A icons with the active label, B labels always, C shrinks while scrolling (tap the small pill to expand).
- Switch the **shutter state**: collecting, allowance used up, sealing, just sealed, and premiere (the shutter becomes _watch together_, with the time left on its ring).
- Toggle **chat unread** to see the badges; the Archive tab shows a dot during the premiere.

## Shared decisions across all directions

- Navigation: one glass dock for every direction, tinted by its theme. Home / Chat / Archive plus a separate shutter; its ring shows the member's weekly allowance (5 moments, 30 seconds). Settings moves into the avatar. Every tab has an accessible name, including unread counts.
- Information architecture: prompt → action → status.
- From the product scan: waiting members are not named (Reveal), each member has a colour (Reveal), sealed copy says _not even you can peek_ (Capsule, Reveal), and the reveal is framed as everyone opening at once (Capsl, Reveal).

## Files

| File                                           | Purpose                                          |
| ---------------------------------------------- | ------------------------------------------------ |
| `index.html`                                   | Review page shell and review table               |
| `styles.css`, `styles-r2.css`, `styles-r3.css` | Directions 01–05, 06–08 and 09–11                |
| `styles-nav.css`                               | Shared dock, variants, shutter states, badges    |
| `app.js`                                       | Synthetic data, direction markup, vote reading   |
| `review-config.js`                             | Review issue number                              |
| `shots/`                                       | Screenshots for the issue: phones, dock, shutter |

## References

[Capsl](https://www.capsl.app/) · [Capsule](https://getcapsuleapp.com/) · [Reveal](https://joinreveal.app/) · [Retro](https://retro.app/ethos) · [POV](https://pov.camera/disposable-camera) · [Lapse](https://lapse.com/) · [Locket](https://techcrunch.com/2022/01/11/locket-an-app-for-sharing-photos-to-friends-homescreens-hits-the-top-of-the-app-store/)
