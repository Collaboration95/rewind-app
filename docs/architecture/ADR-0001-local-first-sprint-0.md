# ADR-0001: Local-first Sprint 0 boundary

- Status: Accepted for Sprint 0
- Date: 2026-09-07
- Scope: issues #1–#4 and the later Sprint 0 walking skeleton

## Context

Sprint 0 must produce a runnable, reviewable increment without depending on
AWS credentials, user accounts, private media, or a deployed service. The
proposal still needs a future path to an Android app and installable PWA, so
the first boundary must be explicit and replaceable rather than coupling the
UI to a cloud provider.

## Decision

Use a local-first client boundary for Sprint 0:

```text
Expo/React Native client
        |
        v
framework-independent domain contracts
        |
        v
local fixtures/repository adapters (later Sprint 0 work)
```

The app shell and future feature screens consume domain-shaped data through
repository ports. The domain contracts do not import React Native, Expo,
SQLite, AWS, Cognito, or a network client. A later adapter may implement the
same ports with a local store or API without changing the product model.

The clean-start path is Expo web in a current Chromium-based browser. The same
client code remains capable of being run through Expo's Android tooling; native
device capture and permission evidence are Sprint 1 work.

## Boundary rules

Inside the Sprint 0 boundary:

- synthetic member profiles and one synthetic group;
- group membership checks before group-scoped data is returned;
- the current cycle, prompt, contribution quota, and locked state as typed
  domain concepts;
- deterministic fixtures and tests that contain no personal media or identity.

Outside the Sprint 0 boundary:

- OIDC, Cognito, passwords, accounts, and invitation acceptance;
- AWS, cloud databases, object storage, queues, workers, or notifications;
- recording, uploads, processing, reveal, playback, sharing, chat, and archive
  media;
- treating a local demo actor as an authenticated or private account.

## Consequences

The first increment is easy to start and test on a clean machine, and later
stories can validate domain rules without waiting for cloud infrastructure.
The trade-off is that Sprint 0 does not prove persistence, synchronisation,
native capture, or production privacy; those are explicit follow-up concerns.

## Alternatives considered

### Cloud-first Expo client

Rejected for Sprint 0 because it would make AWS/account setup a prerequisite
for the walking skeleton and would blur the boundary the issues are intended
to establish.

### UI-only mock state

Rejected as the architecture baseline because it cannot provide a stable,
framework-independent contract for the profile, group, and cycle stories.
