#!/usr/bin/env bash
# Shared strict validation for the database/media backup manifest contract.
#
# The caller must source operator-common.sh first. Validation deliberately
# reports only contract failures; it never prints manifest contents, bucket
# names, credentials, or local paths.

backup_manifest_reject() {
  printf 'ERROR: backup manifest rejected: %s\n' "$1" >&2
  return 1
}

validate_backup_prefix() {
  local prefix="${1:-}"

  [[ -n "$prefix" ]] || { backup_manifest_reject 'backup prefix must not be empty.'; return 1; }
  [[ "$prefix" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || {
    backup_manifest_reject 'backup prefix contains unsupported characters.'
    return 1
  }
  [[ "$prefix" != */ && "$prefix" != *//* && "$prefix" != *..* ]] || {
    backup_manifest_reject 'backup prefix must not contain empty or parent-directory components.'
    return 1
  }
  [[ "$prefix" != */.* && "$prefix" != .* && "$prefix" != *. ]] || {
    backup_manifest_reject 'backup prefix must not contain hidden or dot-directory components.'
    return 1
  }
}

validate_backup_manifest_uri() {
  local uri="${1:-}"
  local expected_bucket="${2:-}"
  local expected_prefix="${3:-}"
  local uri_without_scheme manifest_bucket manifest_key manifest_name

  validate_backup_prefix "$expected_prefix" || return
  [[ -n "$expected_bucket" && "$expected_bucket" != */* && "$expected_bucket" != *[[:space:]]* ]] || {
    backup_manifest_reject 'approved backup bucket is invalid.'
    return 1
  }
  [[ "$uri" == s3://*/* ]] || {
    backup_manifest_reject 'manifest URI must be an s3:// object URI.'
    return 1
  }

  uri_without_scheme="${uri#s3://}"
  manifest_bucket="${uri_without_scheme%%/*}"
  manifest_key="${uri_without_scheme#*/}"
  [[ "$manifest_bucket" == "$expected_bucket" ]] || {
    backup_manifest_reject 'manifest URI uses an unapproved backup bucket.'
    return 1
  }
  [[ "$manifest_key" == "$expected_prefix/"* ]] || {
    backup_manifest_reject 'manifest URI is outside the approved backup prefix.'
    return 1
  }
  [[ "$manifest_key" != *..* && "$manifest_key" != *[[:space:]]* ]] || {
    backup_manifest_reject 'manifest URI contains an unsafe object key.'
    return 1
  }

  manifest_name="${manifest_key##*/}"
  [[ "$manifest_name" =~ ^rewind-[0-9]{8}T[0-9]{6}Z\.manifest\.json$ ]] || {
    backup_manifest_reject 'manifest URI filename must use the generated timestamp format.'
    return 1
  }

  BACKUP_MANIFEST_URI_BUCKET="$manifest_bucket"
  BACKUP_MANIFEST_URI_KEY="$manifest_key"
  BACKUP_MANIFEST_URI_NAME="$manifest_name"
}

validate_backup_manifest() {
  local manifest_path="${1:-}"
  local expected_prefix="${2:-}"
  local manifest_name manifest_stem manifest_timestamp
  local manifest_fields created_at database_key database_sha256 database_bytes
  local media_key media_sha256 media_bytes created_epoch validation_now max_age future_skew

  command -v jq >/dev/null 2>&1 || {
    backup_manifest_reject 'jq is required to validate manifests.'
    return 1
  }
  validate_backup_prefix "$expected_prefix" || return

  manifest_name="${manifest_path##*/}"
  [[ "$manifest_name" =~ ^(rewind-[0-9]{8}T[0-9]{6}Z)\.manifest\.json$ ]] || {
    backup_manifest_reject 'manifest filename must be rewind-<timestamp>.manifest.json.'
    return 1
  }
  manifest_stem="${BASH_REMATCH[1]}"
  manifest_timestamp="${manifest_stem#rewind-}"

  if ! jq -e '
    try (
      (type == "object") and
      ((keys | sort) == ["created_at", "database", "media"]) and
      ((.created_at | type) == "string") and
      ((.database | type) == "object") and
      ((.media | type) == "object") and
      ((.database | keys | sort) == ["bytes", "key", "sha256"]) and
      ((.media | keys | sort) == ["bytes", "key", "sha256"]) and
      ((.database.key | type) == "string") and
      ((.database.sha256 | type) == "string") and
      ((.database.bytes | type) == "number") and
      (.database.bytes == (.database.bytes | floor)) and
      (.database.bytes >= 0) and
      (.database.bytes <= 9007199254740991) and
      ((.media.key | type) == "string") and
      ((.media.sha256 | type) == "string") and
      ((.media.bytes | type) == "number") and
      (.media.bytes == (.media.bytes | floor)) and
      (.media.bytes >= 0) and
      (.media.bytes <= 9007199254740991) and
      (.database.sha256 | test("^[0-9A-Fa-f]{64}$")) and
      (.media.sha256 | test("^[0-9A-Fa-f]{64}$"))
    ) catch false
  ' "$manifest_path" >/dev/null 2>&1; then
    backup_manifest_reject 'manifest must be valid JSON with exactly the created_at, database, and media records; each record needs an integer byte count and SHA-256 checksum.'
    return 1
  fi

  if ! manifest_fields="$(jq -er '[.created_at, .database.key, .database.sha256, (.database.bytes | tostring), .media.key, .media.sha256, (.media.bytes | tostring)] | @tsv' "$manifest_path" 2>/dev/null)"; then
    backup_manifest_reject 'manifest fields could not be read safely.'
    return 1
  fi
  IFS=$'\t' read -r created_at database_key database_sha256 database_bytes media_key media_sha256 media_bytes <<<"$manifest_fields"

  [[ "$created_at" == "$manifest_timestamp" ]] || {
    backup_manifest_reject 'created_at must match the manifest filename timestamp.'
    return 1
  }
  [[ "$created_at" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
    backup_manifest_reject 'created_at must use the UTC timestamp format.'
    return 1
  }
  [[ "$database_key" == "$expected_prefix/$manifest_stem.sqlite.gz" && \
     "$media_key" == "$expected_prefix/$manifest_stem.media.tar.gz" ]] || {
    backup_manifest_reject 'database and media keys must match the manifest filename and approved prefix.'
    return 1
  }
  [[ "$database_sha256" =~ ^[0-9A-Fa-f]{64}$ && "$media_sha256" =~ ^[0-9A-Fa-f]{64}$ ]] || {
    backup_manifest_reject 'database and media checksums must be 64 hexadecimal characters.'
    return 1
  }
  [[ "$database_bytes" =~ ^[0-9]+$ && "$media_bytes" =~ ^[0-9]+$ ]] || {
    backup_manifest_reject 'database and media byte counts must be non-negative integers.'
    return 1
  }

  created_epoch="$(jq -nr --arg timestamp "$created_at" 'try ($timestamp | strptime("%Y%m%dT%H%M%SZ") | mktime) catch empty' 2>/dev/null)"
  [[ "$created_epoch" =~ ^[0-9]+$ ]] || {
    backup_manifest_reject 'created_at is not a real UTC timestamp.'
    return 1
  }

  validation_now="${BACKUP_VALIDATION_NOW:-$(date -u +%s)}"
  max_age="${BACKUP_MAX_AGE_SECONDS:-604800}"
  future_skew="${BACKUP_TIMESTAMP_FUTURE_SKEW_SECONDS:-300}"
  [[ "$validation_now" =~ ^[0-9]+$ && "$max_age" =~ ^[0-9]+$ && "$future_skew" =~ ^[0-9]+$ ]] || {
    backup_manifest_reject 'manifest timestamp validation settings must be non-negative integers.'
    return 1
  }
  (( created_epoch <= validation_now + future_skew )) || {
    backup_manifest_reject 'manifest timestamp is too far in the future.'
    return 1
  }
  (( validation_now - created_epoch <= max_age )) || {
    backup_manifest_reject 'manifest timestamp is stale; create or select a newer recovery point.'
    return 1
  }

  BACKUP_MANIFEST_CREATED_AT="$created_at"
  BACKUP_MANIFEST_STEM="$manifest_stem"
  BACKUP_MANIFEST_DATABASE_KEY="$database_key"
  BACKUP_MANIFEST_DATABASE_NAME="${database_key##*/}"
  BACKUP_MANIFEST_DATABASE_SHA256="$(printf '%s' "$database_sha256" | tr '[:upper:]' '[:lower:]')"
  BACKUP_MANIFEST_DATABASE_BYTES="$database_bytes"
  BACKUP_MANIFEST_MEDIA_KEY="$media_key"
  BACKUP_MANIFEST_MEDIA_NAME="${media_key##*/}"
  BACKUP_MANIFEST_MEDIA_SHA256="$(printf '%s' "$media_sha256" | tr '[:upper:]' '[:lower:]')"
  BACKUP_MANIFEST_MEDIA_BYTES="$media_bytes"
}

verify_backup_manifest_archives() {
  local archive_dir="${1:-}"
  local database_archive media_archive
  local database_bytes media_bytes database_sha256 media_sha256

  database_archive="$archive_dir/$BACKUP_MANIFEST_DATABASE_NAME"
  media_archive="$archive_dir/$BACKUP_MANIFEST_MEDIA_NAME"
  [[ -f "$database_archive" && ! -L "$database_archive" ]] || {
    backup_manifest_reject 'the manifest database archive is missing.'
    return 1
  }
  [[ -f "$media_archive" && ! -L "$media_archive" ]] || {
    backup_manifest_reject 'the manifest media archive is missing.'
    return 1
  }

  database_bytes="$(file_bytes "$database_archive")"
  media_bytes="$(file_bytes "$media_archive")"
  [[ "$database_bytes" == "$BACKUP_MANIFEST_DATABASE_BYTES" ]] || {
    backup_manifest_reject 'database archive byte count does not match the manifest.'
    return 1
  }
  [[ "$media_bytes" == "$BACKUP_MANIFEST_MEDIA_BYTES" ]] || {
    backup_manifest_reject 'media archive byte count does not match the manifest.'
    return 1
  }

  database_sha256="$(sha256_file "$database_archive")"
  media_sha256="$(sha256_file "$media_archive")"
  [[ "$database_sha256" == "$BACKUP_MANIFEST_DATABASE_SHA256" ]] || {
    backup_manifest_reject 'database archive checksum does not match the manifest.'
    return 1
  }
  [[ "$media_sha256" == "$BACKUP_MANIFEST_MEDIA_SHA256" ]] || {
    backup_manifest_reject 'media archive checksum does not match the manifest.'
    return 1
  }
}
