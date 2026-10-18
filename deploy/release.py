#!/usr/bin/env python3
"""Build and verify a source-bound, two-image Demo release bundle."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import os
import sqlite3
import stat
from itertools import chain

ROOT = Path(__file__).resolve().parent.parent
SHA = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"[A-Za-z0-9._-]{1,64}")
BRANCH = re.compile(r"[A-Za-z0-9._/-]{1,255}")
FILES = ("source.tar", "runtime.tar", "web.tar")


def fail(message):
    raise ValueError(message)


def run(*args, cwd=ROOT, output=False):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=output).stdout if output else subprocess.run(args, cwd=cwd, check=True)


def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def retained_summary(report):
    # Schema/counts/checksums only: never log row values or private media names.
    print(json.dumps({'environment': 'release', 'sqlitePresent': report['sqlitePresent'],
                      'tables': report['tables'], 'fileCount': len(report['files']),
                      'mediaFileCount': sum(name.startswith('media/') for name in report['files']),
                      'archiveSha256': report['archiveSha256']}, sort_keys=True))


def preserve_retained(host):
    """Preserve pre-start SQLite (including WAL) and disk media without booting."""
    host = Path(host)
    backups = host / 'backups'
    if backups.is_symlink():
        fail('retained backup directory is a symlink')
    backups.mkdir(mode=0o770, exist_ok=True)
    archive = backups / 'first-start-retained.tar'
    inventory = backups / 'first-start-inventory.json'
    if inventory.exists():
        saved = json.loads(inventory.read_text())
        if digest(archive) != saved['archiveSha256']:
            fail('retained rollback archive no longer matches its inventory')
        if saved['sqlitePresent'] and not (host / 'database-maintenance').exists():
            fail('retained SQLite requires an active final-import maintenance window')
        retained_summary(saved)
        return
    if archive.exists():
        fail('incomplete retained preservation; inspect the existing archive before retry')
    entries = {}
    size = 0
    for name in ('data', 'media'):
        directory = host / name
        if directory.is_symlink():
            fail('retained root is a symlink')
        if not directory.exists():
            continue
        for entry in chain([directory], directory.rglob('*')):
            mode = entry.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                fail('retained data contains unsupported entries')
            if entry.is_file():
                size += entry.stat().st_size
                if len(entries) >= 100000 or size > 10 * 1024**3:
                    fail('retained preservation exceeds its file or size bound')
                entries[str(entry.relative_to(host))] = {'bytes': entry.stat().st_size}
    if shutil.disk_usage(backups).free < size * 2 + 64 * 1024**2:
        fail('retained preservation exceeds its file, size or free-space bound')
    identities = {(p.stat().st_dev, p.stat().st_ino) for p in (host / name for name in entries)}
    for fd in Path('/proc').glob('[0-9]*/fd/*'):
        try:
            info = fd.stat()
            if (info.st_dev, info.st_ino) not in identities:
                continue
            flags = next(line.split()[1] for line in (fd.parent.parent / 'fdinfo' / fd.name).read_text().splitlines() if line.startswith('flags:'))
            if int(flags, 8) & os.O_ACCMODE:
                fail('a retained-data writer is still open; stop every writer before preservation')
        except (FileNotFoundError, ProcessLookupError):
            continue
    for name, item in entries.items():
        item['sha256'] = digest(host / name)
    old_umask = os.umask(0o077)
    try:
        with tarfile.open(archive, 'x') as target:
            for name in ('data', 'media'):
                if (host / name).exists():
                    target.add(host / name, arcname=name)
        with open(archive, 'rb') as stream:
            os.fsync(stream.fileno())
        after = {str(entry.relative_to(host)) for root in ('data', 'media') for entry in (host / root).rglob('*') if entry.is_file()}
        if after != set(entries) or any(digest(host / name) != item['sha256'] for name, item in entries.items()):
            fail('retained files changed during preservation; keep writers stopped')
        tables = {}
        schema = []
        if 'data/rewind.sqlite' in entries:
            # Replay WAL only in an owned copy, never migrate/checkpoint source.
            with tempfile.TemporaryDirectory(dir=backups, prefix='.retained-check-') as work:
                for suffix in ('', '-wal', '-shm'):
                    source = host / ('data/rewind.sqlite' + suffix)
                    if source.exists():
                        shutil.copyfile(source, Path(work) / ('rewind.sqlite' + suffix))
                database = sqlite3.connect(str(Path(work) / 'rewind.sqlite'))
                try:
                    if database.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        fail('retained SQLite integrity check failed')
                    schema = database.execute('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').fetchall()
                    for (name,) in database.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
                        quoted = '"' + name.replace('"', '""') + '"'
                        tables[name] = {'rows': database.execute('SELECT COUNT(*) FROM ' + quoted).fetchone()[0]}
                finally:
                    database.close()
            (host / 'database-maintenance').write_text('release\n')
            (host / 'database-maintenance-mode').write_text('import\n')
            for name in ('database-maintenance', 'database-maintenance-mode'):
                os.chown(host / name, host.stat().st_uid, host.stat().st_gid)
        report = {'environment': 'release', 'sqlitePresent': 'data/rewind.sqlite' in entries,
                  'files': entries, 'tables': tables, 'schema': schema, 'archiveSha256': digest(archive)}
        temporary = inventory.with_suffix('.tmp')
        with open(temporary, 'x') as stream:
            stream.write(json.dumps(report, sort_keys=True) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(inventory)
        directory_fd = os.open(backups, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        retained_summary(report)
    finally:
        os.umask(old_umask)


def check_maintenance(host, status_path=None):
    host = Path(host)
    environment = (host / 'database-maintenance').read_text().strip()
    if environment not in ('release', 'dev'):
        fail('invalid maintenance environment')
    settings = dict(line.split('=', 1) for line in (host / 'rewind.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
    if settings.get('REWIND_MEDIA_ENVIRONMENT') != environment or settings.get('REWIND_DATABASE_ENVIRONMENT') != environment:
        fail('maintenance environment mismatch')
    if (host / 'database-maintenance-mode').read_text().strip() != 'import':
        fail('recovery maintenance requires explicit resume')
    receipt = json.loads((host / 'database-reconciled.json').read_text())
    if receipt.get('environment') != environment or receipt.get('finalSnapshot') is not True:
        fail('no successful final-snapshot reconciliation for this environment')
    manifest = receipt.get('manifest', '')
    if not re.fullmatch(r'rewind-[0-9]{8}T[0-9]{6}Z\.manifest\.json', manifest):
        fail('invalid reconciled manifest')
    if digest(host / 'backups' / manifest) != receipt.get('manifestSha256'):
        fail('final manifest changed after reconciliation')
    tables = receipt.get('reconciliation', {}).get('tables')
    if not tables or len({t['table'] for t in tables}) != len(tables):
        fail('missing or duplicate reconciliation tables')
    if status_path:
        status = json.loads(Path(status_path).read_text())
        actual = [t for t in status['tables'] if t['table'] not in ('schema_migrations', 'schema_migration_markers', 'rewind_database_environment')]
        if (not status.get('ready') or status.get('environment') != environment or
                sorted(actual, key=lambda t: t['table']) != sorted(tables, key=lambda t: t['table'])):
            fail('PostgreSQL changed after final reconciliation')


def extract_source(source, destination):
    """Extract only regular files and directories beneath a fresh destination."""
    destination = Path(destination).resolve()
    seen_paths = set()
    template_hash = None
    for member in source:
        parts = Path(member.name).parts
        if (member.name.startswith("/") or "\\" in member.name or ".." in parts
                or not (member.name.startswith("deploy/") or member.name == "deploy"
                        or member.name == "infra/terraform/demo/cloud-init.sh"
                        or member.name in ("infra", "infra/terraform", "infra/terraform/demo"))
                or not (member.isfile() or member.isdir())):
            fail("release source contains an unsafe or unexpected path")
        if member.name in seen_paths:
            fail("release source contains a duplicate path")
        seen_paths.add(member.name)

        target = (destination / member.name).resolve()
        if target != destination and destination not in target.parents:
            fail("release source contains an unsafe or unexpected path")
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.extractfile(member) as content, open(target, "xb") as output:
            shutil.copyfileobj(content, output)
        if member.name == "deploy/rewind.env.example":
            template_hash = hashlib.sha256(target.read_bytes()).hexdigest()
    return template_hash


def image_id(image_tar, image, sha):
    with tarfile.open(image_tar, "r") as archive:
        entries = json.load(archive.extractfile("manifest.json"))
        if len(entries) != 1 or entries[0].get("RepoTags") != [f"{image}:{sha}"]:
            fail(f"image tag does not match release SHA: {image}")
        config_path = entries[0].get("Config", "")
        match = re.fullmatch(r"(?:blobs/sha256/)?([0-9a-f]{64})(?:\.json)?", config_path)
        if not match:
            fail(f"image config digest missing: {image}")
        config_bytes = archive.extractfile(config_path).read()
        if hashlib.sha256(config_bytes).hexdigest() != match.group(1):
            fail(f"image config digest mismatch: {image}")
        config = json.loads(config_bytes)
        if config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != sha:
            fail(f"image revision label mismatch: {image}")
        return f"sha256:{match.group(1)}"


def build(output, green_sha, config_version, branch):
    sha = run("git", "rev-parse", "HEAD", output=True).decode().strip()
    if not SHA.fullmatch(sha) or green_sha != sha:
        fail("release requires the exact explicitly supplied green commit SHA")
    if not VERSION.fullmatch(config_version):
        fail("invalid configuration version")
    if not BRANCH.fullmatch(branch) or ".." in branch or branch.startswith("/"):
        fail("invalid release branch")
    if run("git", "status", "--porcelain", "--untracked-files=all", output=True).strip():
        fail("release requires a clean checkout, including untracked files")
    try:
        head = run("git", "rev-parse", "--verify", f"refs/remotes/origin/{branch}", output=True).decode().strip()
    except subprocess.CalledProcessError:
        fail(f"release branch origin/{branch} is not available in this checkout")
    if sha != head:
        fail(f"release commit must equal origin/{branch}")
    remote = run("git", "remote", "get-url", "origin", output=True).decode().strip()
    match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[^/\s]+?)(?:\.git)?", remote)
    if not match:
        fail("origin must be a GitHub repository")
    receipt = json.loads(run("gh", "api", "-X", "GET",
                             f"repos/{match.group(1)}/actions/workflows/quality.yml/runs",
                             "-f", f"head_sha={sha}", "-f", f"branch={branch}", "-f", "event=push",
                             output=True))
    if not any(item.get("head_sha") == sha and item.get("head_branch") == branch
               and item.get("event") == "push" and item.get("conclusion") == "success"
               for item in receipt.get("workflow_runs", [])):
        fail(f"no successful {branch}-branch Quality checks run for this commit")
    with tempfile.TemporaryDirectory(prefix="rewind-release-") as temp:
        temp = Path(temp)
        with open(temp / "source.tar", "wb") as stream:
            subprocess.run(("git", "archive", sha, "deploy", "infra/terraform/demo/cloud-init.sh"), cwd=ROOT, check=True, stdout=stream)
        for name, dockerfile, image in (("runtime", "deploy/Dockerfile", "rewind-demo"), ("web", "deploy/web.Dockerfile", "rewind-demo-web")):
            # The version shows on every build except main (prod) (#491)
            build_args = ("--build-arg", f"REWIND_CURRENT_VERSION={branch}-{sha[:7]}",
                          "--build-arg", f"REWIND_DISPLAY_CURRENT_VERSION={str(branch != 'main').lower()}") if name == "web" else ()
            run("docker", "build", "--label", f"org.opencontainers.image.revision={sha}",
                *build_args, "-f", dockerfile, "-t", f"{image}:{sha}", ".")
            run("docker", "save", "-o", str(temp / f"{name}.tar"), f"{image}:{sha}")
        migration_source = (ROOT / "server/src/db.ts").read_text()
        versions = [int(number) for number in re.findall(r"\{\s*version:\s*(\d+)\s*,\s*key:", migration_source)]
        if not versions:
            fail("no declared schema migration versions")
        manifest = {"format": 1, "sha": sha, "config_version": config_version,
                    "config_template_sha256": digest(ROOT / "deploy/rewind.env.example"),
                    "schema_version": max(versions),
                    "files": {name: digest(temp / name) for name in FILES},
                    "images": {"runtime": image_id(temp / "runtime.tar", "rewind-demo", sha),
                               "web": image_id(temp / "web.tar", "rewind-demo-web", sha)}}
        (temp / "manifest.json").write_text(json.dumps(manifest, sort_keys=True) + "\n")
        output = Path(output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(output, "w") as bundle:
            for name in ("manifest.json", *FILES):
                bundle.add(temp / name, arcname=name, recursive=False)
    print(f"Release {sha} written to {output} (SHA-256 {digest(output)})")


def verify(bundle_path, extract=None):
    bundle_path = Path(bundle_path)
    with tempfile.TemporaryDirectory(prefix="rewind-verify-") as temp:
        temp = Path(temp)
        with tarfile.open(bundle_path, "r") as bundle:
            members = bundle.getmembers()
            if sorted(member.name for member in members) != sorted(("manifest.json", *FILES)) or any(not member.isfile() or member.name != Path(member.name).name for member in members):
                fail("release bundle contains unexpected members")
            for member in members:
                with bundle.extractfile(member) as source, open(temp / member.name, "wb") as target:
                    while block := source.read(1024 * 1024):
                        target.write(block)
        manifest = json.loads((temp / "manifest.json").read_text())
        if (manifest.get("format") != 1 or not SHA.fullmatch(str(manifest.get("sha", "")))
                or not VERSION.fullmatch(str(manifest.get("config_version", "")))
                or not isinstance(manifest.get("schema_version"), int)
                or manifest.get("schema_version") < 1
                or set(manifest.get("files", {})) != set(FILES)
                or not re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("config_template_sha256", "")))
                or set(manifest.get("images", {})) != {"runtime", "web"}):
            fail("invalid release manifest")
        for name in FILES:
            if digest(temp / name) != manifest["files"][name]:
                fail(f"release artifact checksum mismatch: {name}")
        for name, image, key in (("runtime.tar", "rewind-demo", "runtime"), ("web.tar", "rewind-demo-web", "web")):
            if image_id(temp / name, image, manifest["sha"]) != manifest["images"][key]:
                fail(f"image ID mismatch: {name}")
        with tarfile.open(temp / "source.tar", "r") as source:
            template_hash = None
            # The destination is newly created under the private temporary tree.
            source_destination = temp / "source"
            source_destination.mkdir()
            template_hash = extract_source(source, source_destination)
            if template_hash != manifest["config_template_sha256"]:
                fail("configuration template revision mismatch")
        if extract:
            destination = Path(extract)
            if destination.exists():
                fail("release destination already exists")
            destination.mkdir(parents=True)
            for name in ("manifest.json", *FILES):
                shutil.copyfile(temp / name, destination / name)
            with tarfile.open(temp / "source.tar", "r") as source:
                extract_source(source, destination / "source")
        print(manifest["sha"])
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("build")
    create.add_argument("--green-sha", required=True)
    create.add_argument("--config-version", required=True)
    create.add_argument("--output", required=True)
    create.add_argument("--branch", default="main",
                        help="origin branch whose Quality run gates this release (default: main)")
    check = commands.add_parser("verify")
    check.add_argument("bundle")
    check.add_argument("--extract")
    retained = commands.add_parser("preserve-retained")
    retained.add_argument("host")
    maintenance = commands.add_parser("check-maintenance")
    maintenance.add_argument("host")
    maintenance.add_argument("--status")
    args = parser.parse_args()
    try:
        if args.command == "build":
            build(args.output, args.green_sha, args.config_version, args.branch)
        elif args.command == "preserve-retained":
            preserve_retained(args.host)
        elif args.command == "check-maintenance":
            check_maintenance(args.host, args.status)
        else:
            verify(args.bundle, args.extract)
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f"release rejected: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
