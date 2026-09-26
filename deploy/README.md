# Hosted Demo deployment

The hosted Sprint 2 shape is one non-root Node 22 container on the host. SQLite
and media are bind-mounted from persistent instance storage;
the container itself is disposable. Compose defaults expose the static web
shell and same-origin API proxy on `127.0.0.1:8080`. The hosted
`rewind.env.example` explicitly sets `REWIND_WEB_BIND_ADDRESS=0.0.0.0` and
`REWIND_WEB_PORT=80`, publishing the web container on all host IPv4 interfaces
so the Lightsail HTTPS distribution can reach its HTTP origin on port 80.
The Lightsail firewall must allow that port; no host-installed Nginx is needed.
The Node runtime's host binding remains `127.0.0.1:8787` in both modes, with
the web container reaching it over the internal Compose network.

The web container builds the Expo export with
`EXPO_PUBLIC_LOCAL_BASE_URL=/api`. Requests under `/api/` are proxied to the
runtime with the prefix removed, while extension-less routes use the SPA
`index.html` fallback. Unknown API paths remain JSON errors with their original
status, API responses are `Cache-Control: no-store`, and content-hashed Expo
assets are immutable.

## Persistent mounts and ownership

The compose file maps two host directories below the deployment's persistent
data root:

| Host path                 | Container path          | Contents                                       |
| ------------------------- | ----------------------- | ---------------------------------------------- |
| `<persistent-root>/data`  | `/var/lib/rewind`       | `rewind.sqlite` and SQLite `-wal`/`-shm` files |
| `<persistent-root>/media` | `/var/lib/rewind/media` | server-owned staging and processed media       |

The image runs as a fixed non-root runtime identity, with no root privileges,
all Linux capabilities dropped, and a read-only container filesystem. The
runtime owns the persistent data and media trees; the approved backup operator
does not need those files to be world-readable. Do not put the database or
media under the repository checkout or point a mount at a broad system
directory.

```sh
PERSISTENT_ROOT=/path/to/persistent-root
sudo install -d -m 0750 "$PERSISTENT_ROOT/data" "$PERSISTENT_ROOT/media" "$PERSISTENT_ROOT/backups"
```

`deploy/operator-common.sh` is the executable ownership contract. Every
persistent directory, including nested media directories, is runtime-owned and
mode `0750`; every regular SQLite, WAL/SHM, and media file is runtime-owned
and mode `0640`. Recovery staging and reset/migration transitions verify this
contract before reporting success. Backup archives and manifests are private
operator artifacts (`0600`), and media is streamed through the running runtime
for backup so the host never needs a world-readable copy. The focused fixture
covers fresh, restored, nested-media, runtime read/write, wrong-mode, and
wrong-owner cases:

```sh
npm run test:ownership-contract
```

`REWIND_DATA_HOST_DIR`, `REWIND_MEDIA_HOST_DIR`, and
`REWIND_CONTAINER_NAME` are optional compose overrides used by the disposable
verification sequence below. The normal host defaults remain the `/srv/rewind`
paths shown above.

## Host bootstrap bundle

Terraform runs `infra/terraform/demo/cloud-init.sh` in two safe phases. The
first pass installs the Docker/JQ/rsync prerequisites and creates the persistent
`data`, `media`, and `backups` directories. It writes only
`.host-bootstrap-prerequisites`; it cannot claim the host is ready before the
repository bundle exists.

After Terraform creates the instance, `infra/scripts/wake-demo.sh` transfers
the reviewed release bundle and private `rewind.env`, verifies its digest on
the host, and runs the bundled bootstrap with `--complete`. Completion installs
the compose files, executable operator
scripts (including `pause-host.sh` and `preflight.sh`), the backup service and timer, and a
0600 copy of `rewind.env.example` only when no environment file exists. It
reloads and enables the backup timer, and writes
`.host-bootstrap-complete` atomically as the final step. Re-running it updates
bundle files and modes without deleting persistent data or overwriting an
existing environment file. Any failed prerequisite removes both markers and
prints the failed action with a retry hint.

The local fixture test covers the first pass, clean completion, repeat
completion, persistence and a missing-bundle failure:

```sh
./deploy/tests/host-bootstrap.test.sh
```

## Hosted-runtime preflight

Before a backup, pause, or recovery operation, run the read-only hosted gate
from `/srv/rewind`:

```sh
./deploy/preflight.sh
./deploy/preflight.sh --json
```

The command checks seven stable IDs: `config`, `persistent_paths`, `runtime`,
`migration`, `backup_tooling`, `pause_script`, and `backup_timer`. Human output
uses fixed `PASS`/`FAIL` lines; JSON contains only `version`, the overall
`ok` boolean, and each check's `id`, `ok`, and safe `reason` code. It never
serializes environment values, credentials, host paths, or backup object names.
Any failed check returns a non-zero status. The command only reads files,
Compose state, the runtime `/health` endpoint, and systemd timer state; it
does not repair the host, start or stop containers, run migrations, create a
backup, or call AWS.

The fixture covers a healthy host plus absent configuration, a missing or
inactive timer, failed runtime/schema health, and incorrect persistent-data
ownership:

```sh
./tests/deploy/host-preflight.test.sh
```

## Build, migrate, and start

For local Compose development, from the repository root:

```sh
cp deploy/rewind.env.example /srv/rewind/rewind.env
docker compose --env-file /srv/rewind/rewind.env -f deploy/compose.yaml build
docker compose --env-file /srv/rewind/rewind.env -f deploy/compose.yaml run --rm runtime migrate
docker compose --env-file /srv/rewind/rewind.env -f deploy/compose.yaml up -d
curl --fail http://127.0.0.1/
curl --fail http://127.0.0.1/api/health
```

Existing private environment files are preserved by bootstrap. To adopt this
hosted binding, set both web variables above in the host's existing environment
file and recreate the web service with
`docker compose --env-file /srv/rewind/rewind.env -f deploy/compose.yaml up -d --no-deps web`.
Then verify the public HTTPS URL and `/api/health` through the distribution;
successful loopback checks alone do not prove origin reachability. Port 80 also
permits direct HTTP access to the web origin wherever the firewall allows it;
the distribution's HTTPS redirect applies to distribution requests.

For local Compose use, omit the hosted web overrides or explicitly set
`REWIND_WEB_BIND_ADDRESS=127.0.0.1` and `REWIND_WEB_PORT=8080`. The disposable
`npm run test:host-lifecycle` runner always forces loopback and a temporary web
port, even when its parent shell contains hosted values.

For a local artifact/proxy smoke test that uses a temporary Expo export and
temporary SQLite directory, with no AWS credentials or external URL:

```sh
npm run build:web
npm run test:web-smoke
```

The smoke suite proves a deep-link shell fallback, same-origin `/api` status
preservation, JSON API failures, shell/asset cache headers, and loopback-only
execution. It does not provision or contact cloud infrastructure.

The browser-level reset-to-reveal proof uses the same local production-shaped
boundary with `EXPO_PUBLIC_CAMERA_MODE=demo`. Each invocation resets a fresh
temporary SQLite/media tree before opening the runtime, starts in Demo access
entry mode, and drives the labelled server-owned synthetic clip control. It
covers group invitation, sealed-before-release playback denial, owner advance,
one released playable film, and a cross-group safe denial. The runner executes
two independent Playwright runs; it strips cloud credential variables from
child processes, captures no screenshots/video/traces, and writes only a small
redacted failure summary when a test fails:

```sh
npm run test:production-e2e
```

The suite is local-only and does not use real camera media, public endpoints,
developer data directories, or retained browser/runtime state.

The server owns the migration contract. `migrate` opens the configured
database, creates any missing migration bookkeeping, applies only the
versioned migrations that are not marked complete, repairs the known
interrupted migration shapes, and seeds missing deterministic Demo rows. It
is additive and idempotent as supplied by `server/src/db.ts`; deployment
scripts do not edit schema files or manufacture migration state. Back up an
existing database before running it:

```sh
cd /srv/rewind
./deploy/migrate-with-backup.sh --confirm
docker compose --env-file /srv/rewind/rewind.env -f deploy/compose.yaml up -d
```

The guarded workflow requires the runtime to be running for the online
snapshot, uploads a database-and-media backup, stops the runtime, and only
then runs `migrate`. It leaves the runtime stopped if migration succeeds or
fails so an operator can inspect it before starting it again.

## Backup before reset

Reset is for the disposable Demo fixture, not for deleting production data.
It first performs the same verified database-and-media backup and requires an
explicit confirmation flag:

```sh
cd /srv/rewind
./deploy/reset-with-backup.sh --confirm
docker compose --env-file /srv/rewind/rewind.env -f deploy/compose.yaml up -d
```

The server reset contract removes the SQLite database, its WAL/SHM files, and
all server-owned Demo media contents while preserving the bind-mount directory
and migrations. The next server open recreates the deterministic five-member
Demo fixture.

## Backup and local restore

`backup.sh` uses SQLite `VACUUM INTO` for a consistent online snapshot,
archives persistent media separately, writes a manifest containing SHA-256
checksums and byte counts, uploads all three files with server-side AES256
encryption, and keeps only the local recovery window. The S3 bucket is
private; its lifecycle policy is the remote retention control.

The shared `deploy/backup-manifest.sh` validator requires exactly one database
record and one media record. Their keys must be the generated archive names
under the configured `REWIND_BACKUP_PREFIX`, with non-negative integer byte
counts and 64-character SHA-256 checksums. `created_at` must match the UTC
timestamp in the manifest filename, be a real timestamp, and be no more than
seven days old by default (override the operator-side `BACKUP_MAX_AGE_SECONDS`
only when the approved recovery window requires it). A five-minute future
clock allowance is applied. Invalid JSON, stale timestamps, path traversal,
cross-prefix keys, filename mismatches, or remote byte metadata mismatches stop
the workflow before archive download; downloaded files are then checked for
the recorded bytes and checksums before restore.

The hibernation workflow invokes `./deploy/backup.sh --local-only` on the host;
that creates the same verified artifacts without requiring AWS credentials on
the host. The trusted operator then uploads the artifacts to S3 and verifies
their presence before Terraform deletes compute.

The systemd unit files are templates. Install them on the host only after the
restricted backup AWS identity has been configured:

```sh
sudo install -m 0644 deploy/rewind-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/rewind-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rewind-backup.timer
```

Do not put AWS access keys in this repository or in `rewind.env`; use the
dedicated `AWS_PROFILE` credential store on the host. The intended policy is
limited to listing the backup bucket and writing objects under the
`rewind-demo/` prefix. Backup and pause workflows refuse missing directories,
missing Docker/AWS prerequisites, unsafe broad paths, and an absent existing
database.

To restore, copy the manifest, its matching `.sqlite.gz`, and its matching
`.media.tar.gz` into the configured local `BACKUP_DIR`. The files must retain
the names generated by `backup.sh`. Then run:

```sh
cd /srv/rewind
./deploy/restore.sh --confirm \
  /srv/rewind/backups/rewind-<timestamp>.manifest.json
```

The script does not download from S3 and does not require production
credentials. It requires the manifest to be directly inside `BACKUP_DIR`,
requires the archive names to match that manifest, checks byte counts and
SHA-256 values, checks gzip and SQLite integrity, rejects unsafe media archive
paths, and extracts into private staging before stopping the runtime or
changing live data. The host needs the `sqlite3` command for the offline
integrity gate.

After staged ownership/readability checks pass, the runtime is stopped and the
previous SQLite files plus the complete media tree are moved into a private
rollback directory. The staged database and media are then installed, the
runtime is restarted, and its container health check must become healthy before
the rollback and staging directories are removed. A checksum, extraction,
permission, replacement, or readiness failure removes partial output, moves
the previous files back, stops the failed runtime, and reports whether cleanup
completed. The successful operation leaves the runtime healthy and leaves no
temporary restore material.

The disposable failure-injection harness covers corrupt database/media,
checksum mismatch, extraction failure, ownership failure, readiness failure,
successful replacement, and the absence of partial media output:

```sh
npm run test:restore-atomic
```

## Hibernation and recovery

The hosted Demo now uses delete-and-recreate hibernation. A stopped Lightsail
instance still incurs its monthly bundle charge, so the normal lifecycle is:

1. Back up SQLite and media on the live host.
2. Verify the uploaded S3 manifest.
3. Apply Terraform with `demo_instance_enabled=false` to delete the
   disposable compute/network resources and disable their legacy controller
   bindings, while preserving the backup bucket, recovery roles, and audit
   infrastructure.
4. Recreate the instance with Terraform, rebuild the runtime, restore the
   selected S3 recovery point, and start the service.

The lifecycle scripts are read-only by default. Before either workflow reaches
Terraform apply, they verify the configured AWS account identity, the exact
Terraform-managed Demo tags and instance/static-IP inventory, and the absence
of unexpected Rewind resources. Invalid flags, partial arguments, identity
mismatches, and unsafe inventory states stop before SSH, SCP, rsync, S3 upload,
or Terraform plan/apply construction.

From the trusted operator machine, first run the read-only hibernation plan:

```sh
cd /path/to/rewind-app
export TF_AWS_PROFILE=rewind-terraform-apply
./infra/scripts/destroy-demo.sh --dry-run
```

The default invocation is equivalent to `--dry-run`; `--confirm` without
`--apply` is also still read-only. Only after the identity, inventory, backup
contract, and Terraform plan have passed may an operator request execution:

```sh
./infra/scripts/destroy-demo.sh --apply --confirm
```

The apply path then asks the host to create a consistent local snapshot, copies
the manifest and matching archives to the trusted operator machine, validates
the manifest and checksums, uploads them to S3, and verifies all three objects
before Terraform is allowed to delete compute. This means a recreated host
does not need the old host's AWS CLI credentials. The default hibernation
deletes the static IP to remove its residual charge, so the next wake may
receive a new IP. Static-IP retention is intentionally out of scope for this
sprint and can be revisited later.

To recreate the host from the newest backup, keep a private local copy of
`deploy/rewind.env` in `REWIND_ENV_FILE`, then review and apply:

```sh
export REWIND_ENV_FILE=/private/path/rewind.env
export RELEASE_BUNDLE=/private/path/rewind-<green-main-sha>.tar
export RELEASE_BUNDLE_SHA256=<reviewed-sha256-of-bundle>
./infra/scripts/wake-demo.sh --latest
./infra/scripts/wake-demo.sh --latest --apply --confirm
```

Build that bundle once on the green `origin/main` commit with a clean checkout,
including no untracked files. The `--green-sha` value is the exact commit whose
required CI checks passed; record the resulting bundle SHA-256 alongside it.
`--config-version` names the operator-reviewed private configuration contract;
change it when a release requires an incompatible environment layout. The
bundle contains a Git-archived deployment allowlist, both Docker images tagged
with the same commit SHA, and checksums. Build on an operator/CI machine with
Docker; the host loads those exact images and does not rebuild the app:

```sh
git status --short
git rev-parse HEAD
git rev-parse origin/main
python3 deploy/release.py build --green-sha "$GREEN_MAIN_SHA" \
  --config-version demo-v1 --output "/private/path/rewind-$GREEN_MAIN_SHA.tar"
python3 deploy/release.py verify "/private/path/rewind-$GREEN_MAIN_SHA.tar"
sha256sum "/private/path/rewind-$GREEN_MAIN_SHA.tar"
```

Before applying wake, confirm the reviewed PR and green check belong to that
SHA, verify the full S3 backup, and review any migration against the previous
image. A new schema version can block rollback to an older image. `wake-demo.sh`
still requires `--apply --confirm` and the verified recovery point; `--seed`
remains only for first installation. After deployment, check the host runtime,
the public HTTPS shell and `/api/health`, and the synthetic group journey. The
host retains its previous release archive, image pair, and configuration version.
If health or the journey fails, an operator can run the following on the host:

```sh
cd /srv/rewind
./deploy/release-host.sh rollback
```

Rollback refuses a newer database schema or changed configuration version and
verifies runtime and web health after starting the prior images. If it refuses,
restore only through the verified recovery procedure after reviewing data and
migration compatibility; do not force an older image onto a newer database.

You can select an exact recovery point with
`--manifest s3://rewind-demo-backups-.../rewind-demo/rewind-<timestamp>.manifest.json`.
Before Terraform plan or any host connection, the wake script verifies both AWS
identities, refuses an existing or unexpected Rewind resource, and validates
the selected manifest and both matching S3 archives. `--latest` scans all manifest-shaped
objects, rejects malformed, incomplete, cross-prefix, byte-mismatched, and
checksum-mismatched candidates, and then chooses the greatest validated
manifest timestamp; S3 listing order and object modification time are not
trusted. Explicit `--manifest` selections use the same bucket, prefix, name,
archive-size, and checksum checks. A failed selection performs no Terraform
plan/apply, SSH, SCP, rsync, or host mutation. The only historical-recovery
execution form is `--apply --confirm`; the default and `--dry-run` forms stop
after the reviewed plan.

The wake script then creates the new host, waits for cloud-init, copies the
digest-checked release bundle, transfers the already-verified recovery point, restores it
through `restore.sh`, and checks `/health` before reporting success. Run the
hermetic selection tests with `npm run test:wake-recovery-selection`.

The higher-level recreate-and-restore smoke suite runs the unchanged wake
orchestrator with local fakes for AWS, Terraform, SSH, SCP, rsync, and Docker.
It executes the real `deploy/restore.sh` against a disposable fixture host and
prints a redacted stage transcript covering recovery-point validation, plan,
apply, transfer, restore, runtime start, and final health. Separate runs inject
failures at plan, apply, recovery transfer, restore start, and final health;
each asserts that no later stage runs. It never contacts a network, reads an
SSH key, uses AWS credentials, or writes Terraform state:

```sh
npm run test:recovery-smoke
```

Run it twice when changing recovery orchestration to prove the fixture is
repeatable on a clean temporary directory. The transcript intentionally uses
stage labels instead of command arguments, paths, object names, or command
output so it remains auditable without exposing environment-specific data.

Because this account's former instance was deleted before a complete recovery
point existed, first installation can use the explicit seed path:

```sh
./infra/scripts/wake-demo.sh --seed
./infra/scripts/wake-demo.sh --seed --apply --confirm
```

Seed mode creates the deterministic Demo and runs migrations; it is not a
historical restore or a substitute for a verified recovery point. It is the
explicit first-install exception to the recovery-point guard and must never be
used to replace an existing host. Run a full host backup afterward and verify
that the S3 manifest, SQLite archive, and media archive all exist before using
`destroy-demo.sh`.

`infra/scripts/stop-demo.sh` is retained only as a compatibility name and now
delegates to the same guarded, backup-gated hibernation workflow. It inherits
the read-only default and requires `--apply --confirm` for execution. The
emergency stop script is not a recovery workflow: it remains an incident-only
last resort when the host cannot be reached and cannot create a backup itself.

Run the mocked lifecycle guard suite to exercise confirmation ordering,
identity mismatches, unexpected resources, dry-run behavior, and backup-gate
failures without AWS credentials or a real host:

```sh
npm run test:lifecycle-guards
```

## Repeatable disposable-Demo verification

Run the hermetic host-lifecycle harness from the repository root with Docker
available:

```sh
npm run test:host-lifecycle
```

The command creates fresh temporary `data`, `media`, and Compose environment
directories, chooses loopback ports, and uses a unique Compose project. It
builds only the runtime image, runs migration/seed, checks health, creates an
owner session, writes fixture-only persistence sentinels, stops and restarts
the runtime, verifies the session and media survived, performs the owner reset,
then verifies post-reset health, restored Demo rows, removal of Demo media, and
preservation of a non-Demo sentinel. It always runs `compose down --volumes
--remove-orphans` and removes the temporary root, including after an assertion
or timeout failure.

The harness never reads or writes `/srv/rewind`, a checkout data directory, AWS,
or a public URL. Failure output is limited to redacted Compose status/log
diagnostics; paths, environment values, invitation codes, and media content
are not emitted. The default wall-clock bound is five minutes and can be
adjusted for a slower local Docker engine with
`--timeout-seconds 15..900`.

The Docker-free contract and redaction tests are:

```sh
node --test tests/deploy/host-lifecycle-smoke.test.mjs
```
