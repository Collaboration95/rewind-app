#!/usr/bin/env bash
# Stage a verified image pair; publish release pointers only after both services
# pass health. The prior bundle remains available for compatible rollback.
set -Eeuo pipefail
HOST_ROOT="${REWIND_HOST_ROOT:-/srv/rewind}"
RELEASES="$HOST_ROOT/releases"
RELEASE_PY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/release.py"

die() { printf 'Release rejected: %s\n' "$*" >&2; exit 1; }
valid_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
[[ $# -ge 1 ]] || die 'usage: release-host.sh prepare BUNDLE | promote | install BUNDLE | rollback | prune'

# Keep only the current, previous (rollback) and pending releases. Older
# release folders and their image pairs are what filled the host disk.
prune_releases() {
  local keep="" pointer dir sha
  for pointer in current-release previous-release pending-release; do
    [[ -f "$HOST_ROOT/$pointer" ]] && keep="$keep $(cat "$HOST_ROOT/$pointer")"
  done
  [[ -d "$RELEASES" ]] || return 0
  for dir in "$RELEASES"/*/; do
    sha="$(basename -- "$dir")"
    valid_sha "$sha" || continue
    [[ " $keep " == *" $sha "* ]] && continue
    rm -rf -- "$RELEASES/$sha"
    docker image rm "rewind-demo:$sha" "rewind-demo-web:$sha" >/dev/null 2>&1 || true
  done
  docker image prune -f >/dev/null 2>&1 || true
}

# Staging briefly holds several copies of the bundle; refuse early with a clear
# message instead of failing mid-copy with ENOSPC.
require_disk_for() {
  local bundle="$1" need avail
  need=$(( $(wc -c < "$bundle") * 4 ))
  avail="$(df --output=avail -B1 "$HOST_ROOT" 2>/dev/null | tail -n 1 | tr -d ' ' || true)"
  [[ "$avail" =~ ^[0-9]+$ ]] || return 0
  (( avail >= need )) || die "insufficient disk: $(( avail / 1048576 )) MiB free, need about $(( need / 1048576 )) MiB"
}

stage_bundle() {
  local bundle="$1" stage sha
  [[ -f "$bundle" ]] || die 'bundle file is missing'
  prune_releases
  require_disk_for "$bundle"
  stage="$(mktemp -d "$HOST_ROOT/.release-stage.XXXXXX")"
  sha="$(python3 "$RELEASE_PY" verify "$bundle" --extract "$stage/verified")" || {
    rm -rf -- "$stage"
    die 'bundle verification failed'
  }
  valid_sha "$sha" || die 'invalid release SHA'
  mkdir -p "$RELEASES"
  if [[ -e "$RELEASES/$sha" ]]; then
    rm -rf -- "$stage"
    [[ -f "$RELEASES/$sha/bundle.tar" && "$(sha256sum "$bundle" | cut -d ' ' -f 1)" == "$(sha256sum "$RELEASES/$sha/bundle.tar" | cut -d ' ' -f 1)" ]] || die 'installed SHA has a different artifact'
    printf '%s\n' "$sha"
    return
  fi
  mv "$stage/verified" "$RELEASES/$sha"
  cp "$bundle" "$RELEASES/$sha/bundle.tar"
  rm -rf -- "$stage"
  printf '%s\n' "$sha"
}

check_candidate() {
  local sha="$1" manifest version schema current_schema
  valid_sha "$sha" && [[ -d "$RELEASES/$sha" ]] || die 'release is missing'
  manifest="$RELEASES/$sha/manifest.json"
  version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["config_version"])' "$manifest")"
  schema="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["schema_version"])' "$manifest")"
  if [[ -f "$HOST_ROOT/release-config-version" ]]; then
    [[ "$(cat "$HOST_ROOT/release-config-version")" == "$version" ]] || die 'configuration version differs; review private config compatibility first'
  fi
  if [[ -f "$HOST_ROOT/release-config-digest" ]]; then
    [[ "$(sha256sum "$HOST_ROOT/rewind.env" | cut -d ' ' -f 1)" == "$(cat "$HOST_ROOT/release-config-digest")" ]] || die 'private configuration revision changed; review before activating a release'
  fi
  if [[ -f "$HOST_ROOT/data/rewind.sqlite" ]]; then
    current_schema="$(sudo sqlite3 -readonly "$HOST_ROOT/data/rewind.sqlite" 'SELECT COALESCE(MAX(version),0) FROM schema_migrations;' 2>/dev/null)" || die 'cannot inspect database schema'
    [[ "$current_schema" =~ ^[0-9]+$ && "$current_schema" -le "$schema" ]] || die 'database schema is newer than target release'
  fi
}

load_candidate() {
  local sha="$1" release_dir="$RELEASES/$1"
  check_candidate "$sha"
  python3 "$RELEASE_PY" verify "$release_dir/bundle.tar" >/dev/null || return 1
  docker load -i "$release_dir/runtime.tar" >/dev/null || return 1
  docker load -i "$release_dir/web.tar" >/dev/null || return 1
  REWIND_BUNDLE_SOURCE="$release_dir/source" sudo -E sh "$release_dir/source/infra/terraform/demo/cloud-init.sh" --complete || return 1
}

start_candidate() {
  local sha="$1"
  REWIND_RELEASE_SHA="$sha" docker compose --env-file "$HOST_ROOT/rewind.env" -f "$HOST_ROOT/deploy/compose.yaml" up -d --no-build
}

health_ready() {
  local ready=0
  for _ in $(seq 1 "${REWIND_HEALTH_ATTEMPTS:-30}"); do
    if curl --fail --silent http://127.0.0.1:8787/health >/dev/null &&
       curl --fail --silent http://127.0.0.1/api/health >/dev/null; then
      ready=1
      break
    fi
    sleep "${REWIND_HEALTH_SLEEP_SECONDS:-2}"
  done
  [[ "$ready" == 1 ]]
}

running_images_match() {
  local sha="$1" service image container actual loaded revision
  for service in runtime web; do
    image="rewind-demo"
    [[ "$service" == web ]] && image="rewind-demo-web"
    container="$(REWIND_RELEASE_SHA="$sha" docker compose --env-file "$HOST_ROOT/rewind.env" -f "$HOST_ROOT/deploy/compose.yaml" ps -q "$service")"
    [[ -n "$container" ]] || return 1
    actual="$(docker inspect --format '{{.Image}}' "$container")" || return 1
    # Docker may normalize an image config while loading it across engines.
    # The bundle is verified before load; compare the running container with
    # that exact loaded tag and its source revision on this host.
    loaded="$(docker image inspect --format '{{.Id}}' "$image:$sha")" || return 1
    revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image:$sha")" || return 1
    [[ "$actual" == "$loaded" && "$revision" == "$sha" ]] || return 1
  done
}

candidate_ready() {
  health_ready && running_images_match "$1"
}

restore_current() {
  [[ -f "$HOST_ROOT/current-release" ]] || return 0
  local current
  current="$(cat "$HOST_ROOT/current-release")"
  load_candidate "$current" && start_candidate "$current" && candidate_ready "$current"
}

promote() {
  local sha="$1" previous="" version
  version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["config_version"])' "$RELEASES/$sha/manifest.json")"
  if [[ -f "$HOST_ROOT/current-release" ]]; then
    previous="$(cat "$HOST_ROOT/current-release")"
  fi
  if [[ -n "$previous" ]]; then
    printf '%s\n' "$previous" > "$HOST_ROOT/previous-release.tmp"
    mv "$HOST_ROOT/previous-release.tmp" "$HOST_ROOT/previous-release"
  fi
  printf '%s\n' "$sha" > "$HOST_ROOT/current-release.tmp"
  mv "$HOST_ROOT/current-release.tmp" "$HOST_ROOT/current-release"
  printf '%s\n' "$version" > "$HOST_ROOT/release-config-version"
  sha256sum "$HOST_ROOT/rewind.env" | cut -d ' ' -f 1 > "$HOST_ROOT/release-config-digest"
  rm -f -- "$HOST_ROOT/pending-release"
  printf 'Activated release %s after runtime and web health checks.\n' "$sha"
  prune_releases
}

case "$1" in
  prepare|install)
    [[ $# == 2 ]] || die "$1 requires a bundle file"
    if [[ "$1" == prepare && -f "$HOST_ROOT/current-release" ]]; then
      die 'prepare is only for fresh wake; use install for an existing host'
    fi
    sha="$(stage_bundle "$2")"
    if [[ "$1" == install ]]; then
      if ! (load_candidate "$sha"); then
        (restore_current) || die 'upgrade preparation failed and prior-release recovery failed'
        die 'upgrade preparation failed; prior release restored'
      fi
    else
      load_candidate "$sha"
    fi
    printf '%s\n' "$sha" > "$HOST_ROOT/pending-release"
    if [[ "$1" == prepare ]]; then
      printf 'Prepared release %s; no release was activated.\n' "$sha"
      exit 0
    fi
    if ! start_candidate "$sha" || ! candidate_ready "$sha"; then
      (restore_current) || die 'upgrade failed and automatic prior-release recovery failed'
      die 'upgrade health failed; prior release restored'
    fi
    promote "$sha"
    ;;
  promote)
    [[ $# == 1 && -f "$HOST_ROOT/pending-release" ]] || die 'no pending release'
    sha="$(cat "$HOST_ROOT/pending-release")"
    check_candidate "$sha"
    if ! candidate_ready "$sha"; then
      (restore_current) || die 'pending release failed and automatic prior-release recovery failed'
      die 'pending release health failed; prior release restored'
    fi
    promote "$sha"
    ;;
  rollback)
    [[ $# == 1 && -f "$HOST_ROOT/previous-release" ]] || die 'no previous release'
    sha="$(cat "$HOST_ROOT/previous-release")"
    if ! (load_candidate "$sha"); then
      (restore_current) || die 'rollback preparation failed and current release recovery failed'
      die 'rollback preparation failed; current release restored'
    fi
    if ! start_candidate "$sha" || ! candidate_ready "$sha"; then
      (restore_current) || die 'rollback failed and current release recovery failed'
      die 'rollback health failed; current release restored'
    fi
    promote "$sha"
    ;;
  prune)
    [[ $# == 1 ]] || die 'prune takes no arguments'
    prune_releases
    printf 'Kept the current, previous and pending releases; removed older ones.\n'
    ;;
  *) die 'unknown command' ;;
esac
