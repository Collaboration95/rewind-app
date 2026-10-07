# PostgreSQL operations runbook

How the hosted dev database is created, filled, switched to, backed up,
recovered and inspected. The design is in [ADR-0003](ADR-0003-postgresql.md).
Every step runs from Terraform or the **Database operations** workflow
(`.github/workflows/database-operations.yml`). No credential is copied by
hand.

## Components

| Piece                                                                           | Where                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Managed PostgreSQL 17 (`rewind-dev-postgres`, private, encrypted, TLS)          | `infra/terraform/media/database.tf`                                                              |
| Per-environment switches: `enabled`, `cutover`, `bundle`                        | `local.database_settings` in the same file                                                       |
| Generated logins: admin, `rewind_app` (owns schema `rewind`), `rewind_readonly` | `random_password.*`; delivered via the hosted settings object                                    |
| Runtime selection                                                               | `REWIND_DATABASE_URL` (empty means the SQLite file stays live)                                   |
| Host scripts                                                                    | `deploy/database-bootstrap.sh`, `database-import.sh`, `database-status.sh`, `backup-postgres.sh` |
| Operator CLI                                                                    | `node server/dist/cli.js database-status / database-import / database-bootstrap`                 |

Repository variable used by the workflow: `REWIND_DATABASE_BOOTSTRAP_URI`
(`terraform output database_bootstrap_uri`).

## First-time setup and cutover

1. **Create.** Apply `infra/terraform/media` with `dev.enabled = true`.
   - This creates the database and the bootstrap settings object, and adds
     `REWIND_DATABASE_APP_URL`, `REWIND_DATABASE_READONLY_URL` and an empty
     `REWIND_DATABASE_URL` to the hosted settings.
   - Run **Deploy dev** (or merge anything) so the host receives them.
2. **Roles.** Run the workflow with `bootstrap`. It creates `rewind_app` (owner
   of schema `rewind`, used by the runtime) and `rewind_readonly` (backups,
   inspection). It is safe to rerun.
3. **Import.** Run the workflow with `import`. It:
   - stops the public web proxy;
   - takes a fresh SQLite and media backup to S3 (`backup.sh`);
   - downloads that backup, checks it against its manifest, and runs
     `database-import`.

   The import loads every table in one transaction and commits only if each
   table's row count and content hash match the snapshot. The job summary
   lists the rows per table, and the JSON report stays next to the backup on
   the host. The web proxy stays stopped.

4. **Cut over.** Set `dev.cutover = true`, apply, and run **Deploy dev**.
   - The runtime starts on PostgreSQL, applies any newer migration, and binds
     the database to environment `dev`.
   - The deploy's health checks gate the switch and start the web proxy
     again.
5. **Check.** Run the workflow with `status`: engine `postgresql`, ready,
   migration 30/30, environment `dev`. Then sign in, open the group and chat
   on the hosted URL.

The SQLite file under `/srv/rewind/data` is never modified or deleted by
any of this.

### Rollback

- **Before step 4:** run the workflow with `resume`. Nothing changed for
  users.
- **After step 4:** set `dev.cutover = false`, apply, and deploy. The runtime
  returns to the untouched SQLite file. Writes made on PostgreSQL since the
  cutover are not copied back (#TBD tracks a reverse export). Decide fix
  forward versus rollback within the first day.

## Backups

| Layer                            | What                                                                                                                                                                    | Retention           | Encryption                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------- |
| Managed (primary, proposal §5.3) | Lightsail automatic daily snapshot (02:00–02:30 SGT) and point-in-time restore                                                                                          | 7 days              | at rest, provider-managed |
| Logical (independent copy)       | `backup-postgres.sh` nightly via `rewind-backup.timer`: `pg_dump` as `rewind_readonly` over verified TLS, restored into a throwaway container and counted before upload | versioned S3 bucket | SSE-S3                    |
| Media                            | S3 media bucket (versioning, lifecycle); remaining disk media archived nightly                                                                                          | as configured       | SSE-S3                    |

The workflow's `backup` operation runs the nightly job on demand. Each
logical backup writes `rewind-<stamp>.postgres.json` with checksums and the
restored row counts.

## Recovery

- **Rehearsal (do it after cutover, then monthly).** Run the workflow with
  `rehearse-restore`. It:
  1. restores the latest point-in-time recovery into a new, tagged database;
  2. checks it with `database-status` from the host;
  3. writes the RPO (recovery point age) and RTO (time to a verified
     database) to the job summary;
  4. deletes the rehearsal database.

  The live database is never touched.

- **Bad data or operator error.** Restore point-in-time to just before the
  incident. Use the Lightsail console, or the rehearsal workflow's commands
  with `--restore-time` instead of `--use-latest-restorable-time`. Verify with
  `database-status --endpoint`, then point the environment at it, either by
  importing the restored database into Terraform state or with a `pg_dump`
  copy (next bullet).
- **Database lost.** Recreate it with Terraform. Then restore the latest
  `rewind-<stamp>.pgdump` with
  `pg_restore --no-owner --role=rewind_app -d rewind`, run `bootstrap`, and
  deploy.
- **PostgreSQL unavailable for a long time.** Set `cutover = false` to run on
  the last SQLite snapshot. This is the emergency path only: data written
  since the cutover is not in that file.

Targets, to be confirmed by the first rehearsal: RPO 5 minutes
(point-in-time) or 24 hours (logical dump); RTO under 60 minutes.

## Failover

- **Infrastructure.** Set `bundle = "micro_ha_2_0"` for a standby in a second
  availability zone with automatic failover behind the same endpoint
  (US$30/month instead of US$15).
- **Application.**
  - A connection dropped by a failover, restart or network fault is replaced
    on the next statement.
  - A transaction that loses its connection fails once and rolls back, and the
    request returns an error instead of partial data.
  - A writer that cannot get the lock within 5 s reports "database is locked"
    to the existing retry loops.
  - `/health` queries the schema state, so it fails while the database is
    unreachable: Docker marks the runtime unhealthy and a deploy refuses the
    release. `checks.database` names the engine in use.
  - Covered by `server/tests/postgres.test.mjs` ("a dropped connection …
    reconnects").

## Inspecting live data

- **In the app:** `/api/admin/` (Basic auth, user `admin`,
  `REWIND_ADMIN_PASSWORD`). It is a read-only, paginated table browser that
  hides secrets, and it works on both engines.
- **SQL client (psql, pgAdmin):** the database is private to Lightsail. Open
  an SSH tunnel through the host, then connect to `127.0.0.1:5432`, database
  `rewind`, as `rewind_readonly`:

  ```sh
  ssh -L 5432:<endpoint>:5432 ubuntu@<host>
  ```

  The role cannot write (`default_transaction_read_only`, no write grants).

- The Lightsail console shows metrics, logs, snapshots and connection
  details. It has no row browser; use one of the two routes above.

## Environments and cost

- `dev` (`rewind-dev-postgres`) is enabled. `release` stays on SQLite until
  its own enablement (separate issue).
- Each environment has its own database, logins and environment binding, and
  a runtime refuses a database bound to another environment.
- Cost: `micro_2_0` is US$15/month (1 GB RAM, 40 GB SSD, backups included);
  `micro_ha_2_0` is US$30/month.
