#!/usr/bin/env bash
# release-host.sh prune keeps the current, previous and pending releases and
# removes older release folders and their image pairs.
set -Eeuo pipefail
root="$(mktemp -d "${TMPDIR:-/tmp}/rewind-prune-test.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)/deploy/release-host.sh"

host="$root/host"
mkdir -p "$host/releases" "$root/bin"
sha() { printf '%040d' "$1"; }
for n in 1 2 3 4 5; do mkdir -p "$host/releases/$(sha "$n")"; done
mkdir -p "$host/releases/not-a-release"
sha 5 > "$host/current-release"
sha 4 > "$host/previous-release"
sha 3 > "$host/pending-release"

cat > "$root/bin/docker" <<DOCKER
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$root/docker.log"
DOCKER
chmod +x "$root/bin/docker"

PATH="$root/bin:$PATH" REWIND_HOST_ROOT="$host" bash "$script" prune >/dev/null

for n in 3 4 5; do [[ -d "$host/releases/$(sha "$n")" ]] || { echo "kept release $n was removed" >&2; exit 1; }; done
for n in 1 2; do [[ ! -e "$host/releases/$(sha "$n")" ]] || { echo "old release $n was kept" >&2; exit 1; }; done
[[ -d "$host/releases/not-a-release" ]] || { echo 'non-release folder was removed' >&2; exit 1; }
grep -q "image rm rewind-demo:$(sha 1) rewind-demo-web:$(sha 1)" "$root/docker.log"
grep -q "image rm rewind-demo:$(sha 2) rewind-demo-web:$(sha 2)" "$root/docker.log"
if grep -q "image rm rewind-demo:$(sha 5)" "$root/docker.log"; then
  echo 'current release images were removed' >&2; exit 1
fi
echo 'release prune fixture passed'
