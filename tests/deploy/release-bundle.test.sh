#!/usr/bin/env bash
set -Eeuo pipefail
root="$(mktemp -d "${TMPDIR:-/tmp}/rewind-release-test.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
python3 "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/release-extraction.test.py"
repo="$root/repo"
project="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
mkdir -p "$repo/deploy" "$repo/infra/terraform/demo" "$repo/server/src" "$root/bin"
cp "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)/deploy/release.py" "$repo/deploy/release.py"
printf 'fixture\n' > "$repo/deploy/compose.yaml"
# The release manifest reads the schema version from the real migration registry;
# fail here if that file moves or its format changes (#581 broke this silently).
python3 - "$project" <<'GUARD'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
path = re.search(r'migration_source = \(ROOT / "([^"]+)"\)', (root / "deploy/release.py").read_text()).group(1)
assert re.findall(r"\{\s*version:\s*(\d+)\s*,\s*key:", (root / path).read_text()), f"release.py reads {path} but finds no migration versions"
GUARD
printf 'CONFIG_VERSION=fixture\n' > "$repo/deploy/rewind.env.example"
cat > "$repo/infra/terraform/demo/cloud-init.sh" <<'BOOTSTRAP'
#!/bin/sh
if [ "${FIXTURE_SEQUENCE:-0}" = 1 ]; then
  mkdir -p "$REWIND_HOST_ROOT/deploy"
  cp "$REWIND_BUNDLE_SOURCE/deploy/"* "$REWIND_HOST_ROOT/deploy/"
fi
BOOTSTRAP
for tool in operator-common.sh backup-manifest.sh database-maintenance.sh database-bootstrap.sh database-import.sh; do
  cp "$project/deploy/$tool" "$repo/deploy/$tool"
done
printf "{ version: 17, key: 'fixture' }\n" > "$repo/server/src/schema.ts"
git -C "$repo" init -q
git -C "$repo" config user.name Fixture
git -C "$repo" config user.email fixture@example.invalid
git -C "$repo" add .
git -C "$repo" commit -qm fixture
sha="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" remote add origin https://github.com/Collaboration95/rewind-app.git
git -C "$repo" update-ref refs/remotes/origin/main "$sha"
export FIXTURE_GREEN_SHA="$sha"

cat > "$root/bin/gh" <<'GH'
#!/usr/bin/env bash
if [[ "${FIXTURE_CI_FAILED:-0}" == 1 ]]; then
  printf '{"workflow_runs":[]}\n'
else
  printf '{"workflow_runs":[{"head_sha":"%s","head_branch":"%s","event":"push","conclusion":"success"}]}\n' "$FIXTURE_GREEN_SHA" "${FIXTURE_CI_BRANCH:-main}"
fi
GH
chmod +x "$root/bin/gh"

cat > "$root/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
  build) exit 0 ;;
  save)
    output="$3"
    tag="$4"
    python3 - "$output" "$tag" <<'PY'
import hashlib, io, json, sys, tarfile
sha = sys.argv[2].rsplit(":", 1)[1]
config = json.dumps({"config": {"Labels": {"org.opencontainers.image.revision": sha}}}).encode()
config_path = "blobs/sha256/" + hashlib.sha256(config).hexdigest()
payload = json.dumps([{"Config": config_path, "RepoTags": [sys.argv[2]]}]).encode()
with tarfile.open(sys.argv[1], "w") as archive:
    config_member = tarfile.TarInfo(config_path)
    config_member.size = len(config)
    archive.addfile(config_member, io.BytesIO(config))
    member = tarfile.TarInfo("manifest.json")
    member.size = len(payload)
    archive.addfile(member, io.BytesIO(payload))
PY
    ;;
  *) exit 2 ;;
esac
DOCKER
chmod +x "$root/bin/docker"
export PATH="$root/bin:$PATH"

# An untracked file and a tracked edit each prevent image construction.
printf 'dirty\n' > "$repo/untracked"
if (cd "$repo" && python3 deploy/release.py build --green-sha "$sha" --config-version demo-v1 --output "$root/release.tar") >"$root/error" 2>&1; then
  echo 'dirty checkout was accepted' >&2; exit 1
fi
grep -q 'clean checkout' "$root/error"
rm "$repo/untracked"
printf 'changed\n' >> "$repo/deploy/compose.yaml"
if (cd "$repo" && python3 deploy/release.py build --green-sha "$sha" --config-version demo-v1 --output "$root/release.tar") >"$root/error" 2>&1; then
  echo 'tracked change was accepted' >&2; exit 1
fi
grep -q 'clean checkout' "$root/error"
git -C "$repo" checkout -- deploy/compose.yaml

if (cd "$repo" && FIXTURE_CI_FAILED=1 python3 deploy/release.py build --green-sha "$sha" --config-version demo-v1 --output "$root/release.tar") >"$root/error" 2>&1; then
  echo 'unverified CI commit was accepted' >&2; exit 1
fi
grep -q 'no successful main-branch' "$root/error"

(cd "$repo" && python3 deploy/release.py build --green-sha "$sha" --config-version demo-v1 --output "$root/release.tar")
[[ "$(python3 "$repo/deploy/release.py" verify "$root/release.tar")" == "$sha" ]]

python3 - "$root/release.tar" "$root/tampered.tar" <<'PY'
import io, json, sys, tarfile
with tarfile.open(sys.argv[1]) as source, tarfile.open(sys.argv[2], "w") as target:
    for member in source:
        data = source.extractfile(member).read()
        if member.name == "web.tar":
            data += b"tampered"
        member.size = len(data)
        target.addfile(member, io.BytesIO(data))
PY
if python3 "$repo/deploy/release.py" verify "$root/tampered.tar" >"$root/error" 2>&1; then
  echo 'tampered artifact was accepted' >&2; exit 1
fi
grep -q 'checksum mismatch' "$root/error"

python3 - "$root/release.tar" "$root/wrong-version.tar" <<'PY'
import hashlib, io, json, sys, tarfile
files = {}
with tarfile.open(sys.argv[1]) as source:
    for member in source:
        files[member.name] = source.extractfile(member).read()
fileobj = io.BytesIO()
with tarfile.open(fileobj=fileobj, mode="w") as image:
    data = json.dumps([{"RepoTags": ["rewind-demo-web:wrong"]}]).encode()
    member = tarfile.TarInfo("manifest.json")
    member.size = len(data)
    image.addfile(member, io.BytesIO(data))
files["web.tar"] = fileobj.getvalue()
manifest = json.loads(files["manifest.json"])
manifest["files"]["web.tar"] = hashlib.sha256(files["web.tar"]).hexdigest()
files["manifest.json"] = json.dumps(manifest).encode()
with tarfile.open(sys.argv[2], "w") as target:
    for name, data in files.items():
        member = tarfile.TarInfo(name)
        member.size = len(data)
        target.addfile(member, io.BytesIO(data))
PY
if python3 "$repo/deploy/release.py" verify "$root/wrong-version.tar" >"$root/error" 2>&1; then
  echo 'wrong image version was accepted' >&2; exit 1
fi
grep -q 'image tag does not match' "$root/error"

python3 - "$root/release.tar" "$root/wrong-image-id.tar" <<'PY'
import io, json, sys, tarfile
with tarfile.open(sys.argv[1]) as source, tarfile.open(sys.argv[2], "w") as target:
    for member in source:
        data = source.extractfile(member).read()
        if member.name == "manifest.json":
            manifest = json.loads(data)
            manifest["images"]["runtime"] = "sha256:" + "0" * 64
            data = json.dumps(manifest).encode()
        member.size = len(data)
        target.addfile(member, io.BytesIO(data))
PY
if python3 "$repo/deploy/release.py" verify "$root/wrong-image-id.tar" >"$root/error" 2>&1; then
  echo 'wrong image ID was accepted' >&2; exit 1
fi
grep -q 'image ID mismatch' "$root/error"

python3 "$repo/deploy/release.py" verify "$root/release.tar" --extract "$root/extracted" >/dev/null
[[ -f "$root/extracted/source/deploy/compose.yaml" ]]

# The release branch is an explicit input: a dev release is gated on the dev
# branch's own Quality run, not on main's.
git -C "$repo" update-ref refs/remotes/origin/dev "$sha"
if (cd "$repo" && python3 deploy/release.py build --green-sha "$sha" --config-version dev-v1 --branch dev --output "$root/dev.tar") >"$root/error" 2>&1; then
  echo 'a main-only Quality run was accepted for the dev branch' >&2; exit 1
fi
grep -q 'no successful dev-branch' "$root/error"
if (cd "$repo" && python3 deploy/release.py build --green-sha "$sha" --config-version dev-v1 --branch missing --output "$root/dev.tar") >"$root/error" 2>&1; then
  echo 'an unknown release branch was accepted' >&2; exit 1
fi
grep -q 'origin/missing is not available' "$root/error"
(cd "$repo" && FIXTURE_CI_BRANCH=dev python3 deploy/release.py build --green-sha "$sha" --config-version dev-v1 --branch dev --output "$root/dev.tar")
[[ "$(python3 "$repo/deploy/release.py" verify "$root/dev.tar")" == "$sha" ]]

# A disposable host keeps the first bundle, promotes the second, and refuses
# rollback once the database schema outruns the prior image's declared range.
printf 'second release\n' >> "$repo/deploy/compose.yaml"
git -C "$repo" add deploy/compose.yaml
git -C "$repo" commit -qm second
second_sha="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" update-ref refs/remotes/origin/main "$second_sha"
export FIXTURE_GREEN_SHA="$second_sha"
(cd "$repo" && python3 deploy/release.py build --green-sha "$second_sha" --config-version demo-v1 --output "$root/second.tar")
host="$root/host"
mkdir -p "$host/data"
cp "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)/deploy/release-host.sh" "$repo/deploy/release-host.sh"
cat > "$root/bin/sudo" <<'SUDO'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == -E ]] && shift
[[ "${1:-}" == -n ]] && shift
if [[ "${1:-}" == systemctl ]]; then exit 0; fi
if [[ "${FIXTURE_SEQUENCE:-0}" == 1 && "${3:-}" == preserve-retained ]]; then
  # Model the live sudo boundary with a controlled proc tree in this fixture.
  python3 - "$2" "$4" <<'PY'
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('release_fixture', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
host = Path(sys.argv[2])
proc = host / 'fixture-proc'
proc.mkdir(exist_ok=True)
module.preserve_retained(host, proc_root=proc)
PY
  exit $?
fi
exec "$@"
SUDO
cat > "$root/bin/sqlite3" <<'SQLITE'
#!/usr/bin/env bash
printf '%s\n' "${FIXTURE_SCHEMA:-17}"
SQLITE
cat > "$root/bin/curl" <<'CURL'
#!/usr/bin/env bash
if [[ -f "$REWIND_HOST_ROOT/.active-image" && "$(cat "$REWIND_HOST_ROOT/.active-image")" == "${FIXTURE_FAIL_SHA:-never}" ]]; then
  exit 1
fi
exit 0
CURL
cat > "$root/bin/docker" <<'HOST_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == compose ]]; then
  if [[ "${FIXTURE_SEQUENCE:-0}" == 1 ]]; then
    printf '%s\n' "$*" >> "$REWIND_HOST_ROOT/sequence-calls"
    if [[ " $* " == *'database-bootstrap'* ]]; then
      [[ -f "$REWIND_HOST_ROOT/current-release" && ! -f "$REWIND_HOST_ROOT/database-maintenance" ]] || exit 31
      python3 - "$REWIND_HOST_ROOT/data/rewind.sqlite" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0] == 17
db.close()
PY
      touch "$REWIND_HOST_ROOT/bootstrap-done"
      exit 0
    elif [[ " $* " == *'database-import'* ]]; then
      [[ -f "$REWIND_HOST_ROOT/bootstrap-done" && -f "$REWIND_HOST_ROOT/stopped" ]] || exit 32
      for argument in "$@"; do
        if [[ "$argument" == *:/import:ro ]]; then snapshot="${argument%:/import:ro}/rewind.sqlite"; fi
      done
      python3 - "$snapshot" <<'PY'
import hashlib, json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0] == 17
assert db.execute('SELECT value FROM retained').fetchone()[0] == 'qualified SQLite startup'
db.close()
print(json.dumps({'sourceMigrationVersion':17, 'totalRows':1, 'replaced':False,
 'tables':[{'table':'retained', 'rows':1, 'sha256':hashlib.sha256(b'qualified SQLite startup').hexdigest()}]}))
PY
      exit 0
    elif [[ " $* " == *' stop '* ]]; then
      touch "$REWIND_HOST_ROOT/stopped"
      exit 0
    elif [[ " $* " == *'ps --status running --services'* ]]; then
      [[ -f "$REWIND_HOST_ROOT/stopped" ]] || echo runtime
      exit 0
    elif [[ " $* " == *' up -d '* ]]; then
      # The qualified runtime's migration is modelled by real SQLite changes;
      # import below must see these, rather than the preserved old schema/data.
      python3 - "$REWIND_HOST_ROOT/data/rewind.sqlite" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute('UPDATE schema_migrations SET version=17')
db.execute("UPDATE retained SET value='qualified SQLite startup'")
db.commit()
db.close()
PY
    fi
  fi
  if [[ " $* " == *' ps -q '* ]]; then
    printf 'fixture-%s\n' "${!#}"
  elif [[ " $* " == *' up -d '* ]]; then
    printf '%s\n' "$REWIND_RELEASE_SHA" > "$REWIND_HOST_ROOT/.active-image"
  fi
elif [[ "${1:-}" == inspect ]]; then
  service="${!#}"
  service="${service#fixture-}"
  [[ "${FIXTURE_WRONG_RUNNING_IMAGE:-0}" != 1 ]] || { printf 'wrong-image\n'; exit 0; }
  printf 'normalized-%s-%s\n' "$service" "$(cat "$REWIND_HOST_ROOT/.active-image")"
elif [[ "${1:-}" == image && "${2:-}" == inspect ]]; then
  tag="${!#}"
  sha="${tag##*:}"
  service=runtime
  [[ "$tag" != rewind-demo-web:* ]] || service=web
  if [[ " $* " == *'{{.Id}}'* ]]; then
    printf 'normalized-%s-%s\n' "$service" "$sha"
  else
    [[ "${FIXTURE_WRONG_REVISION:-0}" != 1 ]] || { printf 'wrong-revision\n'; exit 0; }
    printf '%s\n' "$sha"
  fi
elif [[ "${1:-}" == load && " $* " == *"${FIXTURE_LOAD_FAIL_SHA:-never}"* ]]; then
  exit 1
fi
exit 0
HOST_DOCKER
chmod +x "$root/bin/sudo" "$root/bin/sqlite3" "$root/bin/curl" "$root/bin/docker"
export REWIND_HOST_ROOT="$host"
export REWIND_HEALTH_ATTEMPTS=1 REWIND_HEALTH_SLEEP_SECONDS=0
touch "$host/rewind.env"
bash "$repo/deploy/release-host.sh" prepare "$root/release.tar"
[[ ! -e "$host/current-release" && "$(cat "$host/pending-release")" == "$sha" ]]
REWIND_RELEASE_SHA="$sha" docker compose up -d
if FIXTURE_WRONG_RUNNING_IMAGE=1 bash "$repo/deploy/release-host.sh" promote >"$root/error" 2>&1; then
  echo 'wrong running image was promoted' >&2; exit 1
fi
if FIXTURE_WRONG_REVISION=1 bash "$repo/deploy/release-host.sh" promote >"$root/error" 2>&1; then
  echo 'wrong loaded image revision was promoted' >&2; exit 1
fi
bash "$repo/deploy/release-host.sh" promote
[[ "$(cat "$host/current-release")" == "$sha" ]]
if FIXTURE_LOAD_FAIL_SHA="$second_sha" bash "$repo/deploy/release-host.sh" install "$root/second.tar" >"$root/error" 2>&1; then
  echo 'failed image load was marked active' >&2; exit 1
fi
grep -q 'prior release restored' "$root/error"
[[ "$(cat "$host/current-release")" == "$sha" && "$(cat "$host/.active-image")" == "$sha" ]]
printf 'changed config\n' >> "$host/rewind.env"
if bash "$repo/deploy/release-host.sh" install "$root/second.tar" >"$root/error" 2>&1; then
  echo 'changed private configuration was accepted' >&2; exit 1
fi
grep -q 'private configuration revision changed' "$root/error"
printf '' > "$host/rewind.env"
if FIXTURE_FAIL_SHA="$second_sha" bash "$repo/deploy/release-host.sh" install "$root/second.tar" >"$root/error" 2>&1; then
  echo 'unhealthy upgrade was marked active' >&2; exit 1
fi
grep -q 'prior release restored' "$root/error"
[[ "$(cat "$host/current-release")" == "$sha" && "$(cat "$host/.active-image")" == "$sha" ]]
[[ ! -e "$host/previous-release" ]]
bash "$repo/deploy/release-host.sh" install "$root/second.tar"
[[ "$(cat "$host/previous-release")" == "$sha" ]]
if FIXTURE_FAIL_SHA="$sha" bash "$repo/deploy/release-host.sh" rollback >"$root/error" 2>&1; then
  echo 'unhealthy rollback was marked active' >&2; exit 1
fi
grep -q 'current release restored' "$root/error"
[[ "$(cat "$host/current-release")" == "$second_sha" && "$(cat "$host/.active-image")" == "$second_sha" ]]
touch "$host/data/rewind.sqlite"
if FIXTURE_SCHEMA=18 bash "$repo/deploy/release-host.sh" rollback >"$root/error" 2>&1; then
  echo 'incompatible rollback was accepted' >&2; exit 1
fi
grep -q 'schema is newer' "$root/error"
FIXTURE_SCHEMA=17 bash "$repo/deploy/release-host.sh" rollback
[[ "$(cat "$host/current-release")" == "$sha" ]]
# A PostgreSQL URL cannot bypass an unresolved final import, including the
# automatic prior-release recovery path. No writer may be started on failure.
printf 'REWIND_MEDIA_ENVIRONMENT=release\nREWIND_DATABASE_ENVIRONMENT=release\nREWIND_DATABASE_URL=postgres://fixture@db/rewind\n' | bash "$repo/deploy/release-host.sh" configure
printf 'release\n' > "$host/database-maintenance"
printf 'import\n' > "$host/database-maintenance-mode"
if bash "$repo/deploy/release-host.sh" install "$root/second.tar" >"$root/error" 2>&1; then
  echo 'maintenance without reconciliation started PostgreSQL writers' >&2; exit 1
fi
[[ -f "$host/database-maintenance" && "$(cat "$host/.active-image")" == "$sha" ]]

# Exercise the required release ordering through the real host entrypoints.
# Docker/database transport is local fixture code; preservation, installation,
# role dispatch, drain, manifest validation and reconciliation receipts are real.
(
  sequence="$root/sequence-host"
  mkdir -p "$sequence/data" "$sequence/media"
  python3 - "$sequence/data/rewind.sqlite" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(16); CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('before qualification');")
db.close()
PY
  printf 'clip' > "$sequence/media/clip.bin"
  printf 'REWIND_MEDIA_ENVIRONMENT=release\nREWIND_DATABASE_ENVIRONMENT=release\nREWIND_BACKUP_BUCKET=rewind-release-backups-330599756236\nREWIND_BACKUP_PREFIX=rewind-release\nREWIND_DATABASE_URL=\nREWIND_DATABASE_APP_URL=postgres://fixture@db/rewind\n' > "$sequence/rewind.env"
  export REWIND_HOST_ROOT="$sequence" HOST_ROOT="$sequence" FIXTURE_SEQUENCE=1
  export REWIND_OPERATION_ENVIRONMENT=release RUNTIME_GID="$(id -g)"
  export REWIND_RELEASE_SHA='' BACKUP_VALIDATION_NOW=1792285323
  bash "$repo/deploy/release-host.sh" prepare "$root/release.tar"
  [[ ! -e "$sequence/current-release" && ! -e "$sequence/database-maintenance" ]]
  python3 - "$sequence" <<'PY'
import json, sqlite3, sys, tarfile, tempfile
from pathlib import Path
host = Path(sys.argv[1])
inventory = json.loads((host/'backups/first-start-inventory.json').read_text())
assert inventory['sqlitePresent'] and inventory['tables']['retained']['rows'] == 1
with tarfile.open(host/'backups/first-start-retained.tar') as archive, tempfile.TemporaryDirectory() as work:
    copy = Path(work)/'old.sqlite'
    copy.write_bytes(archive.extractfile('data/rewind.sqlite').read())
    db = sqlite3.connect(copy)
    assert db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0] == 16
    assert db.execute('SELECT value FROM retained').fetchone()[0] == 'before qualification'
    db.close()
PY
  bash "$repo/deploy/release-host.sh" install "$root/release.tar"
  [[ "$(cat "$sequence/current-release")" == "$sha" && ! -e "$sequence/database-maintenance" ]]
  printf 'REWIND_DATABASE_ADMIN_URL=postgres://fixture@db/rewind\nREWIND_DATABASE_APP_PASSWORD=fixture-app-password-not-used\nREWIND_DATABASE_READONLY_PASSWORD=fixture-readonly-password-not-used\n' |
    bash "$sequence/deploy/database-bootstrap.sh"
  bash "$sequence/deploy/database-maintenance.sh" quiesce
  [[ -e "$sequence/stopped" && "$(cat "$sequence/database-maintenance-mode")" == import ]]
  python3 - "$sequence" <<'PY'
import gzip, hashlib, json, sqlite3, sys, tarfile
from pathlib import Path
host = Path(sys.argv[1])
base = host/'backups'
stamp = 'rewind-20261018T010203Z'
snapshot = base/'fresh.sqlite'
db = sqlite3.connect(host/'data/rewind.sqlite')
db.execute('VACUUM INTO ?', (str(snapshot),))
db.close()
database = base/(stamp+'.sqlite.gz')
database.write_bytes(gzip.compress(snapshot.read_bytes()))
media = base/(stamp+'.media.tar.gz')
with tarfile.open(media, 'w:gz') as archive:
    archive.add(host/'media', arcname='.')
def entry(file):
    return {'key':'rewind-release/'+file.name, 'sha256':hashlib.sha256(file.read_bytes()).hexdigest(), 'bytes':file.stat().st_size}
(base/(stamp+'.manifest.json')).write_text(json.dumps({'created_at':'20261018T010203Z', 'database':entry(database), 'media':entry(media)}))
PY
  cat > "$root/bin/aws" <<'AWS'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1 $2" == 's3 cp' ]] || exit 33
cp "$HOST_ROOT/backups/${3##*/}" "$4"
AWS
  chmod +x "$root/bin/aws"
  export REWIND_FINAL_IMPORT_MANIFEST=rewind-20261018T010203Z.manifest.json
  bash "$sequence/deploy/database-import.sh" --confirm --manifest "$REWIND_FINAL_IMPORT_MANIFEST"
  [[ -e "$sequence/database-maintenance" && -e "$sequence/stopped" ]]
  python3 - "$sequence" <<'PY'
import json, sys
from pathlib import Path
host = Path(sys.argv[1])
receipt = json.loads((host/'database-reconciled.json').read_text())
assert receipt['environment'] == 'release' and receipt['finalSnapshot'] is True
assert receipt['manifest'] == 'rewind-20261018T010203Z.manifest.json'
assert receipt['reconciliation']['sourceMigrationVersion'] == 17
calls = (host/'sequence-calls').read_text()
assert calls.index('up -d --no-build') < calls.index('database-bootstrap') < calls.index('stop --timeout') < calls.index('database-import')
PY
)
echo 'release bundle fixture passed'
