#!/usr/bin/env bash
# Fail before AWS/SSH when a manually selected target disagrees with its identity.
set -Eeuo pipefail
case "${TARGET_ENVIRONMENT:-}" in
  dev)
    expected_branch=refs/heads/dev
    expected_host=rewind-demo
    expected_role=arn:aws:iam::330599756236:role/rewind-demo-deploy
    ;;
  release)
    expected_branch=refs/heads/main
    expected_host=rewind-release
    expected_role=arn:aws:iam::330599756236:role/rewind-release-deploy
    ;;
  *) echo 'Select exactly dev or release.' >&2; exit 1 ;;
esac
[[ "${GITHUB_REF:-}" == "$expected_branch" &&
   "${REWIND_DEPLOY_INSTANCE:-}" == "$expected_host" &&
   "${REWIND_DEPLOY_ROLE_ARN:-}" == "$expected_role" &&
   "${AWS_REGION:-}" == ap-southeast-1 ]] || {
  echo 'Environment, branch, host, role or region does not match the selected database target.' >&2
  exit 1
}
[[ "${OPERATION:-}" != bootstrap || "${REWIND_DATABASE_BOOTSTRAP_URI:-}" == "s3://rewind-${TARGET_ENVIRONMENT}-media-330599756236/_config/${TARGET_ENVIRONMENT}-database-bootstrap.env" ]] || {
  echo 'The bootstrap settings must belong to the selected environment.' >&2
  exit 1
}
