# Hosted persistence contract

> **PostgreSQL (#261).** Hosted relational data moves to managed PostgreSQL
> when an environment's `cutover` switch is set; see
> [ADR-0003](ADR-0003-postgresql.md) and the
> [operations runbook](postgresql-operations.md). Until then, and for local
> runs, the SQLite contract below applies unchanged.

Hosted dev runs the real-account app as one disposable Node container on the
Lightsail host `rewind-demo` (the name is historical), against persistent
SQLite and server-owned media. It is not a production data platform: it does
not claim high availability, so use non-sensitive test media only.

## Persistent boundary

The host keeps two non-root-writable bind mounts outside the application
checkout:

| Persisted area | Container target        | Contents                                          |
| -------------- | ----------------------- | ------------------------------------------------- |
| SQLite data    | `/var/lib/rewind`       | `rewind.sqlite` and its SQLite WAL/SHM companions |
| Media          | `/var/lib/rewind/media` | staged sources and processed clip/film outputs    |

The runtime process is UID/GID `10001:10001`. The Compose deployment and
operator guide define the matching host-side ownership and mount setup.
Replacing the container must not replace either mount.

## Schema and migration contract

`server/src/db.ts` is the authoritative additive migration runner. A healthy
Sprint 1 database has migration versions 1 through 15 and matching durable
`schema_migration_markers` receipts. `/health` returns HTTP 503 with
`ready: false` if any expected receipt is absent or a known partial schema
shape needs repair.

| Records                                                                    | Key relationships                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles`, `groups`, `memberships`                                        | Account profiles join groups through memberships; the persisted role gates owner actions.                                                                                                                                                      |
| `sessions`, `audit_events`                                                 | A bounded account session identifies an actor; audit rows are redacted operational events.                                                                                                                                                     |
| `invites`, `cycles`, `cycle_control_events`, `cycle_lifecycle_events`      | Invitations and cycle transitions remain group-scoped and durable.                                                                                                                                                                             |
| `contributions`, `contribution_quota_windows`                              | A contribution belongs to one cycle/member; quota consumption is keyed to its cycle window.                                                                                                                                                    |
| `media_metadata`, `staged_sources`, `media_jobs`, `compilation_job_inputs` | Server-verified staged source metadata feeds clip, film, and download jobs; compilation inputs order a film. Finalized rows carry a SHA-256 digest and byte length; a mismatch makes the output unavailable and is recorded in `audit_events`. |
| `messages`, `reactions`, `realtime_events`                                 | Group chat state and its replay sequence remain in SQLite.                                                                                                                                                                                     |

Migrations are idempotent and repair the documented historical partial shapes;
they must not be reordered or edited after deployment. The deployment workflow
backs up an existing database and media manifest before it invokes a migration.

## Backup and restore

Host-side migration and restore commands are deliberate operator
operations, protected by an explicit confirmation and a verified backup
manifest. They are not public HTTP operations and do not contain or print
credentials. A backup contains a consistent SQLite snapshot, media archive,
and checksummed manifest; restore verifies all three before replacing runtime
data. The detailed command sequence is in `deploy/README.md`.
