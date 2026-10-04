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
# Web push keys are generated on the host once, then kept across deploys.
printf 'REWIND_REMINDER_VAPID_SUBJECT=https://rewind.example\n' |
  REWIND_HOST_ROOT="$host" bash "$script" configure >/dev/null
first_key="$(grep '^REWIND_REMINDER_VAPID_PRIVATE_KEY=' "$host/rewind.env")"
[[ ${#first_key} -eq $((34 + 43)) ]] || { echo 'web push private key was not generated' >&2; exit 1; }
grep -Eq '^REWIND_REMINDER_VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{87}$' "$host/rewind.env" || { echo 'web push public key was not generated' >&2; exit 1; }
printf 'REWIND_REMINDER_VAPID_SUBJECT=https://rewind.example\n' |
  REWIND_HOST_ROOT="$host" bash "$script" configure >/dev/null
[[ "$(grep '^REWIND_REMINDER_VAPID_PRIVATE_KEY=' "$host/rewind.env")" == "$first_key" ]] || { echo 'web push keys were rotated' >&2; exit 1; }

mode="$(stat -c %a "$host/rewind.env" 2>/dev/null || stat -f %Lp "$host/rewind.env")"
[[ "$mode" == 600 ]] || { echo "rewind.env mode is $mode, expected 600" >&2; exit 1; }
if ls "$host"/.rewind.env.* >/dev/null 2>&1; then echo 'temporary env copies were left behind' >&2; exit 1; fi

# An unreviewed manual edit (digest mismatch) blocks configure without changes.
printf 'REWIND_ORIGIN_AUTH_SECRET=manual\n' >> "$host/rewind.env"
edited="$(cat "$host/rewind.env")"
if printf 'REWIND_MEDIA_BACKEND=disk\n' | REWIND_HOST_ROOT="$host" bash "$script" configure >/dev/null 2>&1; then
  echo 'configure approved an unreviewed manual edit' >&2; exit 1
fi
[[ "$(cat "$host/rewind.env")" == "$edited" ]] || { echo 'a refused configure modified rewind.env' >&2; exit 1; }
echo 'release configure fixture passed'
