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
if printf 'REWIND_BACKUP_BUCKET=evil\n' | REWIND_HOST_ROOT="$host" bash "$script" configure >/dev/null 2>&1; then
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

# A brand-new host has no rewind.env yet: configure creates it privately.
fresh="$root/fresh"
mkdir -p "$fresh"
printf 'REWIND_MEDIA_BACKEND=s3\nREWIND_WEB_BIND_ADDRESS=0.0.0.0\nREWIND_WEB_PORT=80\nREWIND_ALLOW_ORIGIN=https://release.example\nREWIND_ORIGIN_AUTH_SECRET=fixture-origin-secret\n' | REWIND_HOST_ROOT="$fresh" bash "$script" configure >/dev/null
grep -qx 'REWIND_ORIGIN_AUTH_SECRET=fixture-origin-secret' "$fresh/rewind.env" || { echo 'release settings were refused' >&2; exit 1; }
grep -qx 'REWIND_MEDIA_BACKEND=s3' "$fresh/rewind.env" || { echo 'fresh host settings were not written' >&2; exit 1; }
fresh_mode="$(stat -c %a "$fresh/rewind.env" 2>/dev/null || stat -f %Lp "$fresh/rewind.env")"
[[ "$fresh_mode" == 600 ]] || { echo "fresh rewind.env mode is $fresh_mode" >&2; exit 1; }
echo 'fresh host configure fixture passed'

# PostgreSQL settings (#261): delivered before the cutover with an empty
# REWIND_DATABASE_URL, set at the cutover, and cleared again for rollback.
pg="$root/pg"
mkdir -p "$pg"
app='postgres://rewind_app:Abc123@db.internal:5432/rewind'
printf 'REWIND_DATABASE_ENVIRONMENT=dev\nREWIND_DATABASE_APP_URL=%s\nREWIND_DATABASE_READONLY_URL=postgres://rewind_readonly:Def456@db.internal:5432/rewind\nREWIND_DATABASE_URL=\n' "$app" |
  REWIND_HOST_ROOT="$pg" bash "$script" configure >/dev/null
grep -qx 'REWIND_DATABASE_URL=' "$pg/rewind.env" || { echo 'pre-cutover database URL was not empty' >&2; exit 1; }
grep -qx "REWIND_DATABASE_APP_URL=$app" "$pg/rewind.env" || { echo 'database import login was not delivered' >&2; exit 1; }
printf 'REWIND_DATABASE_URL=%s\n' "$app" | REWIND_HOST_ROOT="$pg" bash "$script" configure >/dev/null
grep -qx "REWIND_DATABASE_URL=$app" "$pg/rewind.env" || { echo 'cutover did not set the database URL' >&2; exit 1; }
printf 'REWIND_DATABASE_URL=\n' | REWIND_HOST_ROOT="$pg" bash "$script" configure >/dev/null
grep -qx 'REWIND_DATABASE_URL=' "$pg/rewind.env" || { echo 'rollback did not clear the database URL' >&2; exit 1; }
[[ "$(grep -c '^REWIND_DATABASE_URL=' "$pg/rewind.env")" == 1 ]] || { echo 'database URL was duplicated' >&2; exit 1; }
echo 'database settings configure fixture passed'
