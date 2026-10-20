# Current system architecture

Source baseline: `dev` commit `40ebeb5673d103b4b6950d095192aae744980769`,
inspected 15 October 2026. This is a code/configuration map, not a live deployment
or device acceptance result. Historical measurements in ADRs retain their own
context. Release deployment, database cutover and managed-login acceptance are
tracked separately in #230, #504 and #515.

## Components and package boundaries

Rewind is an Expo/React Native application and a Node application monolith.
The web export is the browser and iPhone Home Screen PWA product. Compiled native
iOS is out of scope; retained native adapters support local/dev development.
Photo and video capture both remain. The synthetic Demo was removed on
6 October; `demo-frozen-20261004` is a historical tag, not a selectable mode.
Hosted-dev resources retain their historical `demo` names.

| Boundary                      | Responsibility                                                                                                 | Source                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App shell and features        | Account/profile onboarding, groups/invitations, capture, chat, premiere, Archive and settings                  | [App.tsx](../../App.tsx), [src/real](../../src/real), [src/capture](../../src/capture)                                                                               |
| Client contracts and adapters | Framework-free domain types; runtime HTTP and platform capture/persistence adapters                            | [src/domain](../../src/domain), [src/runtime](../../src/runtime), [src/auth/real-account-client.ts](../../src/auth/real-account-client.ts)                           |
| HTTP application              | `node:http` dispatch, bounded intake, transport/origin checks, sessions and resource policy                    | [http.ts](../../server/src/http.ts), [policy.ts](../../server/src/policy.ts)                                                                                         |
| Domain/application services   | Accounts, membership, invitations, contributions, cycle transitions, chat and archive                          | [server/src](../../server/src), [cycles/engine.ts](../../server/src/cycles/engine.ts)                                                                                |
| Persistence                   | Synchronous SQL surface over local SQLite or PostgreSQL; schema readiness and environment binding              | [db.ts](../../server/src/db.ts), [postgres](../../server/src/postgres), [migrations](../../server/migrations)                                                        |
| Media and background work     | Durable clip/film claims, ffmpeg child processes, media integrity/storage, cycle scheduler and reminder outbox | [jobs](../../server/src/jobs), [media](../../server/src/media), [cycles/scheduler.ts](../../server/src/cycles/scheduler.ts), [reminders](../../server/src/reminders) |
| Web/container delivery        | Static web export and same-origin `/api` proxy, runtime container and persistent mounts                        | [nginx.conf](../../deploy/nginx.conf), [compose.yaml](../../deploy/compose.yaml)                                                                                     |

Dependencies are declared in the root [package.json](../../package.json) and
lockfile, rather than separate deployable feature packages. Server integrations
include `pg`, AWS S3 and Cognito SDKs, `aws-jwt-verify` and `web-push`.
[architecture:check](../../scripts/check-architecture.mjs) enforces relative-only
imports in `src/domain` and the pure cycle engine, and excludes device packages
from route modules. This is an import guard, not proof of all runtime boundaries.

## Runtime and deployment boundaries

```text
Browser / installed PWA ---- sign-in redirect ---- Cognito pool per environment
         |
         | HTTPS; application cookie
         v
CloudFront (viewer HTTPS, injected origin proof)
         |
         | HTTP origin hop
         v
Lightsail host / Docker Compose
  nginx: static web + /api/* -> runtime (strips /api)
         |
  Node: HTTP + process-local SSE hub + cycle/media loop + optional reminder loop
         |                     |                       |
         | SQL                 | ffmpeg child process  | web-push provider
         v                     v                       v
  PostgreSQL (hosted)      temporary media files     browser service worker
  SQLite (local)
         |
  Private S3 object references (hosted); disk paths (local)

Browser -------- short-lived signed incoming PUT --------> S3
Node <---------- verified reads / processed writes ------> S3
```

PostgreSQL and S3 are outside the application VM. The diagram combines the
supported local and hosted paths; it does not assert that release is running.
The declared hosted configuration has separate dev/release hosts, origins,
media buckets, identities and Cognito pools. Dev database cutover is enabled;
release database provisioning/cutover remains disabled in the baseline
[database.tf](../../infra/terraform/media/database.tf). Read the current
[database ADR](ADR-0003-postgresql.md) and operations guidance for cutover and
recovery; an old SQLite snapshot cannot account for later PostgreSQL writes.

[cli.ts](../../server/src/cli.ts) `start` opens the HTTP application and a
separate database connection for the cycle scheduler. The scheduler advances
real groups and calls the media worker tick; configured reminder providers
start an outbox loop. `worker` is an optional standalone CLI mode, not a
separate service in the default Compose file. Durable SQL leases and generation
checks fence stale clip/film completions. ffmpeg runs as a child process.
The PostgreSQL bridge also uses a worker thread for `pg` I/O while the caller
blocks; that thread is distinct from the media job worker.

The SSE hub, media capability map, Cognito replay set and identity caches are
process-local. Durable database claims do not make multiple API replicas share
these maps. No horizontally scaled API or automatic host failover is claimed.

## Trust, sessions and media access

The edge enforces viewer HTTPS and injects `X-Rewind-Origin-Auth`. nginx sets
`X-Forwarded-Proto: https` and forwards the origin proof. The runtime accepts
proxy HTTPS only when that protocol and the configured secret both match;
a forwarded header alone is insufficient. The origin hop is HTTP, so this
boundary depends on protecting the origin proof. Direct socket TLS is also
accepted. The local exception requires explicit
`REWIND_ALLOW_INSECURE_LOCAL_AUTH`, a loopback peer and host, and no forwarded
protocol header. Browser origin checks are separate from transport checks.

Cognito Managed Login uses authorization code + PKCE, a state/nonce transaction
and server-side code exchange. Rewind validates the ID token and maps
`cognito_sub` to an account, then issues its own opaque session. Cognito tokens
are not application API credentials. Web/PWA stores the application credential
in a Secure, HttpOnly, SameSite=Lax `__Host-rewind_session` cookie; the database
stores its SHA-256 hash. Developer password sign-in remains for local/dev;
release refuses it. See the [session contract](../domain/session-contract.md)
and existing [Cognito decisions](../../doc/planning/sprints/sprint-3-cognito/design-decisions.md).

A group ID selects a resource; persisted membership, selection and resource
policy decide access. Media read capabilities are a separate two-minute,
process-local opaque URL grant bound to the issuing session and exact output.
They can be used without presenting a cookie (for media clients), but resolution
rechecks the stored session, accepted/selected membership, published cycle and
verified output; a different presented session is rejected. They are neither
raw S3 URLs nor general API sessions. See
[archive/capabilities.ts](../../server/src/archive/capabilities.ts) and
[archive/store-serving.ts](../../server/src/archive/store-serving.ts).

## Storage adapters and capabilities

`REWIND_MEDIA_BACKEND=disk` keeps the existing staged/processed filesystem path;
it is represented by **no configured object store**, not a third implementation
of `MediaStore`. The immutable object-store interface has `put/head/read/delete`
operations and two implementations: legacy `local` and `s3`. Keep `local`
unchanged; product runs use disk locally and S3 hosted. Object references bind
backend/store, environment/group, key/prefix, version, digest, size, type and
incoming expiry. Callers supply an already authorized scope.

S3 adds an upload transport: a short-lived presigned PUT binds the approved
incoming object and headers. Finalization verifies object identity, version,
checksum, size and encryption before processing trusts it. A signed PUT is an
upload capability, not read access or permission to publish a contribution.
Disk intake sends bytes through Node. Direct S3 intake avoids that upload hop,
but Node still materializes and verifies S3 media for ffmpeg and authorized
playback/download, and writes processed clips/films back. Media bytes therefore
can pass through the runtime in both configurations.

The configured [media Terraform root](../../infra/terraform/media/main.tf) uses
SSE-S3 (`AES256`), versioning and public-access blocking. The S3 adapter supports
SSE-KMS when a canonical key ARN is supplied, but the active root does not use
it. See [runtime-store.ts](../../server/src/media/runtime-store.ts)
and [s3-store.ts](../../server/src/media/s3-store.ts).

## Environment configuration matrix

Values below describe supported/default or declared configuration at the source
baseline. They contain no credentials and do not certify deployed settings.
`EXPO_PUBLIC_*` values are public build-time settings; server credentials and
origin proof stay server-side.

| Concern / selector                                                        | Local (`make run` / `make run-real`)                          | Hosted dev                                                | Release declaration / remaining work                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Client API: `EXPO_PUBLIC_LOCAL_BASE_URL`                                  | Runner supplies same-origin `/api` on `http://localhost:8090` | Same-origin `/api` baked into web export                  | Same-origin `/api` after qualified deployment                                               |
| SQL: `REWIND_DATABASE_URL`, `_ENVIRONMENT`, `_TLS`                        | URL unset: SQLite under `REWIND_DATA_DIR`                     | PostgreSQL 17; dev enabled/cutover true                   | Baseline enabled/cutover false; #504 owns completion                                        |
| Database transport/binding                                                | Remote URL requires verified TLS; `disable` is loopback-only  | `verify` default, bundled RDS CA; persisted `dev` binding | Own `release` binding and recovery need verification                                        |
| Sign-in: `REWIND_AUTH_PASSWORD`                                           | Default true; Developer sign-in                               | True plus managed web login                               | Explicit false; release environment rejects true                                            |
| `REWIND_COGNITO_REGION`, `_USER_POOL_ID`, `_CLIENT_ID`, `_DOMAIN`         | All four together, optional for password-only runs            | Declared dev pool/client                                  | Declared separate release pool/client; #515 owns operational acceptance                     |
| Media: `REWIND_MEDIA_BACKEND`, `_ENVIRONMENT`                             | `disk`; filesystem under data directory                       | `s3`, `dev` namespace                                     | `s3`, `release` namespace; deployment/isolation #230                                        |
| S3: `REWIND_MEDIA_S3_BUCKET`, `_OWNER`, `_REGION`                         | Unset for disk                                                | Explicit bucket/expected owner/region                     | Separate environment bucket/settings                                                        |
| Encryption: `REWIND_MEDIA_S3_KMS_KEY_ARN`                                 | Not needed                                                    | Root uses SSE-S3; Compose does not pass a KMS selector    | Same shared media root; KMS support is an adapter option, not current Compose configuration |
| Transport: `REWIND_ORIGIN_AUTH_SECRET`, `REWIND_ALLOW_ORIGIN`             | Runner enables bounded loopback exception                     | Edge proof and exact browser origin                       | Own edge proof/origin; no dev credential reuse                                              |
| Reminders: `REWIND_REMINDER_VAPID_SUBJECT`, `_PUBLIC_KEY`, `_PRIVATE_KEY` | No remote sending without configured provider                 | Web push; complete VAPID settings required                | Own VAPID settings; delivery must be checked                                                |
| Native push: `REWIND_REMINDER_EXPO_ENABLED`                               | Leave disabled                                                | Disabled; not passed by Compose                           | Disabled; compiled iOS out of scope                                                         |
| Cycles: `REWIND_REAL_CYCLE_MINUTES`                                       | Runner uses 10-minute cycles                                  | Server default 28 days unless explicitly configured       | Same default; do not infer hosted clock from local runner                                   |

Authoritative parsers and wiring: [server config](../../server/src/config.ts),
[client config](../../src/runtime/config.ts), [local runner](../../scripts/run-real-local.mjs),
[Compose](../../deploy/compose.yaml), [release root](../../infra/terraform/release/main.tf).
A missing client API URL produces unavailable sign-in; it does not select a Demo.

## Decision index

- [ADR-0001](ADR-0001-local-first-sprint-0.md): historical Sprint 0 ports/adapters
  boundary. Its offline fixture fallback and deferred identity scope are history.
- [ADR-0002](ADR-0002-camera-capture-boundary.md): platform capture boundary.
- [ADR-0003](ADR-0003-postgresql.md): hosted PostgreSQL and synchronous bridge,
  writer serialization, schema parity and environment binding; local SQLite stays.
- [Cognito decisions](../../doc/planning/sprints/sprint-3-cognito/design-decisions.md):
  managed web/PWA login, opaque app sessions, one pool per environment and no
  release passwords. Its original delivery omissions are not current acceptance results.
- [AGENTS.md](../../AGENTS.md): current product scope and delivery rules, including
  removed Demo, web-only push, disk/S3 split, iOS PWA and historical dev names.

The [layered guide](../learn/index.html) and [technical guide](../learn/technical.html)
provide browser-readable diagrams of these same boundaries. Deployment procedures
remain in [deploy/README.md](../../deploy/README.md); database operations remain in
[postgresql-operations.md](postgresql-operations.md).
