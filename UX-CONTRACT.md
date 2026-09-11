# Rewind UX contract

This contract records the shared behavior for the local-first Demo access,
group creation, and settings flows. Visual intent and runtime tokens remain in
[`DESIGN.md`](./DESIGN.md).

## Product boundary

The app uses synthetic local Demo access. It is not authentication, an account,
or a secure identity boundary. There are no passwords, credentials, external
providers, or remote deletion actions in this increment.

## Canonical routes and actors

- A persisted Demo session identifies one synthetic member and one local group.
- A missing, malformed, expired, or invalidated session is not authorised.
- The first offline launch uses the deterministic Amber fixture for continuity;
  the user can end it from Settings and return to the Demo access entry.
- Home, group creation, and Settings derive the acting member from the session
  provider. Runtime requests include the session ID; the server revalidates it.
- Settings is the canonical owner for current actor/group state, sign-out, reset,
  and the entry point to group creation.

## Operations and feedback

| Operation    | Trigger                                             | Pending                                                          | Success                                    | Failure/recovery                                               |
| ------------ | --------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Enter Demo   | `Enter Demo as …`                                   | Choices disabled; status text                                    | Home                                       | Entry remains with an actionable error                         |
| End Demo     | `Sign out of Demo`                                  | Button status text                                               | Clean Demo entry                           | Stay in Settings with retryable error                          |
| Create group | `Create local group`                                | Stable busy label; duplicate submit blocked                      | Home with the owner group/cycle            | Inline field errors or form-level retry; entered values remain |
| Reset        | `Reset local Demo data` then app-owned confirmation | Confirmation action stays pending until storage/runtime confirms | Deterministic fixture and clean Demo entry | Confirmation stays open with retry/error when reset fails      |
| Cancel       | `Cancel` / `Keep local data`                        | None                                                             | Return to originating context              | Draft remains intact                                           |

## Group form

- Group name is required and must be at most 80 characters after trimming.
- Prompt is required and must be at most 160 characters after trimming.
- Built-in prompts and one short custom prompt use the same committed prompt
  contract. No date picker or timezone input is exposed; a new cycle starts at
  the commit instant and ends exactly 24 hours later.
- Validation happens before persistence. Invalid values result in no group,
  cycle, or owner membership write. Server creation is one SQLite transaction.
- The owner is the acting synthetic member. Invites, transfer, removal,
  discovery, and cloud synchronization are out of scope.

## Reset and local data scope

Reset explicitly names its scope: the saved Demo session, locally created
groups, saved local selection, accepted still-image metadata, and app-owned
cached still files. It restores the deterministic five-member fixture. It
never changes source-controlled files, migrations, or remote/user data. Reset
is confirmed with an app-owned modal; browser/native confirmation dialogs are
not used.

## Still capture

- Camera and microphone capability and permission states are checked before a
  capture control is enabled. Denied or blocked access remains actionable with
  retry and Settings guidance.
- Native capture uses `ExpoCameraPlatform`; simulator evidence uses the
  explicitly labelled `DemoCameraPlatform` fixture and never claims a physical
  image. The preview supports retake, discard, and local acceptance.
- Accepted durable records contain dimensions, format, capture time, byte
  length, and source only. Native file URIs remain in the active session and
  app-owned cache; they are not persisted as metadata or uploaded.

## Accessibility and responsive behavior

- Every action is a native button/pressable with a visible label and accessible
  name. Disabled and busy states are exposed in text and accessibility state.
- Validation is inline and adjacent to the owning field; forms preserve the
  draft after recoverable errors. Textareas do not expose freeform resizing.
- Confirmation dialogs name the scope and consequence, offer a benign cancel
  action, support Escape/back dismissal where the platform provides it, and
  remain usable within a phone safe area.
- Content scrolls naturally inside the established safe-area shell. Long names,
  prompts, and error messages wrap rather than truncate critical information.

## Runtime ownership

`src/domain/session.ts` and `src/domain/groups.ts` own framework-independent
types and validation. `src/session/` owns local persistence and lifecycle.
`src/runtime/local-runtime-client.ts` owns the typed HTTP adapter. The server
revalidates sessions and owns atomic SQLite group/cycle writes. `DESIGN.md` and
`src/theme.ts` remain the paired visual token sources.
