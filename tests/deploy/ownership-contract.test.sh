#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rewind-ownership-contract.XXXXXX")"
FAKE_BIN="$TEST_ROOT/bin"
ORIGINAL_PATH="$PATH"
RUNTIME_UID="$(id -u)"
RUNTIME_GID="$(id -g)"
export RUNTIME_UID RUNTIME_GID

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == -n ]] && shift
[[ "${1:-}" == -v ]] && exit 0
if [[ "${1:-}" == -u ]]; then
  shift 2
fi
[[ "${1:-}" == -- ]] && shift
exec "$@"
EOF

cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == compose ]]; then
  case " $* " in
    *' ps -q runtime '*) printf 'fixture-runtime\n'; exit 0 ;;
    *) exit 0 ;;
  esac
fi
if [[ "${1:-}" == cp ]]; then
  [[ "${2:-}" == fixture-runtime:/var/lib/rewind/media/. ]] || exit 2
  tar -C "${FAKE_MEDIA_SOURCE:?}" -cf - .
  exit 0
fi
exit 2
EOF
chmod 0755 "$FAKE_BIN/sudo" "$FAKE_BIN/docker"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/deploy/operator-common.sh"

DATA_DIR="$TEST_ROOT/data"
MEDIA_DIR="$TEST_ROOT/media"
BACKUP_DIR="$TEST_ROOT/backups"
ENV_FILE="$TEST_ROOT/rewind.env"
COMPOSE_FILE="$TEST_ROOT/compose.yaml"
mkdir -p "$DATA_DIR" "$MEDIA_DIR/nested/deep" "$BACKUP_DIR"
printf 'fixture-env\n' > "$ENV_FILE"
printf 'services: {}\n' > "$COMPOSE_FILE"

create_private_fixture() {
  printf 'sqlite-fixture\n' > "$DATA_DIR/rewind.sqlite"
  printf 'nested-media\n' > "$MEDIA_DIR/nested/deep/clip.bin"
  chmod 0750 "$DATA_DIR" "$MEDIA_DIR" "$MEDIA_DIR/nested" "$MEDIA_DIR/nested/deep"
  chmod 0640 "$DATA_DIR/rewind.sqlite" "$MEDIA_DIR/nested/deep/clip.bin"
}

create_private_fixture
assert_persistent_tree_contract "$DATA_DIR" 'fresh SQLite data'
assert_persistent_tree_contract "$MEDIA_DIR" 'fresh media'

# Exercise the same normalization used by restore.sh on a copied recovery tree.
RESTORED_ROOT="$TEST_ROOT/restored"
mkdir -p "$RESTORED_ROOT/data" "$RESTORED_ROOT/media"
cp -- "$DATA_DIR/rewind.sqlite" "$RESTORED_ROOT/data/rewind.sqlite"
cp -R -- "$MEDIA_DIR/nested" "$RESTORED_ROOT/media/nested"
chmod 0777 "$RESTORED_ROOT/data" "$RESTORED_ROOT/media" "$RESTORED_ROOT/media/nested" \
  "$RESTORED_ROOT/media/nested/deep"
chmod 0666 "$RESTORED_ROOT/data/rewind.sqlite" "$RESTORED_ROOT/media/nested/deep/clip.bin"
PATH="$FAKE_BIN:$ORIGINAL_PATH" prepare_persistent_tree "$RESTORED_ROOT/data" 'restored SQLite data'
PATH="$FAKE_BIN:$ORIGINAL_PATH" prepare_persistent_tree "$RESTORED_ROOT/media" 'restored media'
assert_persistent_tree_contract "$RESTORED_ROOT/data" 'restored SQLite data'
assert_persistent_tree_contract "$RESTORED_ROOT/media" 'restored media'

# The runtime identity must be able to read and write after restore without
# making the tree world-readable. The image entrypoint supplies this umask.
PATH="$FAKE_BIN:$ORIGINAL_PATH" run_as_runtime sh -c \
  'umask 027; test -r "$1/rewind.sqlite"; test -w "$1"; printf runtime-write > "$2"' \
  runtime-shell "$RESTORED_ROOT/data" "$RESTORED_ROOT/data/runtime-write.sqlite"
assert_persistent_tree_contract "$RESTORED_ROOT/data" 'restored SQLite data after runtime write'

FAKE_MEDIA_SOURCE="$RESTORED_ROOT/media" PATH="$FAKE_BIN:$ORIGINAL_PATH" \
  archive_runtime_media "$BACKUP_DIR/media.tar.gz"
assert_private_backup_file "$BACKUP_DIR/media.tar.gz" 'media backup archive'
tar -tzf "$BACKUP_DIR/media.tar.gz" | grep -Fxq './nested/deep/clip.bin'

wrong_mode_output=''
chmod 0644 "$RESTORED_ROOT/media/nested/deep/clip.bin"
set +e
wrong_mode_output="$(assert_persistent_tree_contract "$RESTORED_ROOT/media" 'wrong-mode media' 2>&1)"
wrong_mode_status=$?
set -e
[[ "$wrong_mode_status" -ne 0 ]]
grep -Fq 'persistent ownership contract failed' <<<"$wrong_mode_output"
[[ "$wrong_mode_output" != *"$TEST_ROOT"* ]]
chmod 0640 "$RESTORED_ROOT/media/nested/deep/clip.bin"

wrong_owner_output=''
original_runtime_uid="$RUNTIME_UID"
RUNTIME_UID=$((RUNTIME_UID + 1))
export RUNTIME_UID
set +e
wrong_owner_output="$(assert_persistent_tree_contract "$RESTORED_ROOT/media" 'wrong-owner media' 2>&1)"
wrong_owner_status=$?
set -e
RUNTIME_UID="$original_runtime_uid"
export RUNTIME_UID
[[ "$wrong_owner_status" -ne 0 ]]
grep -Fq 'persistent ownership contract failed' <<<"$wrong_owner_output"
[[ "$wrong_owner_output" != *"$TEST_ROOT"* ]]

# Fresh/reset paths use the same runtime umask and the same post-transition
# assertions in reset-with-backup.sh and migrate-with-backup.sh.
grep -Fq 'umask 027' "$SCRIPT_DIR/deploy/Dockerfile"
grep -Fq "assert_persistent_tree_contract \"\$DATA_DIR\" 'SQLite data'" "$SCRIPT_DIR/deploy/reset-with-backup.sh"
grep -Fq "assert_persistent_tree_contract \"\$DATA_DIR\" 'SQLite data'" "$SCRIPT_DIR/deploy/migrate-with-backup.sh"

printf 'persistent ownership contract fixture tests passed\n'
