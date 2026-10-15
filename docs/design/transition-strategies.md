# Analysis-to-design transition strategies

Source: `40ebeb5673d103b4b6950d095192aae744980769`, remote `dev` verified
15 October 2026. These are mappings observed in existing code, not a proposal to
refactor the application or a record of undocumented historical decisions.
The five [domain models](README.md#model-catalogue) contain flow-specific diagrams,
design alternatives and implementation mappings.

## Responsibility allocation

| Analysis responsibility                     | Design transition                                                                                                 | Concrete code mapping                                                                                                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identify the person and establish a session | Separate browser boundary, identity-provider service and persisted account/session identity                       | [RealAccountProvider](../../src/auth/RealAccountProvider.tsx), [CognitoService / createCognitoService](../../server/src/auth/cognito.ts), [findOrCreateCognitoAccount / createRealSession / validateRealSession](../../server/src/auth/index.ts) |
| Decide which group a person can act in      | Map Account–Membership–Group relations to persistent identity checks; group selection is distinct from membership | [getRealGroup / getCurrentRealGroup](../../server/src/groups/real.ts), [invite functions](../../server/src/groups/invites.ts), [HTTP boundary](../../server/src/http.ts)                                                                         |
| Capture, review and seal a contribution     | Split device/UI boundary from domain validation and durable media intake                                          | [capture source](../../src/capture/VideoCaptureScreen.tsx), [upload-intents](../../server/src/media/upload-intents.ts), [contribution handler](../../server/src/contributions/index.ts)                                                          |
| Store and retrieve private bytes            | Extract an interface with immutable scoped values; adapt providers at runtime composition                         | [MediaStore / MediaScope / MediaObjectRef](../../server/src/media/store.ts), [createMediaRuntime](../../server/src/media/runtime-store.ts), [configureRuntimeMedia](../../server/src/media/configured-runtime.ts)                                |
| End a cycle and reveal a verified film      | Separate time calculation, persistent transition control and durable compilation                                  | [createCycleEngine / cyclePhase](../../server/src/cycles/engine.ts), [advanceCycleLifecycle / publishCycleRelease](../../server/src/cycles/lifecycle.ts), [claimCompilationJob / processCompilationJobForWorker](../../server/src/jobs/index.ts) |
| Send messages and update peers              | Split authenticated mutation from realtime projection and client synchronization                                  | [chat server](../../server/src/chat/index.ts), [realtime client](../../src/chat/realtime-client.ts), [chat client](../../src/chat/real-chat-client.ts)                                                                                           |
| Remind an eligible member                   | Persist scheduled intent and retry state separately from provider protocol                                        | [scanDueReminderJobs / runReminderOutboxTick / ReminderProvider](../../server/src/reminders/outbox.ts), [createWebPushReminderProvider](../../server/src/reminders/providers.ts), [SettingsScreen / ReminderBlock](../../src/real/Settings.tsx)  |
| View/download a released asset              | Replace public asset identity with bounded authority and revalidation at use                                      | [MediaCapabilities.issue / resolve](../../server/src/archive/capabilities.ts), [archive store serving](../../server/src/archive/store-serving.ts), [HTTP boundary](../../server/src/http.ts)                                                     |

The interface/record names above are source identifiers. They do not establish
that the repository uses a fully object-oriented domain layer. SQL and functional
services implement much of the analysis model. Each domain page resolves its
own UC IDs into the corresponding sequence participants and source functions.

## Applied strategies and invariants

### Boundary, control and entity separation

Analysis actors become UI/network boundaries; coordination becomes functions;
domain identity and history become persisted records. Authentication is shared
infrastructure but group authority stays a domain decision. Browser permission
and device capability cannot be inferred from a server-side session.
See [identity](identity.md), [capture](capture.md) and [interactions](interactions.md).

### Interface extraction and dependency injection

The `MediaStore` contract moves byte operations behind scoped
`put/head/read/delete` methods. `MediaObjectRef` records provider identity, exact
version, digest and size. `validateRef` checks scope and structure;
`verifiedBody` verifies digest and byte count at end of iteration.
Consumers must complete reads before treating integrity as established.
`configureRuntimeMedia` supplies the same selected store to HTTP/worker/lifecycle.

Configuration `disk` preserves filesystem intake and returns no opt-in media
store configuration in [parseMediaConfig](../../server/src/config.ts).
It is different from the retained `local` object-store adapter selected through
`createMediaRuntime`. Hosted S3 behaviour is a configured code path here;
no cloud call or deployment check was performed for these models.

The authentication `CognitoService` and reminder `ReminderProvider` similarly
allow protocol boundaries to be supplied separately from application decisions.
Provider factories alone are not proof of GoF Abstract Factory.
See [capture](capture.md), [identity](identity.md) and [interactions](interactions.md).

### Durable work and explicit state

Cycle events, compilation jobs and reminder outbox rows turn transient intent
into durable state. Database transactions establish a transition or claim;
expensive provider/FFmpeg work occurs outside the claiming transaction.
The owning claim/generation or lease must still be valid when results commit.
These are explicit state machines and durable work queues.

Compilation uses `claimCompilationJob` to reject live duplicate claims, reclaim
stale processing and bound intentional retries. Reminder dispatch uses
`runReminderOutboxTick` with a lease, eligibility checks and bounded attempts.
Neither establishes exactly-once external delivery: a process can fail after a
provider accepts and before the local outcome commits. Web-push acceptance is
not proof that a person received or read the message.
See [lifecycle](lifecycle.md) and [interactions](interactions.md).

### Capability-based access

`MediaCapabilities` issues an opaque, hashed token bound to a specific account,
session, group/member and verified output. At use, `resolve` rechecks current
selection, accepted membership, live session and published output in the database.
The two-minute TTL and bounded in-process grant map limit lifetime and capacity.
Restart loses these grants; clients must obtain a new authorized ticket.

This is an access-control design, not a GoF pattern claim. Object-store signatures
for uploading and application capabilities for playback have different authority
and revalidation rules. They must not be drawn as interchangeable credentials.
See [playback](playback.md) and [capture](capture.md).

## Pattern classification and alternatives

| Actual solution                                           | Candidate alternative                                   | Why the existing solution fits                                             | Classification and limit                                                          |
| --------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| MediaStore implementations wrap filesystem/S3 protocols   | Embed provider branches in every caller                 | Centralizes scoped references and integrity while callers use one contract | Adapter-style structural mapping; disk legacy path remains distinct               |
| ReminderProvider maps provider replies to ReminderReceipt | Let provider-specific replies drive scheduling directly | Keeps eligibility, leases and retry policy in the outbox                   | Provider adapter/dependency injection; retained Expo code is paused product scope |
| SQL reminder outbox and media job queue                   | In-memory callback or request-bound processing          | Records work and recovery state across process interruption                | Durable queue/outbox architecture; not a message broker or exactly-once guarantee |
| Guarded persistent cycle transitions                      | Let client countdown publish immediately                | Server timing and verified output gate reveal                              | Explicit state machine; no polymorphic GoF State classes                          |
| Expiring, revalidated media capability                    | Public URL or session token in player URL               | Narrows exposed authority and checks revocation/current membership         | Capability-based authorization; not GoF Proxy merely because access is mediated   |

The alternatives are illustrative reasoning baselines, not claims that these
were implemented, rejected in a recorded meeting or selected by a named member.
The domain pages provide before/after class and sequence views for their specific
problems.

## Sources and limits

The mappings above come from static inspection of the stated revision. Existing
test locations are linked per domain. Source and fixtures establish intended
contracts; hosted credentials, runtime configuration and physical-device results
need separate evidence. No member design ownership is inferred; use the
[attribution registry](README.md#coverage-and-attribution-registry) for confirmation.
