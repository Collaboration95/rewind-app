#!/usr/bin/env bash
# Safe, testable recovery-point discovery and validation for wake-demo.sh.
#
# The caller must source operator-common.sh and backup-manifest.sh first, and
# provide BACKUP_AWS_PROFILE, BACKUP_BUCKET, and BACKUP_PREFIX. All AWS
# failures are converted to short operator-facing errors; AWS CLI diagnostics
# are intentionally not allowed to reach the terminal.

recovery_selection_reject() {
  printf 'ERROR: recovery point rejected: %s\n' "$1" >&2
  return 1
}

recovery_selection_validate_configuration() {
  validate_backup_prefix "$BACKUP_PREFIX" || return 1
  [[ -n "$BACKUP_BUCKET" && "$BACKUP_BUCKET" != */* && "$BACKUP_BUCKET" != *[[:space:]]* ]] || {
    recovery_selection_reject 'the approved backup bucket is invalid.'
    return 1
  }
}

recovery_remote_archive_sizes_match() {
  local database_size media_size

  if ! database_size="$(AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3api head-object \
    --bucket "$BACKUP_BUCKET" --key "$BACKUP_MANIFEST_DATABASE_KEY" \
    --query 'ContentLength' --output text 2>/dev/null)"; then
    recovery_selection_reject 'the selected database archive is not available.'
    return 1
  fi
  if ! media_size="$(AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3api head-object \
    --bucket "$BACKUP_BUCKET" --key "$BACKUP_MANIFEST_MEDIA_KEY" \
    --query 'ContentLength' --output text 2>/dev/null)"; then
    recovery_selection_reject 'the selected media archive is not available.'
    return 1
  fi
  [[ "$database_size" == "$BACKUP_MANIFEST_DATABASE_BYTES" && \
     "$media_size" == "$BACKUP_MANIFEST_MEDIA_BYTES" ]] || {
    recovery_selection_reject 'remote archive byte counts do not match the selected manifest.'
    return 1
  }
}

recovery_download_and_validate_candidate() {
  local candidate_uri="$1"
  local candidate_dir="$2"
  local candidate_name candidate_path database_path media_path

  validate_backup_manifest_uri "$candidate_uri" "$BACKUP_BUCKET" "$BACKUP_PREFIX" || return 1
  candidate_name="$BACKUP_MANIFEST_URI_NAME"
  candidate_path="$candidate_dir/$candidate_name"

  if ! mkdir -p -- "$candidate_dir"; then
    recovery_selection_reject 'the recovery point could not be staged locally.'
    return 1
  fi
  if ! AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3 cp "$candidate_uri" "$candidate_path" \
    --only-show-errors >/dev/null 2>&1; then
    recovery_selection_reject 'the recovery manifest could not be downloaded.'
    return 1
  fi
  validate_backup_manifest "$candidate_path" "$BACKUP_PREFIX" || return 1
  recovery_remote_archive_sizes_match || return 1

  database_path="$candidate_dir/$BACKUP_MANIFEST_DATABASE_NAME"
  media_path="$candidate_dir/$BACKUP_MANIFEST_MEDIA_NAME"
  if ! AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3 cp \
    "s3://$BACKUP_BUCKET/$BACKUP_MANIFEST_DATABASE_KEY" "$database_path" \
    --only-show-errors >/dev/null 2>&1; then
    recovery_selection_reject 'the selected database archive could not be downloaded.'
    return 1
  fi
  if ! AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3 cp \
    "s3://$BACKUP_BUCKET/$BACKUP_MANIFEST_MEDIA_KEY" "$media_path" \
    --only-show-errors >/dev/null 2>&1; then
    recovery_selection_reject 'the selected media archive could not be downloaded.'
    return 1
  fi
  verify_backup_manifest_archives "$candidate_dir" || return 1

  RECOVERY_CANDIDATE_URI="$candidate_uri"
  RECOVERY_CANDIDATE_DIR="$candidate_dir"
  RECOVERY_CANDIDATE_NAME="$candidate_name"
  RECOVERY_CANDIDATE_CREATED_AT="$BACKUP_MANIFEST_CREATED_AT"
}

recovery_use_candidate() {
  local candidate_uri="$1"
  local candidate_dir="$2"

  validate_backup_manifest_uri "$candidate_uri" "$BACKUP_BUCKET" "$BACKUP_PREFIX" || return 1
  validate_backup_manifest "$candidate_dir/$BACKUP_MANIFEST_URI_NAME" "$BACKUP_PREFIX" || return 1
  verify_backup_manifest_archives "$candidate_dir" || return 1

  RECOVERY_SELECTION_URI="$candidate_uri"
  RECOVERY_SELECTION_DIR="$candidate_dir"
  RECOVERY_SELECTION_MANIFEST_PATH="$candidate_dir/$BACKUP_MANIFEST_URI_NAME"
  RECOVERY_SELECTION_MANIFEST_NAME="$BACKUP_MANIFEST_URI_NAME"
  RECOVERY_SELECTION_DATABASE_NAME="$BACKUP_MANIFEST_DATABASE_NAME"
  RECOVERY_SELECTION_MEDIA_NAME="$BACKUP_MANIFEST_MEDIA_NAME"
}

recovery_select_explicit() {
  local manifest_uri="$1"
  local stage_root="$2"
  local candidate_dir="$stage_root/selected"

  recovery_selection_validate_configuration || return 1
  recovery_download_and_validate_candidate "$manifest_uri" "$candidate_dir" || {
    rm -rf -- "$candidate_dir"
    return 1
  }
  recovery_use_candidate "$manifest_uri" "$candidate_dir"
}

recovery_select_latest() {
  local stage_root="$1"
  local listing candidate_keys candidate_key candidate_uri candidate_dir
  local candidate_index=0 best_uri='' best_dir='' best_created_at=''

  recovery_selection_validate_configuration || return 1
  if ! listing="$(AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3api list-objects-v2 \
    --bucket "$BACKUP_BUCKET" --prefix "${BACKUP_PREFIX}/" --output json 2>/dev/null)"; then
    recovery_selection_reject 'recovery manifests could not be listed from the approved backup location.'
    return 1
  fi
  if ! candidate_keys="$(jq -r '
    [(.Contents // [])[]
      | select((.Key? | type) == "string")
      | .Key
      | select(endswith(".manifest.json"))]
    | .[]
  ' <<<"$listing" | LC_ALL=C sort)"; then
    recovery_selection_reject 'the recovery manifest listing was not valid JSON.'
    return 1
  fi

  while IFS= read -r candidate_key; do
    [[ -n "$candidate_key" ]] || continue
    candidate_index=$((candidate_index + 1))
    candidate_uri="s3://$BACKUP_BUCKET/$candidate_key"
    candidate_dir="$stage_root/candidates/$(printf '%04d' "$candidate_index")"

    # A latest search is intentionally exhaustive. A newer malformed,
    # incomplete, or checksum-invalid point must not hide an older valid one.
    if recovery_download_and_validate_candidate "$candidate_uri" "$candidate_dir" \
      >/dev/null 2>&1; then
      if [[ -z "$best_created_at" || "$RECOVERY_CANDIDATE_CREATED_AT" > "$best_created_at" ]]; then
        [[ -z "$best_dir" ]] || rm -rf -- "$best_dir"
        best_uri="$RECOVERY_CANDIDATE_URI"
        best_dir="$RECOVERY_CANDIDATE_DIR"
        best_created_at="$RECOVERY_CANDIDATE_CREATED_AT"
      else
        rm -rf -- "$candidate_dir"
      fi
    else
      rm -rf -- "$candidate_dir"
    fi
  done <<<"$candidate_keys"

  [[ -n "$best_uri" ]] || {
    recovery_selection_reject 'no complete valid recovery point exists; check manifest schema, approved bucket/prefix, archive presence, byte counts, and checksums.'
    return 1
  }
  recovery_use_candidate "$best_uri" "$best_dir"
}
