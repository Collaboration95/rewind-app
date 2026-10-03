# Design problem: keep live chat and durable reminders truthful

## Problem

Participation spans two different asynchronous contracts. Chat is an authorized live view over persisted message events: a client subscribes, disconnects and replays from an event ID. A reminder is a consent-scoped scheduled job: preference and device destination are checked, a durable outbox row is leased, a provider is called, and a receipt/outcome may be polled or retried. Treating both as one generic “notification observer” obscures persistence, authorization, cancellation and delivery evidence.

The pressure is present in code: chat events are persisted with messages and replayed over SSE; reminder preferences, destination generations and outbox states persist separately, while provider calls happen outside their transaction. This package documents that actual boundary; it does not claim a historical outage or delivery defect.

## Before — tempting pattern-only composition

The before figures compare three plausible but ungrounded options: an Observer hierarchy that treats chat frames and reminder sends alike; an Adapter class per provider without an explicit durable job/receipt boundary; or a Strategy hierarchy for the whole policy, preference, stream and retry lifecycle. They are analysis alternatives, not historical or current application classes.

![Before class diagram: pattern-only alternatives](diagrams/problem-before-class.svg)

![Before sequence diagram: pattern-only delivery](diagrams/problem-before-sequence.svg)

## Candidate patterns

| Candidate | Useful concept                                                                             | Mismatch if applied as a manufactured class hierarchy                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observer  | Chat subscribers receive ordered message events and can reconnect from a durable cursor.   | A live SSE observer is not a reminder job: it does not own a scheduled outbox row, consent checks, provider receipt or bounded retry. The actual hub subscription is transport behavior, not a general notification bus.                                      |
| Adapter   | Browser/native event sources and Expo/Web Push providers vary at transport/protocol edges. | Existing ports are functions/options (`RealtimeEventSourceFactory`, `PushPlatform`, `ReminderProviders`) and concrete modules. Adding named Adapter classes solely for a diagram would invent code.                                                           |
| Strategy  | Different provider send and receipt behavior can be selected by provider name.             | The implementation provides provider functions under a typed record and outbox orchestration. The core policy rechecks persisted account, group, session, destination generation and preference; that policy is not interchangeable with a provider strategy. |

## After — implemented function and persistence boundaries

The chosen documentation model follows the working interfaces already present: HTTP and authenticated client boundaries; `RealtimeChatClient` plus event-source factory and server realtime hub for chat; message/event/reaction tables for persisted chat state; reminder preference and destination functions; due scan and SQLite outbox lease/receipt state; provider function records for Expo and Web Push. Chat and reminder flows remain separate through their different lifetimes and evidence.

![After class diagram: actual transport and outbox](diagrams/problem-after-class.svg)

![After sequence diagram: persisted events versus durable reminder job](diagrams/problem-after-sequence.svg)

## Evidence-backed decisions

1. Chat message and event insertion share a transaction. The hub publishes only after commit. A retry with the same message ID is deduplicated when its payload matches.
2. Chat history is bounded and ordered; the stream replays persisted event IDs through a watermark while buffering live events. Access is rechecked during the stream and denial ends it.
3. Reminder preference is per real `(group, account)`. A destination is bound to the member’s real session and device; disabling increments a generation used to reject stale queue work.
4. The bounded `reminders --once` CLI pass invokes the due-scan function to write one outbox item per group/account/local Sunday. A transaction claims an eligible item; provider work occurs outside that transaction; a lease check fences stale completion.
5. The queue is unique/idempotent, while invoked provider sends are at-least-once if the process crashes after provider acceptance and before persisted receipt. “Accepted,” “receipt unavailable,” “failed,” and “cancelled” remain distinct from actual device display.
6. The notification payload is generic. Message bodies, owner prompts and other private group content are not included.

The package source exposes a one-shot `reminders --once` CLI pass; it explicitly does not start a recurring schedule. Provider setup, external recurring invocation and separate live delivery verification are required before claiming recurring delivery. Device permission, an actual provider receipt and observed delivery are separate acceptance evidence; this documentation package does not produce them. OIDC, PostgreSQL and client-side retro changes are future work and require a final source refresh.

## Source trace

The pinned implementation is linked in [models](models.md#source-trace-at-the-fixed-pin): `server/src/realtime`, `server/src/chat`, `server/src/reminders/outbox.ts`, `server/src/reminders/providers.ts`, `src/chat/realtime-client.ts`, and `src/reminders/private-reminder-client.ts`. The chat identity distinction follows [`docs/domain/session-contract.md`](../../../../../docs/domain/session-contract.md); durable local state inventory follows [`docs/architecture/hosted-demo-persistence.md`](../../../../../docs/architecture/hosted-demo-persistence.md).
