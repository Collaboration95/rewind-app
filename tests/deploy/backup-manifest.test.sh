#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rewind-manifest-test.XXXXXX")"
cleanup() {
  rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/deploy/operator-common.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/deploy/backup-manifest.sh"

PREFIX='rewind-demo'
export BACKUP_MAX_AGE_SECONDS=604800
export BACKUP_TIMESTAMP_FUTURE_SKEW_SECONDS=300
NOW_EPOCH="$(date -u +%s)"
export BACKUP_VALIDATION_NOW="$NOW_EPOCH"

epoch_stamp() {
  local epoch="$1"
  date -u -r "$epoch" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -d "@$epoch" +%Y%m%dT%H%M%SZ
}

NOW_STAMP="$(epoch_stamp "$NOW_EPOCH")"
DB_NAME="rewind-${NOW_STAMP}.sqlite.gz"
MEDIA_NAME="rewind-${NOW_STAMP}.media.tar.gz"
MANIFEST_NAME="rewind-${NOW_STAMP}.manifest.json"
printf 'database archive fixture\n' > "$TEST_DIR/$DB_NAME"
printf 'media archive fixture\n' > "$TEST_DIR/$MEDIA_NAME"
DB_SHA256="$(sha256_file "$TEST_DIR/$DB_NAME")"
MEDIA_SHA256="$(sha256_file "$TEST_DIR/$MEDIA_NAME")"
DB_BYTES="$(file_bytes "$TEST_DIR/$DB_NAME")"
MEDIA_BYTES="$(file_bytes "$TEST_DIR/$MEDIA_NAME")"

write_manifest() {
  local path="$1"
  local created_at="${2:-$NOW_STAMP}"
  local database_key="${3:-$PREFIX/$DB_NAME}"
  local media_key="${4:-$PREFIX/$MEDIA_NAME}"
  local database_sha256="${5:-$DB_SHA256}"
  local media_sha256="${6:-$MEDIA_SHA256}"
  local database_bytes="${7:-$DB_BYTES}"
  local media_bytes="${8:-$MEDIA_BYTES}"
  printf '{"created_at":"%s","database":{"key":"%s","sha256":"%s","bytes":%s},"media":{"key":"%s","sha256":"%s","bytes":%s}}\n' \
    "$created_at" "$database_key" "$database_sha256" "$database_bytes" \
    "$media_key" "$media_sha256" "$media_bytes" > "$path"
}

assert_valid() {
  local path="$1"
  validate_backup_manifest "$path" "$PREFIX"
  verify_backup_manifest_archives "$TEST_DIR"
}

assert_rejected() {
  local path="$1"
  local expected="$2"
  local output
  if output="$(validate_backup_manifest "$path" "$PREFIX" 2>&1)"; then
    printf 'Expected manifest rejection: %s\n' "$path" >&2
    exit 1
  fi
  [[ "$output" == *"$expected"* ]] || {
    printf 'Expected error containing %s, got: %s\n' "$expected" "$output" >&2
    exit 1
  }
}

assert_uri_rejected() {
  local uri="$1"
  local expected="$2"
  local output
  if output="$(validate_backup_manifest_uri "$uri" 'rewind-demo-backups-123' "$PREFIX" 2>&1)"; then
    printf 'Expected URI rejection: %s\n' "$uri" >&2
    exit 1
  fi
  [[ "$output" == *"$expected"* ]] || {
    printf 'Expected URI error containing %s, got: %s\n' "$expected" "$output" >&2
    exit 1
  }
}

VALID_MANIFEST="$TEST_DIR/$MANIFEST_NAME"
write_manifest "$VALID_MANIFEST"
assert_valid "$VALID_MANIFEST"

printf '{not-json}\n' > "$TEST_DIR/$MANIFEST_NAME"
assert_rejected "$TEST_DIR/$MANIFEST_NAME" 'valid JSON with exactly the created_at, database, and media records'

printf '{"created_at":"%s","database":{}}\n' "$NOW_STAMP" > "$TEST_DIR/$MANIFEST_NAME"
assert_rejected "$TEST_DIR/$MANIFEST_NAME" 'exactly the created_at, database, and media records'

write_manifest "$TEST_DIR/$MANIFEST_NAME" "$NOW_STAMP" 'rewind-demo/../escape.sqlite.gz'
assert_rejected "$TEST_DIR/$MANIFEST_NAME" 'approved prefix'

write_manifest "$TEST_DIR/$MANIFEST_NAME" "$NOW_STAMP" 'other-prefix/rewind-'"$NOW_STAMP"'.sqlite.gz'
assert_rejected "$TEST_DIR/$MANIFEST_NAME" 'approved prefix'

write_manifest "$TEST_DIR/$MANIFEST_NAME" "$NOW_STAMP" "$PREFIX/rewind-other.sqlite.gz"
assert_rejected "$TEST_DIR/$MANIFEST_NAME" 'approved prefix'

write_manifest "$TEST_DIR/$MANIFEST_NAME" "$NOW_STAMP" "$PREFIX/$DB_NAME" "$PREFIX/$MEDIA_NAME" 'bad-checksum' "$MEDIA_SHA256"
assert_rejected "$TEST_DIR/$MANIFEST_NAME" 'integer byte count and SHA-256 checksum'

STALE_MANIFEST="$TEST_DIR/rewind-20200101T000000Z.manifest.json"
write_manifest "$STALE_MANIFEST" "20200101T000000Z" "$PREFIX/rewind-20200101T000000Z.sqlite.gz" "$PREFIX/rewind-20200101T000000Z.media.tar.gz"
assert_rejected "$STALE_MANIFEST" 'stale'

FUTURE_STAMP="$(epoch_stamp "$((NOW_EPOCH + 3600))")"
FUTURE_MANIFEST="$TEST_DIR/rewind-${FUTURE_STAMP}.manifest.json"
write_manifest "$FUTURE_MANIFEST" "$FUTURE_STAMP" "$PREFIX/rewind-${FUTURE_STAMP}.sqlite.gz" "$PREFIX/rewind-${FUTURE_STAMP}.media.tar.gz"
assert_rejected "$FUTURE_MANIFEST" 'future'

printf '{"created_at":"%s","database":{"key":"%s","sha256":"%s","bytes":%s},"media":{"key":"%s","sha256":"%s","bytes":%s}}\n' \
  "$NOW_STAMP" "$PREFIX/$DB_NAME" "$DB_SHA256" "$DB_BYTES" "$PREFIX/$MEDIA_NAME" "$MEDIA_SHA256" 'not-a-number' > "$TEST_DIR/$MANIFEST_NAME"
assert_rejected "$TEST_DIR/$MANIFEST_NAME" 'integer byte count'

write_manifest "$TEST_DIR/$MANIFEST_NAME" "$NOW_STAMP" "$PREFIX/$DB_NAME" "$PREFIX/$MEDIA_NAME" "$DB_SHA256" "$MEDIA_SHA256" "$((DB_BYTES + 1))" "$MEDIA_BYTES"
validate_backup_manifest "$TEST_DIR/$MANIFEST_NAME" "$PREFIX"
if verify_backup_manifest_archives "$TEST_DIR" 2>/dev/null; then
  printf 'Expected database byte mismatch rejection.\n' >&2
  exit 1
fi

write_manifest "$VALID_MANIFEST"
validate_backup_manifest "$VALID_MANIFEST" "$PREFIX"
printf 'changed-content\n' > "$TEST_DIR/$DB_NAME"
if verify_backup_manifest_archives "$TEST_DIR" 2>/dev/null; then
  printf 'Expected database checksum rejection.\n' >&2
  exit 1
fi

assert_uri_rejected 's3://other-bucket/rewind-demo/rewind-'"$NOW_STAMP"'.manifest.json' 'unapproved backup bucket'
assert_uri_rejected 's3://rewind-demo-backups-123/other/rewind-'"$NOW_STAMP"'.manifest.json' 'approved backup prefix'
assert_uri_rejected 's3://rewind-demo-backups-123/rewind-demo/../rewind-'"$NOW_STAMP"'.manifest.json' 'unsafe object key'
assert_uri_rejected 's3://rewind-demo-backups-123/rewind-demo/not-a-manifest.json' 'timestamp format'

printf 'backup manifest tests passed\n'
