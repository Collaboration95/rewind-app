# Hosted deployment

How the hosted app is packaged, deployed, backed up and recovered. For the
system map see [current system](../docs/architecture/current-system.md); for the
database see the [PostgreSQL runbook](../docs/architecture/postgresql-operations.md);
for release setup see [release cutover](../docs/architecture/release-cutover.md).

Two hosted environments run the real-account app:

| Environment | Host (Lightsail) | Deploys from                                    | Database                                  |
| ----------- | ---------------- | ----------------------------------------------- | ----------------------------------------- |
| dev         | `rewind-demo`    | every merge to `dev` (`deploy-dev.yml`)         | managed PostgreSQL (cut over)             |
| release     | `rewind-release` | qualified `main` commits (`deploy-release.yml`) | PostgreSQL declared, cutover not complete |

The dev host, its Terraform root (`infra/terraform/demo`), scripts and repository
variables keep the historical `demo` name. They serve the real-account app; the
synthetic Demo was removed on 6 October 2026. Do not rename them.

Hosted dev is at [https://d2m6kz76y4kuvm.cloudfront.net](https://d2m6kz76y4kuvm.cloudfront.net).
Loopback addresses in this guide are local origin checks, not public URLs.

## Shape of a host

Two disposable, read-only, non-root containers run under Docker Compose
(`deploy/compose.yaml`):

- `runtime`: the Node server on `127.0.0.1:8787`. It owns HTTP, the cycle
  scheduler, media workers and the reminder loop.
- `web`: nginx serving the Expo web export and proxying `/api/*` to the runtime
  with the prefix removed. Unknown paths fall back to the SPA `index.html`;
  API responses are `no-store`; hashed assets are immutable.

Hosted `rewind.env` publishes `web` on host port 80 (`REWIND_WEB_BIND_ADDRESS=0.0.0.0`,
`REWIND_WEB_PORT=80`) so CloudFront can reach it over HTTP. Without those
overrides Compose binds `127.0.0.1:8080`. The Lightsail firewall must allow port 80. Data lives outside the containers: PostgreSQL, S3 media, and the persistent
host mounts below.

## Persistent mounts and ownership

| Host path                 | Container path          | Contents                                                   |
| ------------------------- | ----------------------- | ---------------------------------------------------------- |
| `<persistent-root>/data`  | `/var/lib/rewind`       | SQLite files (retained, or live before PostgreSQL cutover) |
| `<persistent-root>/media` | `/var/lib/rewind/media` | server-owned staging and disk media                        |

The host default root is `/srv/rewind`. `deploy/operator-common.sh` is the
ownership contract: directories are runtime-owned `0750`, files `0640`, backup
artifacts `0600`. Backup and recovery check this before reporting success. Never
point a mount at the checkout or a broad system directory.
`bash tests/deploy/ownership-contract.test.sh` covers it.

## Host bootstrap

Terraform runs `infra/terraform/demo/cloud-init.sh` on first boot. It installs
Docker, `jq` and `rsync` and creates `data`, `media` and `backups`. It does not
mark the host ready: the first deployment (or `infra/scripts/wake-demo.sh`)
transfers the release bundle and runs the bundled bootstrap with `--complete`.
That installs the Compose files, operator scripts, the backup service and timer,
and a `0600` `rewind.env` only when none exists. Re-running it never deletes data
or overwrites `rewind.env`. Fixture test: `./deploy/tests/host-bootstrap.test.sh`.

Run the read-only gate on the host before a backup or recovery:

```sh
cd /srv/rewind && ./deploy/preflight.sh [--json]
```

It checks `config`, `persistent_paths`, `runtime`, `migration`, `backup_tooling`,
`pause_script` and `backup_timer`, prints no secrets, and changes nothing.
Fixture test: `bash tests/deploy/host-preflight.test.sh`.

## Release bundles and deployment

A release is a source-bound bundle built by `deploy/release.py`: an archived
allowlist of deployment files, both Docker images tagged with the commit SHA,
image IDs and checksums. The host loads those images and never rebuilds the app.
`deploy/release-host.sh` has these commands: `prepare`, `install`, `promote`,
`rollback`, `prune` and `configure`.

### Automatic deployment

`.github/workflows/deploy-dev.yml` and `deploy-release.yml` do the build and
install from CI:

1. The commit must have passed its own branch's `Quality checks` push run.
2. `release.py build` (with `--branch dev` for dev) makes and verifies the bundle.
3. `release-host.sh install` activates it only after runtime and web health pass.
   On failure it restores the previous image pair when the schema permits.

Both workflows need the host running; they never power it on or off. They never
write `rewind.env` by hand: hosted settings come from Terraform through the
private `_config/` settings object in the media bucket, streamed to `release-host.sh configure`.
They reach the host over Lightsail's temporary SSH key, opening port 22 to the
runner only for the run. AWS access is a GitHub OIDC role, not stored keys.

Repository variables: `AWS_DEMO_DEPLOY_ROLE_ARN` (dev; the `deploy_role_arn`
output of `infra/terraform/demo`), `REWIND_HOSTED_ENV_URI` (dev settings object),
`AWS_RELEASE_DEPLOY_ROLE_ARN` and
`REWIND_RELEASE_HOSTED_ENV_URI` (release; outputs of `infra/terraform/release`).
Optional: `REWIND_DEMO_AWS_REGION`, `REWIND_DEMO_INSTANCE`,
`REWIND_DEMO_CONFIG_VERSION`, `REWIND_RELEASE_INSTANCE`. Docs-only pushes skip
deployment.

### Rollback

On the host: `cd /srv/rewind && ./deploy/release-host.sh rollback`. It refuses a
newer database schema or changed private configuration, and updates the active
pointer only after health passes. If it refuses, recover through the verified
procedures below; never force an older image onto a newer database.

### Manual bundle

For an out-of-band deploy, build and verify a bundle on a clean checkout of a
green commit (needs authenticated `gh` and Docker):

```sh
python3 deploy/release.py build --green-sha "$SHA" --config-version demo-v1 \
  --branch dev --output /private/path/rewind-$SHA.tar
python3 deploy/release.py verify /private/path/rewind-$SHA.tar
```

Copy it with `deploy/release.py` and `deploy/release-host.sh` to the host, compare
the SHA-256 with the reviewed value, and run `bash release-host.sh install <bundle>`.
`--branch` defaults to `main`. Use `--config-version release-v1` for release.

## Database

Hosted dev runs managed PostgreSQL; `REWIND_DATABASE_URL` selects it, and an empty
value keeps the SQLite file under `data/`. Create, import, cut over, roll back,
recover and inspect the database with the **Database operations** workflow
(`status`, `bootstrap`, `import`, `resume`, `backup`, `rehearse-restore`) as
described in the [PostgreSQL runbook](../docs/architecture/postgresql-operations.md).
Browse live dev data with the read-only login:
`terraform -chdir=infra/terraform/media output -raw database_readonly_url`.
The `/admin` browser was removed. Locally, open `.local-data/real` with any SQLite
tool.

Migrations are owned by the server (`server/src/schema.ts`, `server/migrations`) and
run at start-up. On a SQLite host, `./deploy/migrate-with-backup.sh --confirm`
uploads a backup, stops the runtime and runs `migrate`, leaving the runtime
stopped for inspection.

## Backup

`rewind-backup.timer` runs `deploy/backup.sh` nightly. The S3 bucket is private
and encrypted (SSE-S3); its lifecycle policy controls remote retention.

- **SQLite host** (`REWIND_DATABASE_URL` empty): a `VACUUM INTO` snapshot, a disk
  media archive and a manifest with SHA-256 checksums and byte counts.
- **PostgreSQL host:** `backup.sh` calls `backup-postgres.sh`: a `pg_dump` as the
  read-only role over verified TLS, restored into a throwaway container and
  row-counted before upload. Managed snapshots and point-in-time restore are the
  primary recovery path.

`deploy/backup-manifest.sh` validates manifests (key names under
`REWIND_BACKUP_PREFIX`, sizes, checksums, and a `created_at` no older than seven
days) before anything is downloaded. The host uses a restricted backup AWS
identity from `AWS_PROFILE` or Terraform-delivered settings; never put access keys
in this repository. The `rewind-backup.service`/`.timer` units are installed by
bootstrap. Test: `bash tests/deploy/backup-manifest.test.sh`.

## Restore and host rebuild

`deploy/restore.sh --confirm <manifest>` restores a SQLite-era recovery point
(manifest, `.sqlite.gz` and `.media.tar.gz` already in `BACKUP_DIR`). It verifies
sizes, checksums, gzip and SQLite integrity and unsafe archive paths in private
staging, then swaps data and media with a rollback directory and requires the
runtime to become healthy. On any failure it restores the previous files.
`bash tests/deploy/restore-atomic.test.sh` injects the failures. It applies to a host that
keeps its database on disk, not to PostgreSQL.

`infra/scripts/wake-demo.sh` creates or rebuilds the dev host. Backup-gated
hibernation (`destroy-demo.sh`) was retired in #512, and the host runs
continuously. Wake is read-only by default: it checks the AWS account, the
Terraform-managed instance and static-IP inventory and the absence of unexpected
Rewind resources before any plan.

```sh
export REWIND_ENV_FILE=/private/path/rewind.env
export RELEASE_BUNDLE=/private/path/rewind-<sha>.tar
export RELEASE_BUNDLE_SHA256=<reviewed-sha256>
./infra/scripts/wake-demo.sh --latest                  # review the plan
./infra/scripts/wake-demo.sh --latest --apply --confirm
```

`--latest` and `--manifest s3://.../rewind-<timestamp>.manifest.json` select and
validate a SQLite-era recovery point before Terraform or any host contact, then
restore it through `restore.sh` and check `/health`. `--seed` starts from an empty
database for a first install only; it is not a restore and must not replace an
existing host. In an incident, `aws lightsail stop-instance --instance-name rewind-demo`
is the last resort; take a current S3 backup first (a stopped instance still bills).

Tests (all offline): `bash tests/deploy/wake-recovery-selection.test.sh`,
`bash tests/deploy/lifecycle-guards.test.sh`, `bash tests/deploy/recovery-smoke.test.sh`.

## Local verification

```sh
npm run build:web && npm run test:web-smoke   # static shell + same-origin /api proxy
npm run test:real-account-e2e                 # production-shaped browser journeys
npm run test:host-lifecycle                   # disposable Docker: migrate, restart, persistence
node --test tests/deploy/host-lifecycle-smoke.test.mjs   # Docker-free contract tests
```

`test:host-lifecycle` uses fresh temporary data and media directories and a unique
Compose project, forces loopback, always removes its containers and volumes, and
redacts failure output. It never touches `/srv/rewind`, AWS or a public URL.
Use `--timeout-seconds 15..900` on a slow Docker engine. The other two commands
are also local only, with cloud credentials stripped.

For a local Compose run, copy `deploy/rewind.env.example` to `rewind.env`, set
`REWIND_WEB_BIND_ADDRESS=127.0.0.1` and `REWIND_WEB_PORT=8080`, then use
`docker compose --env-file rewind.env -f deploy/compose.yaml up -d --build` and
check `http://127.0.0.1:8080/api/health`. For the hosted app, verify
`/api/health` through the HTTPS URL; loopback checks do not prove origin
reachability.
