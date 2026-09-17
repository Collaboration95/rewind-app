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
