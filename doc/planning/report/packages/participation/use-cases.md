# Participation use cases and flow inventory

**Code baseline:** [accepted `dev` snapshot `1128b6a68985cf68215beb4a7a80fd00ec4242fa`](https://github.com/Collaboration95/rewind-app/commit/1128b6a68985cf68215beb4a7a80fd00ec4242fa). Requirements crosswalk: [README](README.md). Diagrams and source responsibilities: [models](models.md).

## UC09 — Owner prompt and group timezone

**Goal:** let the group owner choose the prompt for the collecting cycle and set the IANA timezone used by group-local scheduling. Only the current collecting cycle and future successor prompt inherit the change; closed-cycle and prior data are not rewritten.

**Actors and preconditions:** signed-in real-group owner; an accessible current group and cycle. The panel displays the group’s existing prompt and timezone. A real account member may view their reminder preference, but cannot change owner controls.

### UC09-F1 — Load owner controls

**Normal flow:** the group screen supplies the selected group and current cycle. Opening settings displays that cycle’s prompt and the group timezone (UTC when the value is absent in the view model); the member reminder panel requests the account’s own preference and next scheduled local time. The GET returns delivery status from current configuration and must not imply a send.

**Relevant exceptions:** missing/expired session or unavailable group prevents private data access; a member sees no owner mutation controls; a transport failure leaves the panel in a retry/error state rather than inventing defaults as saved values; switching group/account clears prior preference and unfinished edits.

### UC09-F2 — Save built-in or custom prompt and timezone

**Normal flow:** the owner chooses a built-in prompt or enters a custom prompt, supplies an IANA timezone and posts both. The server validates a nonempty prompt up to 160 characters and timezone, rechecks owner and collecting/unexpired cycle inside a write transaction, updates group timezone and current collecting-cycle prompt, commits, then returns refreshed group state. Successor creation copies the current prompt.

**Relevant exceptions:** invalid prompt/timezone is rejected; non-owner/inaccessible group is denied; a closed/elapsed cycle returns a conflict; a concurrent authorization loss or persistence error rolls back both changes. The UI reports no saved result on failure.

## UC10 — Reminder preference and asynchronous delivery

**Goal:** persist each real member’s preference, optionally associate a supported provider destination with that member’s current session/device, and process eligible Sunday 19:00 group-local reminders through a durable outbox. Preferences, queue status, provider acceptance/receipt and actual device display are distinct facts.

**Actors and preconditions:** signed-in real-account member of the selected current group; provider configuration is optional. Reminder content is generic and contains no private group prompt or chat content. A missing provider configuration does not prevent saving a preference. At this source pin, `server/src/cli.ts` provides one explicit bounded `reminders --once` scan/send pass and refuses to start a schedule; no recurring reminder scheduler is claimed.

### UC10-F1 — Read, enable, disable or snooze a preference

**Normal flow:** the panel loads the member’s stored `(group, account)` preference and computes the next Sunday 19:00 in the group IANA zone. The member enables/disables or sets/clears a snooze (maximum 31 days); the server validates current membership/session and upserts preference in a transaction. The response reports `not-configured` when delivery is unavailable.

**Relevant exceptions:** invalid boolean/date/window is rejected; unknown or nonmember group and expired session are denied; persistence failure leaves the previous preference; timezone resolution skips a nonexistent local wall time. A successful preference write is not a notification send.

### UC10-F2 — Register, inspect or disable a device destination

**Normal flow:** after platform permission/configuration allows it, the client identifies the device, provider (`expo` or `webpush`) and validated destination; server binds it to the account, selected group context and exact real-account session. Listing returns only safe destination metadata; disable increments its generation so an already queued job cannot use stale consent.

**Relevant exceptions:** unsupported platform or denied permission leaves registration off; unconfigured provider returns unavailable; malformed token/endpoint/key/device identity is rejected; another live account’s destination cannot be taken over; expired session, group switch or cleanup uncertainty is reported without claiming revocation succeeded. Destination secrets are not returned in list responses.

### UC10-F3 — Scan due preferences and enqueue one weekly job

**Normal flow:** the operator invokes the bounded `reminders --once` CLI pass; its `scanDueReminderJobs` call evaluates enabled preferences, current group membership/selection, preference age, opt-in/snooze and group timezone. For an eligible local Sunday occurrence with a live enabled destination/session, it inserts one outbox row keyed by `(group, account, local Sunday)`. Duplicate scans do not duplicate that key; scan returns a continuation cursor when bounded.

**Relevant exceptions:** opted-out, snoozed, stale or inactive group/account/destination does not enqueue; invalid scan bounds fail; timezone/DST resolution follows the bounded local-time resolver; a database error rolls back the scan transaction. No destination means no pending delivery claim.

### UC10-F4 — Send, check receipt, retry or terminate a queued job

**Normal flow:** the same one-shot CLI pass invokes `runReminderOutboxTick` with configured providers; it leases an eligible due row and rechecks current preference, membership, session, destination and generation. It sends a generic notification through the configured provider, persists a bounded provider outcome, optionally polls a provider receipt, retries transient outcomes with bounded backoff and exposes only per-account status. Queue creation is unique; provider sends are at-least-once across a crash before the receipt is persisted.

**Relevant exceptions:** invalid token disables that destination generation; permanent failure ends failed; transient send retries at most three attempts then fails; stale lease cannot overwrite newer state; consent/session/group change cancels; missing provider is `unconfigured`; receipt unavailable after bounded checks is recorded as receipt unavailable, not delivered. Provider acceptance/receipt does not prove OS display or human observation; live opted-in device/provider verification remains a separate gate.

## UC11 — Private group chat

**Goal:** authorized group members read persisted history and exchange text, one-level replies and a supported reaction, while retaining messages across transport interruption and replaying events after reconnect.

**Actors and preconditions:** a valid real-account or Demo chat identity that is a member of the requested group. Real-account chat uses account credentials; Demo chat uses a persisted Demo session and session-bound group. These credentials are not interchangeable. Message text is not placed in reminder payloads.

### UC11-F1 — Read bounded chat history

**Normal flow:** an authorized client requests the latest page (up to 100); the server captures a persisted event watermark, returns messages in event order with reply context and reaction counts, and provides a cursor for older history. The client merges older pages without duplicate event rows.

**Relevant exceptions:** missing/invalid session or outsider membership is denied without exposing history; malformed cursor/limit is rejected; an empty group returns an empty page; transport/storage error shows retry rather than an empty-success assertion.

### UC11-F2 — Send text or one-level reply

**Normal flow:** the client retains a stable draft/message ID for safe retry and posts trimmed text, optional same-group parent ID. A serialized transaction rechecks authorization, inserts message and append-only realtime event, and commits; only after commit does the hub publish. A duplicate matching retry returns the existing event without republishing.

**Relevant exceptions:** empty or over-2,000-character text, duplicate ID with different content, missing/other-group parent, nested reply, invalid session or membership is rejected; transaction failure rolls back both message and event. A lost response can safely retry the same draft ID.

### UC11-F3 — Add, remove or toggle a reaction

**Normal flow:** an authorized member requests the supported reaction on a message in the same group. The server rechecks membership/session in a write transaction, inserts idempotently or deletes the member’s reaction, recalculates count and returns the updated message.

**Relevant exceptions:** unsupported reaction, missing message, outsider, stale session or invalid timestamp produces a safe failure; no reaction is broadcast as a new message event by this path.

### UC11-F4 — Subscribe and reconnect from the persisted event cursor

**Normal flow:** after loading history at watermark `w`, the client opens the authorized SSE stream from `w`. The server subscribes to live events while draining persisted events through a fixed watermark, orders buffered concurrent events, suppresses IDs already replayed and emits later events once. On a transient disconnect, the client reconnects using its last event ID; heartbeat keeps an idle stream observable.

**Relevant exceptions:** session expiry, membership loss or group-context change terminates the stream and clears private rows; a transport disconnect shows reconnecting/disconnected and retries rather than asserting new data; unavailable SSE returns a transport error; duplicate/reordered frames are merged by event ID. Reconnect recovers persisted message events, not transient reaction changes.

## Deliberate exclusions

Message editing, deletion, attachments, read receipts, public discovery, provider payloads containing private content, device delivery/display acceptance, physical-device acceptance, and final two-member/outsider hosted acceptance are outside this package’s evidence. See [design rationale](design-problem.md) for the Observer/Adapter/Strategy comparison and actual design mapping.
