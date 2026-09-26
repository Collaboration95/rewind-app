#!/usr/bin/env bash
set -Eeuo pipefail
root="$(mktemp -d "${TMPDIR:-/tmp}/rewind-release-test.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
repo="$root/repo"
mkdir -p "$repo/deploy" "$repo/infra/terraform/demo" "$repo/server/src" "$root/bin"
cp "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)/deploy/release.py" "$repo/deploy/release.py"
printf 'fixture\n' > "$repo/deploy/compose.yaml"
printf '#!/bin/sh\nexit 0\n' > "$repo/infra/terraform/demo/cloud-init.sh"
printf "{ version: 17, key: 'fixture' }\n" > "$repo/server/src/db.ts"
git -C "$repo" init -q
git -C "$repo" config user.name Fixture
git -C "$repo" config user.email fixture@example.invalid
git -C "$repo" add .
git -C "$repo" commit -qm fixture
sha="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" update-ref refs/remotes/origin/main "$sha"

cat > "$root/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
  build) exit 0 ;;
  save)
    output="$3"
    tag="$4"
    python3 - "$output" "$tag" <<'PY'
import io, json, sys, tarfile
payload = json.dumps([{"RepoTags": [sys.argv[2]]}]).encode()
with tarfile.open(sys.argv[1], "w") as archive:
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
rg -q 'clean checkout' "$root/error"
rm "$repo/untracked"
printf 'changed\n' >> "$repo/deploy/compose.yaml"
if (cd "$repo" && python3 deploy/release.py build --green-sha "$sha" --config-version demo-v1 --output "$root/release.tar") >"$root/error" 2>&1; then
  echo 'tracked change was accepted' >&2; exit 1
fi
rg -q 'clean checkout' "$root/error"
git -C "$repo" checkout -- deploy/compose.yaml

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
rg -q 'checksum mismatch' "$root/error"

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
rg -q 'image tag does not match' "$root/error"

python3 "$repo/deploy/release.py" verify "$root/release.tar" --extract "$root/extracted" >/dev/null
[[ -f "$root/extracted/source/deploy/compose.yaml" ]]

# A disposable host keeps the first bundle, promotes the second, and refuses
# rollback once the database schema outruns the prior image's declared range.
printf 'second release\n' >> "$repo/deploy/compose.yaml"
git -C "$repo" add deploy/compose.yaml
git -C "$repo" commit -qm second
second_sha="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" update-ref refs/remotes/origin/main "$second_sha"
(cd "$repo" && python3 deploy/release.py build --green-sha "$second_sha" --config-version demo-v1 --output "$root/second.tar")
host="$root/host"
mkdir -p "$host/data"
cp "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)/deploy/release-host.sh" "$repo/deploy/release-host.sh"
cat > "$root/bin/sudo" <<'SUDO'
#!/usr/bin/env bash
[[ "${1:-}" == -E ]] && shift
exec "$@"
SUDO
cat > "$root/bin/sqlite3" <<'SQLITE'
#!/usr/bin/env bash
printf '%s\n' "${FIXTURE_SCHEMA:-17}"
SQLITE
cat > "$root/bin/curl" <<'CURL'
#!/usr/bin/env bash
exit 0
CURL
cat > "$root/bin/docker" <<'HOST_DOCKER'
#!/usr/bin/env bash
exit 0
HOST_DOCKER
chmod +x "$root/bin/sudo" "$root/bin/sqlite3" "$root/bin/curl" "$root/bin/docker"
export REWIND_HOST_ROOT="$host"
bash "$repo/deploy/release-host.sh" install "$root/release.tar"
[[ "$(cat "$host/current-release")" == "$sha" ]]
bash "$repo/deploy/release-host.sh" install "$root/second.tar"
[[ "$(cat "$host/previous-release")" == "$sha" ]]
touch "$host/data/rewind.sqlite" "$host/rewind.env"
if FIXTURE_SCHEMA=18 bash "$repo/deploy/release-host.sh" rollback >"$root/error" 2>&1; then
  echo 'incompatible rollback was accepted' >&2; exit 1
fi
rg -q 'schema is newer' "$root/error"
FIXTURE_SCHEMA=17 bash "$repo/deploy/release-host.sh" rollback
[[ "$(cat "$host/current-release")" == "$sha" ]]
echo 'release bundle fixture passed'
