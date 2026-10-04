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

tf() { terraform -chdir="$TF_DIR" output -raw "$1"; }

{
  echo "REWIND_MEDIA_BACKEND=s3"
  echo "REWIND_MEDIA_ENVIRONMENT=dev"
  echo "REWIND_MEDIA_S3_BUCKET=$(tf bucket)"
  echo "REWIND_MEDIA_S3_OWNER=$(tf bucket_owner)"
  echo "REWIND_MEDIA_S3_REGION=$(tf region)"
  echo "AWS_REGION=$(tf region)"
  echo "AWS_ACCESS_KEY_ID=$(tf runtime_access_key_id)"
  echo "AWS_SECRET_ACCESS_KEY=$(tf runtime_secret_access_key)"
  echo "REWIND_REMINDER_VAPID_SUBJECT=$APP_ORIGIN"
  node -e "const k=require('web-push').generateVAPIDKeys();console.log('REWIND_REMINDER_VAPID_PUBLIC_KEY='+k.publicKey);console.log('REWIND_REMINDER_VAPID_PRIVATE_KEY='+k.privateKey)"
} | gh secret set REWIND_HOSTED_ENV --repo "$REPO"

echo "Stored REWIND_HOSTED_ENV for $REPO. The next deploy to dev applies it."
