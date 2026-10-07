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
ensure_backup_directory "$BACKUP_DIR"
BACKUP_DIR="$(canonical_directory BACKUP_DIR "$BACKUP_DIR")"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_name="rewind-${stamp}.pgdump"
media_name="rewind-${stamp}.media.tar.gz"
manifest_name="rewind-${stamp}.postgres.json"
work="$(mktemp -d "$BACKUP_DIR/.postgres-backup.XXXXXX")"
verifier="rewind-backup-verify-${stamp,,}"
cleanup() {
  docker rm -f "$verifier" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

# Verify the server certificate with the CA bundle the runtime ships.
compose exec -T runtime cat /app/server/certs/rds-global-bundle.pem > "$work/ca.pem"
chmod 0644 "$work/ca.pem"
chmod 0755 "$work"

export PGURI="$REWIND_DATABASE_READONLY_URL"
docker run --rm -e PGURI -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/ca/ca.pem \
  -v "$work/ca.pem:/ca/ca.pem:ro" "$POSTGRES_IMAGE" \
  sh -c 'exec pg_dump --format=custom --no-owner --no-privileges --dbname="$PGURI"' \
  > "$BACKUP_DIR/$dump_name"
[[ -s "$BACKUP_DIR/$dump_name" ]] || die 'pg_dump produced an empty file.'

# Restore into a throwaway server and count every table.
docker run -d --name "$verifier" -e POSTGRES_PASSWORD=verify --tmpfs /var/lib/postgresql/data \
  "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$verifier" pg_isready -q -h 127.0.0.1 && break
  sleep 1
done
docker exec -i "$verifier" pg_restore --no-owner --no-privileges --exit-on-error \
  -h 127.0.0.1 -U postgres -d postgres < "$BACKUP_DIR/$dump_name"
counts="$(docker exec "$verifier" psql -h 127.0.0.1 -U postgres -d postgres -At -c "
  SELECT COALESCE(json_object_agg(t.schemaname || '.' || t.relname, t.n_live_tup), '{}')
  FROM (SELECT schemaname, relname,
          (xpath('/row/n/text()', query_to_xml(format('SELECT COUNT(*) AS n FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint AS n_live_tup
        FROM pg_stat_user_tables) t")"
[[ "$(jq 'length' <<<"$counts")" -gt 0 ]] || die 'The restored dump has no tables.'

archive_runtime_media "$BACKUP_DIR/$media_name"
for file in "$BACKUP_DIR/$dump_name" "$BACKUP_DIR/$media_name"; do
  assert_private_backup_file "$file" 'backup archive'
done
jq -n --arg created_at "$stamp" --arg prefix "$REWIND_BACKUP_PREFIX" \
  --arg dump "$dump_name" --arg dump_sha "$(sha256_file "$BACKUP_DIR/$dump_name")" \
  --argjson dump_bytes "$(file_bytes "$BACKUP_DIR/$dump_name")" \
  --arg media "$media_name" --arg media_sha "$(sha256_file "$BACKUP_DIR/$media_name")" \
  --argjson media_bytes "$(file_bytes "$BACKUP_DIR/$media_name")" \
  --argjson rows "$counts" \
  '{created_at: $created_at, engine: "postgresql", restore_verified: true,
    database: {key: ($prefix + "/" + $dump), sha256: $dump_sha, bytes: $dump_bytes, rows: $rows},
    media: {key: ($prefix + "/" + $media), sha256: $media_sha, bytes: $media_bytes}}' \
  > "$BACKUP_DIR/$manifest_name"

if [[ "$LOCAL_ONLY" == 0 ]]; then
  for name in "$dump_name" "$media_name" "$manifest_name"; do
    aws s3 cp "$BACKUP_DIR/$name" "s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${name}" \
      --sse AES256 --only-show-errors
  done
fi
printf 'PostgreSQL backup %s verified by restore (%s tables).\n' "$stamp" "$(jq length <<<"$counts")"
