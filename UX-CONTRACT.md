# Rewind UX contract

This contract records the shared behavior for real-account sign-in, group
creation, and settings flows. Visual tokens are defined in
[`src/theme.ts`](./src/theme.ts); this document records product behavior and
interaction.

## Product boundary

The app uses real accounts: a username and password registered with the Rewind
server. Sign-in requires HTTPS, except plain HTTP on localhost for local
development. There are no external identity providers in this increment.

## Canonical routes and actors

- A signed-in account session identifies the acting member. A missing,
  malformed, expired, or revoked session is not authorised.
- Home, group creation, and Settings derive the acting member from the
  account provider (`src/auth/RealAccountProvider.tsx`). Runtime requests carry
  the session; the server revalidates it on every request.
- Settings is the canonical owner for current account/group state, sign-out,
  account deletion, and the entry points to group creation and invites.

## Operations and feedback

| Operation      | Trigger                                 | Pending                                     | Success                         | Failure/recovery                                               |
| -------------- | --------------------------------------- | ------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| Sign in        | Username and password                   | Form disabled; status text                  | Home                            | Form remains with an actionable error                          |
| Sign out       | `Sign out` then app-owned confirmation  | Button status text                          | Signed-out entry                | Stay in Settings with retryable error                          |
| Create group   | `Create a group`                        | Stable busy label; duplicate submit blocked | Home with the owner group/cycle | Inline field errors or form-level retry; entered values remain |
| Delete account | `Delete account` with password re-check | Confirmation stays pending until confirmed  | Signed-out entry                | Confirmation stays open with retry/error                       |
| Cancel         | `Cancel` / `Stay signed in`             | None                                        | Return to originating context   | Draft remains intact                                           |

## Group form

- Group name is required and must be at most 80 characters after trimming.
- Prompt is required and must be at most 160 characters after trimming.
- Built-in prompts and one short custom prompt use the same committed prompt
  contract.
- Validation happens before persistence. Invalid values result in no group,
  cycle, or owner membership write. Server creation is one SQLite transaction.
- The owner is the signed-in account that created the group. Other members
  join through owner-generated invites.

## Still capture

- Camera and microphone capability and permission states are checked before a
  capture control is enabled. Denied or blocked access remains actionable with
  retry and Settings guidance.
- Native capture uses `ExpoCameraPlatform`. The preview supports retake,
  discard, and acceptance.
- Accepted durable records contain dimensions, format, capture time, byte
  length, and source only. Native file URIs remain in the active session and
  app-owned cache; they are not persisted as metadata or uploaded.

## Group chat

- Chat is available only when the signed-in account is a member of the
  selected group. The server authorizes the session before opening the
  persisted event stream or accepting a message; denied reads do not return
  message text.
- The timeline replays the append-only persisted text event log in event order
  and merges newly delivered events without duplicates. Each message shows its
  author and created timestamp.
- The composer accepts trimmed text up to the server's 2,000-character limit.
  A successful send clears the draft; a recoverable failure preserves it and
  explains how to retry. One-level replies and one supported reaction are
  available. Attachments, edits/deletes, read receipts, and direct messages
  remain out of scope.
- Loading, empty, connection-error, unavailable-runtime, and membership-denied
  states are explicit in the chat surface. A connection error offers a
  labelled retry action and does not replace persisted messages already shown.

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

`src/domain/groups.ts` owns framework-independent group types and validation.
`src/auth/` owns the account session and its lifecycle.
`src/runtime/local-runtime-client.ts` owns the typed HTTP adapter. The server
revalidates sessions and owns atomic SQLite group/cycle writes. Visual tokens
are defined in `src/theme.ts`. The typed chat transport is owned by
`src/chat/realtime-client.ts` and exposed to the product through
`src/runtime/local-runtime-client.ts`.
