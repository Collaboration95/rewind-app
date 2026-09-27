# Hosted Demo persistence contract

Sprint 1 runs one disposable Node container against persistent SQLite and
server-owned synthetic media. It is a Demo appliance, not a production data
platform: it accepts no personal media and does not claim high availability.

## Persistent boundary

The host keeps two non-root-writable bind mounts outside the application
checkout:

| Persisted area | Container target        | Contents                                                 |
| -------------- | ----------------------- | -------------------------------------------------------- |
| SQLite data    | `/var/lib/rewind`       | `rewind.sqlite` and its SQLite WAL/SHM companions        |
| Demo media     | `/var/lib/rewind/media` | staged sources and processed synthetic clip/film outputs |

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
| `profiles`, `groups`, `memberships`                                        | Synthetic profiles join groups through memberships; the persisted role gates owner actions.                                                                                                                                                    |
| `sessions`, `audit_events`                                                 | A bounded synthetic Demo session identifies an actor; audit rows are redacted operational events.                                                                                                                                              |
| `invites`, `cycles`, `cycle_control_events`, `cycle_lifecycle_events`      | Invitations and cycle transitions remain group-scoped and durable.                                                                                                                                                                             |
| `contributions`, `contribution_quota_windows`                              | A contribution belongs to one cycle/member; quota consumption is keyed to its cycle window.                                                                                                                                                    |
| `media_metadata`, `staged_sources`, `media_jobs`, `compilation_job_inputs` | Server-verified staged source metadata feeds clip, film, and download jobs; compilation inputs order a film. Finalized rows carry a SHA-256 digest and byte length; a mismatch makes the output unavailable and is recorded in `audit_events`. |
| `messages`, `reactions`, `realtime_events`                                 | Group chat state and its replay sequence remain in SQLite.                                                                                                                                                                                     |

Migrations are idempotent and repair the documented historical partial shapes;
they must not be reordered or edited after deployment. The deployment workflow
backs up an existing database and media manifest before it invokes a migration.

## Reset, backup, and restore

The application-facing `POST /demo/reset` endpoint requires a current synthetic
Demo session for the persisted owner of that session's group. It restores the
deterministic five-member fixture and clears all server-owned media contents
without removing the media bind-mount directory. A non-owner receives the same
safe denial used by other protected resources.

Host-side migration, reset, and restore commands are deliberate operator
operations, protected by an explicit confirmation and a verified backup
manifest. They are not public HTTP operations and do not contain or print
credentials. A backup contains a consistent SQLite snapshot, media archive,
and checksummed manifest; restore verifies all three before replacing runtime
data. The detailed command sequence is in `deploy/README.md`.
