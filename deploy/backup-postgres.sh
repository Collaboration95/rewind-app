#!/usr/bin/env bash
# Daily logical backup of the hosted PostgreSQL database (#172, #261).
#
# The managed service's automatic snapshots and point-in-time restore are the
# primary recovery mechanism. This adds an independent copy in the private,
# versioned, encrypted backup bucket:
#   rewind-<stamp>.pgdump          pg_dump custom format, read-only role, TLS
#   rewind-<stamp>.media.tar.gz    remaining disk media (as backup.sh)
#   rewind-<stamp>.postgres.json   checksums, sizes and restored row counts
# Every dump is restored into a throwaway local PostgreSQL container before
# upload, so a backup that cannot be restored fails here instead of later.
#
# Called by backup.sh when REWIND_DATABASE_URL is set; --local-only skips S3.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/operator-common.sh"

HOST_ROOT="${HOST_ROOT:-/srv/rewind}"
ENV_FILE="${ENV_FILE:-$HOST_ROOT/rewind.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$HOST_ROOT/deploy/compose.yaml}"
DATA_DIR="${DATA_DIR:-$HOST_ROOT/data}"
MEDIA_DIR="${MEDIA_DIR:-$HOST_ROOT/media}"
BACKUP_DIR="${BACKUP_DIR:-$HOST_ROOT/backups}"
POSTGRES_IMAGE="${REWIND_POSTGRES_TOOLS_IMAGE:-postgres:17-alpine}"
LOCAL_ONLY=0
[[ "${1:-}" == --local-only ]] && LOCAL_ONLY=1

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
if [[ "${REWIND_MEDIA_ENVIRONMENT:-}" == release || -n "${REWIND_OPERATION_ENVIRONMENT:-}" ]]; then
  require_database_target
fi
if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  unset AWS_PROFILE
fi
: "${REWIND_DATABASE_READONLY_URL:?REWIND_DATABASE_READONLY_URL must be set (Terraform hosted settings)}"
: "${REWIND_BACKUP_PREFIX:=rewind-demo}"
[[ "$LOCAL_ONLY" == 1 ]] || : "${REWIND_BACKUP_BUCKET:?REWIND_BACKUP_BUCKET must be set in $ENV_FILE}"
require_command docker
require_command jq
[[ "$LOCAL_ONLY" == 1 ]] || require_command aws
require_runtime_running
resolve_installed_release
ensure_backup_directory "$BACKUP_DIR"
BACKUP_DIR="$(canonical_directory BACKUP_DIR "$BACKUP_DIR")"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_name="rewind-${stamp}.pgdump"
media_name="rewind-${stamp}.media.tar.gz"
manifest_name="rewind-${stamp}.postgres.json"
work="$(mktemp -d "$BACKUP_DIR/.postgres-backup.XXXXXX")"
verifier="rewind-backup-verify-${stamp,,}"
snapshotter="rewind-backup-snapshot-${stamp,,}"
snapshot_pid=''
cleanup() {
  docker rm -f "$snapshotter" >/dev/null 2>&1 || true
  [[ -z "$snapshot_pid" ]] || wait "$snapshot_pid" 2>/dev/null || true
  docker rm -f "$verifier" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

# Verify the server certificate with the CA bundle the runtime ships.
compose exec -T runtime cat /app/server/certs/rds-global-bundle.pem > "$work/ca.pem"
chmod 0644 "$work/ca.pem"
chmod 0755 "$work"

export PGURI="$REWIND_DATABASE_READONLY_URL"
export REWIND_DATABASE_URL="$PGURI"
# Keep the fingerprint and pg_dump on the same immutable MVCC snapshot, even
# while normal runtime writes continue. Only this owned container holds it.
mkfifo "$work/release"
exec 3<> "$work/release"
compose run --rm --no-deps -T --name "$snapshotter" -e REWIND_DATABASE_URL \
  runtime database-status --json --hold-snapshot < "$work/release" > "$work/source.json" &
snapshot_pid=$!
for _ in $(seq 1 60); do
  jq -e '.ready == true and (.snapshot | type == "string")' "$work/source.json" >/dev/null 2>&1 && break
  kill -0 "$snapshot_pid" 2>/dev/null || die 'The backup snapshot holder failed.'
  sleep 1
done
snapshot="$(jq -er '.snapshot | select(test("^[0-9A-Fa-f-]+$"))' "$work/source.json")" || die 'No exported backup snapshot.'
docker run --rm -e PGURI -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/ca/ca.pem \
  -e SNAPSHOT="$snapshot" -v "$work/ca.pem:/ca/ca.pem:ro" "$POSTGRES_IMAGE" \
  sh -c 'exec pg_dump --snapshot="$SNAPSHOT" --format=custom --no-owner --no-privileges --dbname="$PGURI"' \
  > "$BACKUP_DIR/$dump_name"
[[ -s "$BACKUP_DIR/$dump_name" ]] || die 'pg_dump produced an empty file.'
printf 'release\n' >&3
wait "$snapshot_pid"
snapshot_pid=''
exec 3>&-

# Restore into a throwaway server and count every table.
docker run -d --name "$verifier" -e POSTGRES_PASSWORD=verify --tmpfs /var/lib/postgresql/data \
  "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$verifier" pg_isready -q -h 127.0.0.1 && break
  sleep 1
done
docker exec -i "$verifier" pg_restore --no-owner --no-privileges --exit-on-error \
  -h 127.0.0.1 -U postgres -d postgres < "$BACKUP_DIR/$dump_name"
docker exec "$verifier" psql -h 127.0.0.1 -U postgres -d postgres -c 'ALTER ROLE postgres SET search_path = rewind' >/dev/null
docker run --rm --network "container:$verifier" \
  -e REWIND_DATABASE_URL=postgres://postgres:verify@127.0.0.1/postgres \
  -e REWIND_DATABASE_TLS=disable -e REWIND_DATABASE_ENVIRONMENT \
  -e REWIND_AUTH_PASSWORD -e REWIND_COGNITO_REGION -e REWIND_COGNITO_USER_POOL_ID \
  -e REWIND_COGNITO_CLIENT_ID -e REWIND_COGNITO_DOMAIN \
  "rewind-demo:$REWIND_RELEASE_SHA" database-status --json > "$work/restored.json"
compare_database_reports "$work/source.json" "$work/restored.json"
counts="$(jq '.rows' "$work/restored.json")"

archive_runtime_media "$BACKUP_DIR/$media_name"
for file in "$BACKUP_DIR/$dump_name" "$BACKUP_DIR/$media_name"; do
  assert_private_backup_file "$file" 'backup archive'
done
jq -n --arg created_at "$stamp" --arg prefix "$REWIND_BACKUP_PREFIX" \
  --arg dump "$dump_name" --arg dump_sha "$(sha256_file "$BACKUP_DIR/$dump_name")" \
  --argjson dump_bytes "$(file_bytes "$BACKUP_DIR/$dump_name")" \
  --arg media "$media_name" --arg media_sha "$(sha256_file "$BACKUP_DIR/$media_name")" \
  --argjson media_bytes "$(file_bytes "$BACKUP_DIR/$media_name")" \
  --argjson rows "$counts" --argjson tables "$(jq '.tables' "$work/source.json")" \
  '{created_at: $created_at, engine: "postgresql", restore_verified: true,
    database: {key: ($prefix + "/" + $dump), sha256: $dump_sha, bytes: $dump_bytes, rows: $rows, tables: $tables},
    media: {key: ($prefix + "/" + $media), sha256: $media_sha, bytes: $media_bytes}}' \
  > "$BACKUP_DIR/$manifest_name"

if [[ "$LOCAL_ONLY" == 0 ]]; then
  for name in "$dump_name" "$media_name" "$manifest_name"; do
    aws s3 cp "$BACKUP_DIR/$name" "s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${name}" \
      --sse AES256 --only-show-errors
  done
fi
printf 'PostgreSQL backup %s verified by restore (%s tables).\n' "$stamp" "$(jq length <<<"$counts")"
