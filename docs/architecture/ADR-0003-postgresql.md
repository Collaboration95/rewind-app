# ADR-0003: PostgreSQL as the hosted relational store

Status: accepted, 7 October 2026. Issues: #261 (migration), #172 (backups and
recovery).

## Context

The project proposal (§6, General Architecture) names PostgreSQL for users,
groups, memberships, invitations, cycles, contribution metadata, prompts,
notification preferences, chat records and processing state. §5.3 requires
relational data to be "backed up using the selected managed database backup
mechanism", and managed data services to use provider encryption at rest.

Until now the hosted server kept everything in one SQLite file on the
Lightsail host, backed up daily to S3. That recovers data, but it is neither
PostgreSQL nor a managed database backup, so the proposal was not met.

The server has about 300 synchronous persistence call sites
(`database.prepare(sql).run/get/all`, `database.exec`) written for
`node:sqlite`. Their correctness depends on SQLite's single-connection,
serialised-writer semantics (`BEGIN IMMEDIATE`, busy retries).

## Decision

1. **Hosted runs use managed PostgreSQL 17 on Lightsail.** It is encrypted at
   rest, takes automatic daily snapshots with 7-day point-in-time restore and
   needs TLS. Dev is publicly reachable so the team can browse data with a
   SQL client (owner decision, 7 Oct 2026: convenience over isolation); no
   standby (#503). Terraform:
   `infra/terraform/media/database.tf`. Local runs and the default test suite
   keep SQLite; setting `REWIND_DATABASE_URL` selects PostgreSQL.
2. **Keep the synchronous persistence code; add a PostgreSQL connection with
   the same surface** (`server/src/postgres`). A worker thread owns one `pg`
   client. The calling thread posts each statement and blocks on a shared flag
   until the result arrives (`Atomics.wait`). One connection per
   `RewindDatabase`, as with SQLite.
3. **Preserve SQLite semantics explicitly.**
   - Every write transaction (and every autocommit write) takes one advisory
     lock, so writers are serialised across the server, worker and operator
     processes, as on SQLite. A writer waits `busy_timeout` (5 s, or
     `PRAGMA busy_timeout`) and then fails with "database is locked", which the
     existing busy-retry loops already handle.
   - Each statement inside a transaction runs in a savepoint: a failed
     statement does not abort the transaction, as on SQLite.
   - `SAVEPOINT` outside a transaction opens one, and `RELEASE` commits it.
   - Errors keep node:sqlite's shape (`code`, `errcode` 2067/787/275/1299,
     "UNIQUE constraint failed: table.column").
   - Results keep its shape: null-prototype rows, numbers for `BIGINT` and
     `NUMERIC`, 0/1 for booleans, `Uint8Array` for bytes.
4. **Translate the small, inventoried set of SQLite idioms at the boundary**
   (`translate.ts`):
   - `?` placeholders, with numbers bound as typed parameters;
   - camelCase result aliases;
   - SQLite's NULL ordering;
   - `INSERT OR IGNORE`, scalar `MAX/MIN`, `IFNULL`, `IS ?`, `LIMIT -1`,
     `CAST … AS INTEGER`, `LIKE` case-folding.

   Statements that cannot be translated faithfully (`GLOB`, `INSERT OR
REPLACE`, named parameters) fail at `prepare`, not silently.

5. **Schema:** `server/migrations/postgres/030-baseline.sql` equals the SQLite
   schema after migrations 1–30, with one exception: columns that SQLite fills
   with fractional seconds are `DOUBLE PRECISION`.
   - All text columns use `COLLATE "C"`, matching SQLite's byte order.
   - All foreign keys are `DEFERRABLE`.
   - A later SQLite migration needs a matching `NNN-*.sql` file here; startup
     refuses to run without it, and a test compares both schemas column by
     column.
6. **Data moves once, from an S3 backup.** `database-import` copies a SQLite
   snapshot in one transaction:
   - foreign keys are deferred, and every value's type is checked (a fraction
     never rounds into an integer column);
   - each table's row count and content hash are reconciled before commit;
   - anything inexact commits nothing.
7. **Environment isolation:** the first start records the environment (`dev`,
   `release`) in the database; a runtime configured for another environment
   refuses to start. Remote connections must verify TLS against the bundled
   Amazon RDS CA.

## Alternatives considered

- **Port all persistence code to async `pg`.** This is the conventional
  design, but it touches every call site and every caller up to the HTTP
  handlers, and it changes transaction interleaving. That is days of work and
  a large regression surface for no user-visible gain at this scale.
- **`pg-native` synchronous client.** A native addon needing libpq in the
  Alpine image and a compiler in CI. The worker-thread bridge is pure
  JavaScript.
- **Keep SQLite plus Litestream.** Good recovery, but it does not meet the
  proposal's PostgreSQL and managed-backup requirements.

## Consequences

- One event loop blocks for the duration of each statement, as it already did
  with SQLite. Measured locally: about 0.2 ms per read and 0.8 ms per locked
  write. Same-zone placement keeps hosted latency in the low milliseconds.
  Rewind's load (a handful of groups) is far below where this matters; if it
  ever does, hot paths can move to async `pg` one at a time.
- **Round trips, not async, decide latency.** Measured with
  `scripts/measure-database-calls.mjs` (Server-Timing per request). A chat
  message first cost 23 statements and 38 server round trips. Two changes
  cut that to 6:
  - each statement now travels with its lock or savepoint in one round trip;
  - signed-in identity (session, selected group, membership) is cached for
    5 minutes and cleared by the server's own changes.

  The other hot requests dropped too: archive 21 → 2, contributions 14 → 4,
  chat history 15 → 5, session restore 5 → 0. With so few round trips per
  request, an async rewrite of ~900 call sites would save little; it remains
  the next step if hosted request timing shows the event loop is the
  bottleneck.

- Writers are serialised, exactly as before. PostgreSQL row-level
  concurrency is not exploited; that is a deliberate parity choice.
- The server suite runs on both engines in CI (`Server tests on PostgreSQL`).
  Tests of SQLite internals (legacy migration repair, WAL files) are marked
  SQLite-only, and PostgreSQL has its own tests (`server/tests/postgres.test.mjs`).
- Operations (cutover, backups, recovery, failover, inspection) are in
  [postgresql-operations.md](postgresql-operations.md).
