# PostgreSQL operations runbook

How the hosted dev database is created, filled, switched to, backed up,
recovered and inspected. The design is in [ADR-0003](ADR-0003-postgresql.md).
Every step runs from Terraform or the **Database operations** workflow
(`.github/workflows/database-operations.yml`). No credential is copied by
hand.

## Components

| Piece                                                                                    | Where                                                                                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Managed PostgreSQL 17 (`rewind-dev-postgres`, private, encrypted, TLS)                   | `infra/terraform/media/database.tf`                                                                                   |
| Per-environment switches: `enabled`, `cutover`, `bundle`                                 | `local.database_settings` in the same file                                                                            |
| Generated logins: `rewind_admin`, `rewind_app` (owns schema `rewind`), `rewind_readonly` | `random_password.*`; delivered via the hosted settings object                                                         |
| Runtime selection                                                                        | `REWIND_DATABASE_URL` (empty means the SQLite file stays live)                                                        |
| Host scripts                                                                             | `deploy/database-bootstrap.sh`, `database-import.sh`, `database-status.sh`, `backup-postgres.sh`                      |
| Operator CLI                                                                             | `node server/dist/cli.js database-status / database-import / database-export / database-install / database-bootstrap` |

Repository variable used by the workflow: `REWIND_DATABASE_BOOTSTRAP_URI`
(`terraform output database_bootstrap_uri`).

GitHub only dispatches a workflow that also exists on the default branch
(`main`). Until a `main` promotion includes it, run the same steps from an
operator machine: open SSH for your address
(`aws lightsail open-instance-public-ports`), get a certificate with
`aws lightsail get-instance-access-details`, connect with
`-o IdentitiesOnly=yes`, and run the `deploy/database-*.sh` scripts on the
host. Close the port afterwards.

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

There are two different rollbacks. Pick one on purpose.

| Goal                                                        | Use                                                                   | Writes made on PostgreSQL since the cutover                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Return to SQLite and keep everything users did              | [Reverse export and switch](#reverse-export-and-database-only-switch) | Kept: proven by row counts and content hashes                                 |
| Return to the old pre-cutover snapshot (accepting the loss) | `cutover = false` with the untouched `/srv/rewind/data/rewind.sqlite` | Lost: accounts, chat and contributions since the cutover are not in that file |

- **Before step 4:** run the workflow with `resume`. Nothing changed for
  users.
- **After step 4, lossless:** run the reverse export and switch below. It
  refuses to continue unless every table matches, and it leaves PostgreSQL and
  the previous SQLite file in place.
- **After step 4, deliberately old:** set `dev.cutover = false`, apply, and
  deploy. This is only a rollback to the pre-cutover snapshot, not a recovery
  of current data. Say so in the incident notes, and decide it within the
  first day.
- A lossless rollback needs readable PostgreSQL. If PostgreSQL cannot be
  read, the export cannot run: use [Recovery](#recovery) and report the
  recovery point it gives (never "zero loss").

## Reverse export and database-only switch

`database-export` copies the current PostgreSQL database into a new SQLite
file from one repeatable-read, read-only snapshot. `database-install` swaps
that file in for the live SQLite path. Neither touches media: disk media and
the exact S3 object and version references stored in the rows stay as they
are, and `deploy/restore.sh` (which also swaps the media tree and could bring
back older media) is not used.

What the export guarantees:

- The file is built at the current SQLite schema under a staging name in the
  destination directory, then verified: integrity check, foreign-key check,
  schema readiness, and for every table the row count and canonical content
  hash against the PostgreSQL snapshot (the same hashing as `database-import`).
  Migration versions and markers must be exactly this release's; the
  PostgreSQL environment binding must equal `REWIND_DATABASE_ENVIRONMENT`;
  and `AUTOINCREMENT` counters continue after PostgreSQL's.
- PostgreSQL is then read a second time. If any table differs from the
  snapshot, a write landed during the export and the command fails.
- The destination must be a new file in an existing directory. A leftover
  file, `-wal`/`-shm`, symlink, directory or report with that name is refused.
  The file is linked into place without overwriting, and only after every
  check passed. A failure or `kill -9` at any point leaves no destination
  file, only a hidden `.<name>.exporting-*` file that is safe to delete.
- `<destination>.export.json` records the environment, per-table hashes and
  the file's SHA-256. `database-install` accepts nothing without it.

What the install guarantees:

- It re-verifies the file against the report, and re-reads PostgreSQL: it
  refuses if anything changed, or a runtime is connected, since the export.
  (`--skip-source-check` is for unreadable PostgreSQL only; it accepts that
  nothing was checked.)
- It keeps the previous file as `rewind.sqlite.pre-export-<stamp>` (a hard
  link, so `rewind.sqlite` is never missing), moves a stale `-wal`/`-shm` with
  it, and replaces `rewind.sqlite` with one rename on the same filesystem.
- It verifies the installed file again. On any failure it puts the previous
  file (and its WAL) back and returns the export to its staged name, so the
  same export can be installed after the cause is fixed.
- The environment of the export must match `REWIND_DATABASE_ENVIRONMENT` (or
  `REWIND_MEDIA_ENVIRONMENT`) of the install, or `--environment NAME`.

### Writers to stop first

Everything that writes to PostgreSQL runs inside the `runtime` container:
the HTTP server, the cycle scheduler (which drives media processing and film
compilation), the reminder loop and the staged-source cleanup. There is no
separate worker container. The export refuses to run while a session named
`rewind-runtime` is connected to the database, so a forgotten writer fails
the command instead of losing data.

1. Hold merges to `dev` and do not start **Deploy dev**: a deploy restarts the
   runtime on PostgreSQL while `cutover = true`.
2. Pause the nightly backup if it is due in the window:
   `sudo systemctl stop rewind-backup.timer` (start it again at the end).
3. Stop public traffic and the runtime, which stops the scheduler, reminder
   loop and media workers with it:
   `docker stop rewind-demo-web` then
   `docker compose --env-file /srv/rewind/rewind.env -f /srv/rewind/deploy/compose.yaml stop runtime`.
   Also stop any `worker` command started by hand.
4. Confirm `docker ps` shows neither container.

### Procedure

Run on the host (same SSH access as the other database operations), as the
user that owns `/srv/rewind`. `compose` stands for
`REWIND_DATA_HOST_DIR=/srv/rewind/data REWIND_MEDIA_HOST_DIR=/srv/rewind/media docker compose --env-file /srv/rewind/rewind.env -f /srv/rewind/deploy/compose.yaml`.

```sh
# 1. Stop the writers (above). Then export; this reads PostgreSQL only.
compose run --rm --no-deps -T runtime database-export \
  --sqlite /var/lib/rewind/rewind.sqlite.next --json | tee /srv/rewind/backups/export.json

# 2. Switch the database file only. Re-checks PostgreSQL, keeps the old file.
compose run --rm --no-deps -T runtime database-install \
  --sqlite /var/lib/rewind/rewind.sqlite.next --json | tee /srv/rewind/backups/install.json

# 3. Point the runtime at SQLite: dev.cutover = false in
#    infra/terraform/media/database.tf, apply, then run Deploy dev. The
#    deploy clears REWIND_DATABASE_URL, starts the runtime on the installed
#    file, and its health checks gate the web proxy.
# 4. Check: sign in, open the group and chat, and look for the writes made
#    since the cutover.
```

The install output names the previous file
(`/srv/rewind/data/rewind.sqlite.pre-export-<stamp>`). PostgreSQL is not
modified or deleted, and neither are the media directories or S3 objects.

If anything after step 2 goes wrong, before users write to SQLite:

- **The switch itself failed.** Nothing changed: the live file is the old one.
  Fix the cause and rerun step 2 (or step 1 if PostgreSQL changed).
- **The deploy or its health check failed.** Set `cutover = true` again and
  deploy; PostgreSQL still holds everything. Or put the file back:
  `mv rewind.sqlite.pre-export-<stamp> rewind.sqlite` (with its `-wal`/`-shm`
  if present) while the runtime is stopped.
- **After users have written to SQLite**, do not flip `cutover = true`: that
  would lose those writes. Stop the writers and copy the live SQLite file
  back with `database-import --replace` first.

Rehearse locally with disposable databases: start PostgreSQL, run the runtime
with `REWIND_DATABASE_URL` and a scratch `REWIND_DATA_DIR`, make writes, stop
the runtime, then run `database-export` and `database-install` as above and
start the runtime without `REWIND_DATABASE_URL`. `server/tests/postgres-export.test.mjs`
automates the export and install, including the failure cases (run it with
`npm run server:test:postgres`, see the next section).

### Tests

`server/tests/postgres-export.test.mjs` needs PostgreSQL
(`REWIND_TEST_DATABASE_URL`; `npm run server:test:postgres` creates a
throwaway database on `REWIND_TEST_POSTGRES_URL` or `make postgres-test-db`).
Without it the tests skip, as the other PostgreSQL tests do. CI runs them in
the `server-postgres` job.

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
- **PostgreSQL unavailable for a long time.** The reverse export needs
  readable PostgreSQL, so it cannot help here. Use the managed point-in-time
  restore or the latest logical dump above, and state the recovery point you
  actually got: the latest restorable time of the point-in-time restore
  (5.6 minutes behind in the 7 October rehearsal), or the last nightly
  logical dump (up to 24 hours behind). Data written after that point is lost
  and must be reported as lost, not as a zero-loss rollback. Once the
  restored database is readable, you can still run the reverse export
  against it.
- **Emergency fallback to the old snapshot.** Setting `cutover = false` runs
  the untouched pre-cutover SQLite file. That is a return to an old snapshot,
  not a recovery: everything written since the cutover is missing.

Measured on 7 October 2026 (cutover day), dev with 889 rows in 38 tables:

| Rehearsal                                | Result                                                           |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Recovery point age at restore time (RPO) | 334 s (5.6 min)                                                  |
| Restore to a verified database (RTO)     | 1022 s (17 min); 1017 s of it is Lightsail creating the instance |
| Restored versus live rows                | identical in all 38 tables                                       |
| Nightly logical backup                   | `rewind-20261007T160237Z.pgdump`, restore-verified (38 tables)   |

The logical dump bounds the RPO at 24 hours if the managed backups are lost
as well.

## Failover

- **Infrastructure.** The database runs as a single instance (`micro_2_0`).
  The owner decided against a standby on 7 October 2026 (#503): recovery
  from a lost instance is the point-in-time restore above. A standby is one
  setting away (`bundle = "micro_ha_2_0"`, US$30/month) if that changes.
- **Application.**
  - A connection dropped by a restart, maintenance or network fault is
    replaced on the next statement.
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

The dev database is publicly reachable (`public = true` in
`local.database_settings`), so any PostgreSQL client can browse it: psql,
pgAdmin, TablePlus or DBeaver. TLS is required. Use the read-only login, which
cannot write (`default_transaction_read_only`, SELECT-only grants):

```sh
terraform -chdir=infra/terraform/media output -raw database_readonly_url
psql "$(terraform -chdir=infra/terraform/media output -raw database_readonly_url)?sslmode=require"
```

Tables are in schema `rewind`. The old `/admin` table browser was removed.
The Lightsail console shows metrics, logs, snapshots and connection details,
but has no row browser. Set `public = false` to make the database private to
Lightsail resources again; then reach it through an SSH tunnel via the host.

## Environments and cost

- `dev` (`rewind-dev-postgres`) is enabled. `release` stays on SQLite until
  its own enablement (#504).
- Each environment has its own database, logins and environment binding, and
  a runtime refuses a database bound to another environment.
- Cost: `micro_2_0` is US$15/month (1 GB RAM, 40 GB SSD, backups included).
