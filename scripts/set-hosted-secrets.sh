#!/usr/bin/env bash
# Owner-run, once: store the hosted runtime settings as the GitHub Actions
# secret REWIND_HOSTED_ENV. The next deploy writes them into the server's
# rewind.env (deploy/release-host.sh configure). Values go straight from
# Terraform and the key generator into `gh secret set`; nothing is printed.
#
# Running it again rotates the web push keys, so devices must re-enable
# reminders afterwards.
set -Eeuo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."

REPO=${REWIND_REPO:-Collaboration95/rewind-app}
APP_ORIGIN=${REWIND_APP_ORIGIN:-https://d2m6kz76y4kuvm.cloudfront.net}
TF_DIR=infra/terraform/media
export AWS_PROFILE=${AWS_PROFILE:-rewind-terraform-apply}

fail() { echo "set-hosted-secrets: $*" >&2; exit 1; }
tf() { terraform -chdir="$TF_DIR" output -raw "$1"; }

# Checked assignments: any failed or empty value stops before the secret changes.
bucket=$(tf bucket)
owner=$(tf bucket_owner)
region=$(tf region)
key_id=$(tf runtime_access_key_id)
secret=$(tf runtime_secret_access_key)
vapid=$(node -e "const k=require('web-push').generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")
vapid_public=${vapid% *}
vapid_private=${vapid#* }

[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || fail 'bucket output is missing or invalid'
[[ "$owner" =~ ^[0-9]{12}$ ]] || fail 'bucket_owner output is missing or invalid'
[[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || fail 'region output is missing or invalid'
[[ "$key_id" =~ ^AKIA[A-Z0-9]{16}$ ]] || fail 'runtime access key id is missing or invalid'
[[ ${#secret} -ge 40 ]] || fail 'runtime secret access key is missing'
[[ ${#vapid_public} -eq 87 && ${#vapid_private} -eq 43 ]] || fail 'web push key generation failed'

printf '%s\n' \
  "REWIND_MEDIA_BACKEND=s3" \
  "REWIND_MEDIA_ENVIRONMENT=dev" \
  "REWIND_MEDIA_S3_BUCKET=$bucket" \
  "REWIND_MEDIA_S3_OWNER=$owner" \
  "REWIND_MEDIA_S3_REGION=$region" \
  "AWS_REGION=$region" \
  "AWS_ACCESS_KEY_ID=$key_id" \
  "AWS_SECRET_ACCESS_KEY=$secret" \
  "REWIND_REMINDER_VAPID_SUBJECT=$APP_ORIGIN" \
  "REWIND_REMINDER_VAPID_PUBLIC_KEY=$vapid_public" \
  "REWIND_REMINDER_VAPID_PRIVATE_KEY=$vapid_private" |
  gh secret set REWIND_HOSTED_ENV --repo "$REPO"

echo "Stored REWIND_HOSTED_ENV for $REPO. Re-run 'Deploy dev' to apply it."
