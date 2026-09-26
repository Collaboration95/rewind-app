#!/usr/bin/env bash
# Install a verified image pair and keep the prior pair for schema-safe rollback.
set -Eeuo pipefail
HOST_ROOT="${REWIND_HOST_ROOT:-/srv/rewind}"
RELEASES="$HOST_ROOT/releases"
RELEASE_PY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/release.py"

die() { printf 'Release rejected: %s\n' "$*" >&2; exit 1; }
[[ $# -ge 1 ]] || die 'usage: release-host.sh install BUNDLE | rollback'
case "$1" in
  install)
    [[ $# == 2 && -f "$2" ]] || die 'install requires a bundle file'
    stage="$(mktemp -d "$HOST_ROOT/.release-stage.XXXXXX")"
    trap 'rm -rf -- "$stage"' EXIT
    sha="$(python3 "$RELEASE_PY" verify "$2" --extract "$stage/verified")" || die 'bundle verification failed'
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die 'invalid release SHA'
    mkdir -p "$RELEASES"
    if [[ -e "$RELEASES/$sha" ]]; then
      die 'this release is already installed'
    fi
    mv "$stage/verified" "$RELEASES/$sha"
    cp "$2" "$RELEASES/$sha/bundle.tar"
    ;;
  rollback)
    [[ $# == 1 && -f "$HOST_ROOT/previous-release" ]] || die 'no previous release'
    sha="$(cat "$HOST_ROOT/previous-release")"
    [[ "$sha" =~ ^[0-9a-f]{40}$ && -d "$RELEASES/$sha" ]] || die 'previous release is missing'
    python3 "$RELEASE_PY" verify "$RELEASES/$sha/bundle.tar" >/dev/null || die 'previous artifact is damaged'
    ;;
  *) die 'unknown command' ;;
esac

release_dir="$RELEASES/$sha"
manifest="$release_dir/manifest.json"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["config_version"])' "$manifest")"
schema="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["schema_version"])' "$manifest")"
if [[ -f "$HOST_ROOT/release-config-version" ]]; then
  [[ "$(cat "$HOST_ROOT/release-config-version")" == "$version" ]] || die 'configuration version differs; review private config compatibility first'
fi
if [[ -f "$HOST_ROOT/data/rewind.sqlite" ]]; then
  current_schema="$(sudo sqlite3 -readonly "$HOST_ROOT/data/rewind.sqlite" 'SELECT COALESCE(MAX(version),0) FROM schema_migrations;' 2>/dev/null)" || die 'cannot inspect database schema'
  [[ "$current_schema" =~ ^[0-9]+$ && "$current_schema" -le "$schema" ]] || die 'database schema is newer than target release'
fi
docker load -i "$release_dir/runtime.tar" >/dev/null
docker load -i "$release_dir/web.tar" >/dev/null
REWIND_BUNDLE_SOURCE="$release_dir/source" sudo -E sh "$release_dir/source/infra/terraform/demo/cloud-init.sh" --complete
if [[ -f "$HOST_ROOT/current-release" ]]; then
  cp "$HOST_ROOT/current-release" "$HOST_ROOT/previous-release"
fi
printf '%s\n' "$sha" > "$HOST_ROOT/current-release.tmp"
mv "$HOST_ROOT/current-release.tmp" "$HOST_ROOT/current-release"
printf '%s\n' "$version" > "$HOST_ROOT/release-config-version"
if [[ "$1" == rollback ]]; then
  REWIND_RELEASE_SHA="$sha" docker compose --env-file "$HOST_ROOT/rewind.env" -f "$HOST_ROOT/deploy/compose.yaml" up -d --no-build
  ready=0
  for _ in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:8787/health >/dev/null &&
       curl --fail --silent http://127.0.0.1/api/health >/dev/null; then
      ready=1
      break
    fi
    sleep 2
  done
  [[ "$ready" == 1 ]] || die 'rollback health failed; inspect both services before resuming traffic'
fi
printf 'Activated release %s (schema <= %s, config %s).\n' "$sha" "$schema" "$version"
