#!/usr/bin/env bash
# release-host.sh configure merges allowlisted settings into rewind.env and
# refreshes the release config digest; other keys are refused.
set -Eeuo pipefail
root="$(mktemp -d "${TMPDIR:-/tmp}/rewind-configure-test.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)/deploy/release-host.sh"
host="$root/host"
mkdir -p "$host"
printf 'REWIND_ALLOW_ORIGIN=*\nREWIND_MEDIA_BACKEND=disk\n' > "$host/rewind.env"
sha256sum "$host/rewind.env" 2>/dev/null | cut -d ' ' -f 1 > "$host/release-config-digest" || shasum -a 256 "$host/rewind.env" | cut -d ' ' -f 1 > "$host/release-config-digest"

printf 'REWIND_MEDIA_BACKEND=s3\nREWIND_MEDIA_S3_BUCKET=rewind-dev-media-1\n# comment\n\n' |
  REWIND_HOST_ROOT="$host" bash "$script" configure >/dev/null

grep -qx 'REWIND_ALLOW_ORIGIN=\*' "$host/rewind.env" || { echo 'operator setting was lost' >&2; exit 1; }
grep -qx 'REWIND_MEDIA_BACKEND=s3' "$host/rewind.env" || { echo 'setting was not replaced' >&2; exit 1; }
[[ "$(grep -c '^REWIND_MEDIA_BACKEND=' "$host/rewind.env")" == 1 ]] || { echo 'setting was duplicated' >&2; exit 1; }
grep -qx 'REWIND_MEDIA_S3_BUCKET=rewind-dev-media-1' "$host/rewind.env" || { echo 'setting was not added' >&2; exit 1; }
if command -v sha256sum >/dev/null; then digest="$(sha256sum "$host/rewind.env" | cut -d ' ' -f 1)"; else digest="$(shasum -a 256 "$host/rewind.env" | cut -d ' ' -f 1)"; fi
[[ "$(cat "$host/release-config-digest")" == "$digest" ]] || { echo 'digest was not refreshed' >&2; exit 1; }

before="$(cat "$host/rewind.env")"
if printf 'REWIND_ALLOW_ORIGIN=evil\n' | REWIND_HOST_ROOT="$host" bash "$script" configure >/dev/null 2>&1; then
  echo 'a non-configurable key was accepted' >&2; exit 1
fi
[[ "$(cat "$host/rewind.env")" == "$before" ]] || { echo 'a refused change modified rewind.env' >&2; exit 1; }
echo 'release configure fixture passed'
