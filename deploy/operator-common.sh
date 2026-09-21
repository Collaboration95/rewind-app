#!/usr/bin/env bash
# Shared guards for the host-side deployment operator workflows.

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

require_absolute_path() {
  local label="$1"
  local path="$2"
  [[ "$path" == /* ]] || die "$label must be an absolute path: $path"
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* ]] || die "$label contains a newline: $path"
}

require_safe_mutable_path() {
  local label="$1"
  local path="$2"
  require_absolute_path "$label" "$path"
  case "$path" in
    */../*|*/..|../*|..)
      die "$label must not contain a parent-directory component: $path"
      ;;
  esac
  case "$path" in
    /|/tmp|/var|/srv|/home|/Users|/etc|/usr|/opt|/srv/rewind)
      die "$label is too broad for an operator workflow: $path"
      ;;
  esac
}

require_directory() {
  local label="$1"
  local path="$2"
  [[ -d "$path" && ! -L "$path" ]] || die "$label must be an existing, non-symlink directory: $path"
}

canonical_directory() {
  local label="$1"
  local path="$2"
  require_directory "$label" "$path"
  (cd -- "$path" && pwd -P) || die "Could not resolve $label: $path"
}

require_regular_file() {
  local label="$1"
  local path="$2"
  [[ -f "$path" && ! -L "$path" ]] || die "$label must be an existing, non-symlink file: $path"
}

ensure_distinct_paths() {
  local first_label="$1"
  local first="$2"
  local second_label="$3"
  local second="$4"
  [[ "$first" != "$second" ]] || die "$first_label and $second_label must be different paths."
  [[ "$first" != "$second"/* && "$second" != "$first"/* ]] || \
    die "$first_label and $second_label must not contain one another."
}

ensure_backup_directory() {
  local path="$1"
  require_safe_mutable_path "BACKUP_DIR" "$path"
  if [[ -e "$path" ]]; then
    require_directory "BACKUP_DIR" "$path"
  else
    local parent
    parent="${path%/*}"
    [[ -n "$parent" && "$parent" != "$path" ]] || die "BACKUP_DIR has no safe parent: $path"
    require_directory "BACKUP_DIR parent" "$parent"
    mkdir -- "$path"
  fi
}

compose() {
  REWIND_DATA_HOST_DIR="$DATA_DIR" REWIND_MEDIA_HOST_DIR="$MEDIA_DIR" \
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

runtime_uid() {
  printf '%s' "${RUNTIME_UID:-10001}"
}

runtime_gid() {
  printf '%s' "${RUNTIME_GID:-10001}"
}

persistent_contract_failure() {
  # Never include the host path, numeric identity, or environment value in this
  # diagnostic. Operators need the failed contract, not host-specific details.
  printf 'ERROR: persistent ownership contract failed (%s).\n' "$1" >&2
  return 1
}

portable_stat() {
  local format="$1"
  local path="$2"
  if stat -c "$format" -- "$path" >/dev/null 2>&1; then
    stat -c "$format" -- "$path"
  else
    case "$format" in
      '%u:%g:%a') stat -f '%u:%g:%Lp' -- "$path" ;;
      '%a') stat -f '%Lp' -- "$path" ;;
      *) return 1 ;;
    esac
  fi
}

validate_runtime_identity() {
  [[ "$(runtime_uid)" =~ ^[0-9]+$ && "$(runtime_gid)" =~ ^[0-9]+$ ]] || \
    persistent_contract_failure 'runtime identity is not numeric'
}

assert_persistent_tree_contract() {
  local root="$1"
  local label="$2"
  local excluded_root="${3:-}"
  local entry actual expected_mode

  validate_runtime_identity || return 1
  [[ -d "$root" && ! -L "$root" ]] || {
    persistent_contract_failure "$label root is not a directory"
    return 1
  }

  # Restore archives may not introduce symlinks, devices, FIFOs, or other
  # entries whose ownership/mode semantics differ from the runtime contract.
  local unsupported
  if [[ -n "$excluded_root" ]]; then
    unsupported="$(find "$root" -path "$excluded_root" -prune -o ! -type d ! -type f -print -quit 2>/dev/null || true)"
  else
    unsupported="$(find "$root" ! -type d ! -type f -print -quit 2>/dev/null || true)"
  fi
  if [[ -n "$unsupported" ]]; then
    persistent_contract_failure "$label contains an unsupported entry"
    return 1
  fi

  while IFS= read -r -d '' entry; do
    if [[ -d "$entry" ]]; then
      expected_mode=750
    else
      expected_mode=640
    fi
    actual="$(portable_stat '%u:%g:%a' "$entry" 2>/dev/null || true)"
    case "$actual" in
      "$(runtime_uid)":*:"$expected_mode") ;;
      *)
        persistent_contract_failure "$label has an unexpected owner or mode"
        return 1
        ;;
    esac
  done < <(
    if [[ -n "$excluded_root" ]]; then
      find "$root" -path "$excluded_root" -prune -o -print0 2>/dev/null
    else
      find "$root" -print0 2>/dev/null
    fi
  )
}

prepare_persistent_tree() {
  local root="$1"
  local label="$2"
  local entry

  validate_runtime_identity || return 1
  [[ -d "$root" && ! -L "$root" ]] || {
    persistent_contract_failure "$label root is not a directory"
    return 1
  }
  local unsupported
  unsupported="$(find "$root" ! -type d ! -type f -print -quit 2>/dev/null || true)"
  if [[ -n "$unsupported" ]]; then
    persistent_contract_failure "$label contains an unsupported entry"
    return 1
  fi

  run_privileged chown -R "$(runtime_uid):$(runtime_gid)" "$root" || return 1
  while IFS= read -r -d '' entry; do
    if [[ -d "$entry" ]]; then
      run_privileged chmod 0750 "$entry" || return 1
    else
      run_privileged chmod 0640 "$entry" || return 1
    fi
  done < <(find "$root" -print0 2>/dev/null)
  assert_persistent_tree_contract "$root" "$label"
}

assert_persistent_file_contract() {
  local file="$1"
  local label="$2"
  local actual

  validate_runtime_identity || return 1
  [[ -f "$file" && ! -L "$file" ]] || {
    persistent_contract_failure "$label is not a regular file"
    return 1
  }
  actual="$(portable_stat '%u:%g:%a' "$file" 2>/dev/null || true)"
  case "$actual" in
    "$(runtime_uid)":*:640) ;;
    *)
      persistent_contract_failure "$label has an unexpected owner or mode"
      return 1
      ;;
  esac
}

assert_private_backup_file() {
  local file="$1"
  local label="$2"
  local mode

  [[ -f "$file" && ! -L "$file" ]] || {
    persistent_contract_failure "$label is not a regular file"
    return 1
  }
  mode="$(portable_stat '%a' "$file" 2>/dev/null || true)"
  [[ "$mode" == 600 ]] || {
    persistent_contract_failure "$label is not private"
    return 1
  }
}

archive_runtime_media() {
  local archive_path="$1"
  local container_id

  container_id="$(compose ps -q runtime 2>/dev/null | awk 'NF { print; exit }' || true)"
  if [[ -z "$container_id" ]]; then
    persistent_contract_failure 'runtime is unavailable for media archive'
    return 1
  fi

  # docker cp asks the approved Docker operator to stream the runtime-owned
  # tree through the daemon. The host operator never needs world-readable media
  # files or a second ownership model; the archive itself is created private by
  # the caller's umask.
  docker cp "$container_id:/var/lib/rewind/media/." - | gzip -9 > "$archive_path" || \
    persistent_contract_failure 'runtime media archive failed'
  chmod 0600 "$archive_path" || {
    persistent_contract_failure 'runtime media archive could not be protected'
    return 1
  }
  assert_private_backup_file "$archive_path" 'media backup archive'
}

run_privileged() {
  if [[ "$(id -u)" == 0 ]]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

run_as_runtime() {
  local runtime_uid="${RUNTIME_UID:?RUNTIME_UID must be set}"
  local runtime_user="${RUNTIME_USER:-rewind}"
  if [[ "$(id -u)" == "$runtime_uid" ]]; then
    "$@"
  elif [[ "$(id -u)" == 0 ]] && command -v runuser >/dev/null 2>&1; then
    runuser -u "$runtime_user" -- "$@"
  else
    sudo -n -u "#$runtime_uid" -- "$@"
  fi
}

move_path_if_present() {
  local source_path="$1"
  local destination_dir="$2"
  if [[ -e "$source_path" || -L "$source_path" ]]; then
    mv -- "$source_path" "$destination_dir/"
  fi
}

move_children() {
  local source_dir="$1"
  local destination_dir="$2"
  local child

  while IFS= read -r -d '' child; do
    mv -- "$child" "$destination_dir/" || return 1
  done < <(find "$source_dir" -mindepth 1 -maxdepth 1 -print0)
  [[ -z "$(find "$source_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]
}

remove_children() {
  local directory="$1"
  find "$directory" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || return 1
  [[ -z "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)" ]]
}

directory_empty() {
  [[ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]]
}

prepare_restore_tree() {
  local path="$1"
  local label="${2:-restored persistent data}"

  if [[ -d "$path" && ! -L "$path" ]]; then
    prepare_persistent_tree "$path" "$label"
  elif [[ -f "$path" && ! -L "$path" ]]; then
    validate_runtime_identity || return 1
    run_privileged chown "$(runtime_uid):$(runtime_gid)" "$path" || return 1
    run_privileged chmod 0640 "$path" || return 1
    assert_persistent_file_contract "$path" "$label"
  else
    persistent_contract_failure "$label is not a supported file or directory"
    return 1
  fi
}

wait_for_runtime_readiness() {
  local timeout_seconds="${RESTORE_READINESS_TIMEOUT_SECONDS:-60}"
  local started_at deadline container_id health_status
  [[ "$timeout_seconds" =~ ^[0-9]+$ ]] || {
    printf 'ERROR: RESTORE_READINESS_TIMEOUT_SECONDS must be a non-negative integer.\n' >&2
    return 1
  }

  started_at="$(date +%s)"
  deadline=$((started_at + timeout_seconds))
  while (( "$(date +%s)" <= deadline )); do
    container_id="$(compose ps -q runtime 2>/dev/null | awk 'NF { print; exit }' || true)"
    if [[ -n "$container_id" ]]; then
      health_status="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
      case "$health_status" in
        healthy)
          return 0
          ;;
        unhealthy|dead|exited)
          printf 'ERROR: restored runtime readiness failed (%s).\n' "$health_status" >&2
          return 1
          ;;
      esac
    fi
    sleep 1
  done

  printf 'ERROR: restored runtime did not become healthy within the readiness window.\n' >&2
  return 1
}

require_compose_prerequisites() {
  require_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose is required."
  require_regular_file "ENV_FILE" "$ENV_FILE"
  require_regular_file "COMPOSE_FILE" "$COMPOSE_FILE"
  compose config --quiet >/dev/null || die "Docker Compose configuration is invalid."
}

require_runtime_running() {
  local services
  services="$(compose ps --status running --services 2>/dev/null || true)"
  grep -Fxq 'runtime' <<<"$services" || die "The runtime container must be running so backup.sh can take an online SQLite snapshot."
}

require_confirmation() {
  local expected="$1"
  local received="${2:-}"
  [[ "$received" == "$expected" ]] || die "Refusing this destructive workflow. Re-run with $expected after reviewing the runbook."
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$path" | awk '{print $1}'
  else
    die "sha256sum or shasum is required."
  fi
}

file_bytes() {
  wc -c < "$1" | tr -d '[:space:]'
}
