#!/bin/sh
# Render to the writable tmpfs; the web container runs as nginx with a read-only root.
set -eu
upload_origin=''
case "${REWIND_MEDIA_BACKEND:-disk}" in
  disk) ;;
  s3)
    # grep anchors are line based: reject embedded newlines before validation.
    case "${REWIND_MEDIA_S3_BUCKET:-}" in ''|*[!a-z0-9.-]*) echo 'Invalid CSP media bucket' >&2; exit 1 ;; esac
    case "${REWIND_MEDIA_S3_REGION:-}" in ''|*[!a-z0-9-]*) echo 'Invalid CSP media region' >&2; exit 1 ;; esac
    printf '%s' "${REWIND_MEDIA_S3_BUCKET:-}" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' || { echo 'Invalid CSP media bucket' >&2; exit 1; }
    printf '%s' "${REWIND_MEDIA_S3_REGION:-}" | grep -Eq '^[a-z]{2}(-[a-z]+)+-[0-9]+$' || { echo 'Invalid CSP media region' >&2; exit 1; }
    upload_origin="https://${REWIND_MEDIA_S3_BUCKET}.s3.${REWIND_MEDIA_S3_REGION}.amazonaws.com"
    ;;
  *) echo 'Unsupported CSP media backend' >&2; exit 1 ;;
esac
sed "s|__UPLOAD_ORIGIN__|$upload_origin|g" /etc/nginx/security-headers.conf > /tmp/security-headers.conf
