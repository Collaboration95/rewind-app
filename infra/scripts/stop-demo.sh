#!/usr/bin/env bash
# Compatibility name: stopping the hosted Demo now means verified backup plus
# Terraform hibernation, not merely powering off a still-billable instance.
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$SCRIPT_DIR/destroy-demo.sh" "$@"
