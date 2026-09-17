#!/usr/bin/env bash
# Run on the Lightsail host as ubuntu. It refuses to power off unless a fresh
# database-and-media manifest has reached the private S3 backup bucket.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-/srv/rewind/rewind.env}"
COMPOSE_FILE="${COMPOSE_FILE:-/srv/rewind/deploy/compose.yaml}"

[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE." >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${REWIND_BACKUP_BUCKET:?REWIND_BACKUP_BUCKET must be configured}"
: "${REWIND_BACKUP_PREFIX:=rewind-demo}"
: "${AWS_PROFILE:=default}"

"$SCRIPT_DIR/backup.sh"
manifest_key="$(AWS_PROFILE="$AWS_PROFILE" aws s3api list-objects-v2 --bucket "$REWIND_BACKUP_BUCKET" --prefix "${REWIND_BACKUP_PREFIX}/rewind-" --query 'reverse(sort_by(Contents[?ends_with(Key, `.manifest.json`)], &LastModified))[0].Key' --output text)"
[[ -n "$manifest_key" && "$manifest_key" != "None" ]] || { echo 'No uploaded backup manifest; refusing to stop.' >&2; exit 1; }
AWS_PROFILE="$AWS_PROFILE" aws s3api head-object --bucket "$REWIND_BACKUP_BUCKET" --key "$manifest_key" >/dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop
echo "Backup verified at s3://${REWIND_BACKUP_BUCKET}/${manifest_key}; stopping host."
sudo /sbin/shutdown -h now
