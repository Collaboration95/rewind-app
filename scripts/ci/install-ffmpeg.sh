#!/usr/bin/env bash
# Installs FFmpeg on a GitHub Ubuntu runner. Ubuntu mirrors have stalled or crawled
# for minutes, so prefer a checksum-verified static build from GitHub releases and
# keep apt-get as the bounded fallback.
set -Eeuo pipefail

command -v ffmpeg >/dev/null && exit 0

name=ffmpeg-n8.1-latest-linux64-gpl-8.1
base=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest
cd "${RUNNER_TEMP:?}"
if curl -fsSL --retry 3 --max-time 120 -o "$name.tar.xz" "$base/$name.tar.xz" &&
  curl -fsSL --retry 3 --max-time 30 -o checksums.sha256 "$base/checksums.sha256" &&
  grep "  $name.tar.xz\$" checksums.sha256 | sha256sum -c - &&
  tar -xJf "$name.tar.xz"; then
  echo "$RUNNER_TEMP/$name/bin" >>"${GITHUB_PATH:?}"
  exit 0
fi

echo 'Static FFmpeg download failed; falling back to apt-get.' >&2
timeout 300 sudo apt-get -o DPkg::Lock::Timeout=60 update -qq
timeout 420 sudo apt-get -o DPkg::Lock::Timeout=60 install -y -qq ffmpeg
