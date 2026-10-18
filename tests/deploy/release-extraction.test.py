#!/usr/bin/env python3
"""Focused safety tests for extracting the source archive in a release."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile

RELEASE = Path(__file__).resolve().parents[2] / "deploy" / "release.py"
spec = importlib.util.spec_from_file_location("rewind_release", RELEASE)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def archive_with(*members):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        for member, content in members:
            archive.addfile(member, io.BytesIO(content) if content is not None else None)
    stream.seek(0)
    return stream


with tempfile.TemporaryDirectory(prefix="rewind-release-extract-test-") as temp:
    root = Path(temp)
    safe_destination = root / "safe"
    safe_destination.mkdir()
    safe_member = tarfile.TarInfo("deploy/config/settings.json")
    safe_member.size = len(b"{}")
    with tarfile.open(fileobj=archive_with((safe_member, b"{}"))) as archive:
        release.extract_source(archive, safe_destination)
    assert (safe_destination / "deploy/config/settings.json").read_bytes() == b"{}"

    traversal_destination = root / "traversal"
    traversal_destination.mkdir()
    traversal_member = tarfile.TarInfo("deploy/../../escaped")
    traversal_member.size = len(b"escaped")
    try:
        with tarfile.open(fileobj=archive_with((traversal_member, b"escaped"))) as archive:
            release.extract_source(archive, traversal_destination)
    except ValueError as error:
        assert "unsafe" in str(error)
    else:
        raise AssertionError("parent traversal archive member was accepted")
    assert not (root / "escaped").exists()

    link_destination = root / "link"
    link_destination.mkdir()
    symlink = tarfile.TarInfo("deploy/link")
    symlink.type = tarfile.SYMTYPE
    symlink.linkname = "../../outside"
    payload = tarfile.TarInfo("deploy/link/pwned")
    payload.size = len(b"pwned")
    try:
        with tarfile.open(fileobj=archive_with((symlink, None), (payload, b"pwned"))) as archive:
            release.extract_source(archive, link_destination)
    except ValueError as error:
        assert "unsafe" in str(error)
    else:
        raise AssertionError("symlink archive member was accepted")
    assert not (root / "outside" / "pwned").exists()

print("release extraction safety tests passed")

def preserve(host):
    # Only the fixture supplies this seam; the live CLI always scans /proc
    # under release-host.sh's sudo invocation and fails on inaccessible FDs.
    proc = host / 'fixture-proc'
    proc.mkdir(exist_ok=True)
    release.preserve_retained(host, proc_root=proc)


# First activation must preserve the WAL as well as the main file and disk media.
import json
import shutil
import sqlite3
import hashlib
from unittest.mock import patch

with tempfile.TemporaryDirectory(prefix="rewind-retained-writer-test-") as temp:
    host = Path(temp)
    (host / 'data').mkdir()
    retained = host / 'data/live-file'
    retained.write_bytes(b'retained')
    proc = host / 'fixture-proc'
    (proc / '123/fd').mkdir(parents=True)
    (proc / '123/fdinfo').mkdir()
    fd = proc / '123/fd/0'
    fd.symlink_to(retained)
    (proc / '123/fdinfo/0').write_text('flags:\t02\n')
    try:
        preserve(host)
    except ValueError as error:
        assert 'writer is still open' in str(error)
    else:
        raise AssertionError('open retained-data writer was accepted')
    assert not (host / 'backups/first-start-retained.tar').exists()

    original_stat = Path.stat
    def inaccessible_fd(path, *args, **kwargs):
        if path == fd:
            raise PermissionError(13, 'fixture descriptor is inaccessible', str(fd))
        return original_stat(path, *args, **kwargs)
    with patch.object(Path, 'stat', inaccessible_fd):
        try:
            preserve(host)
        except PermissionError:
            pass
        else:
            raise AssertionError('inaccessible potential writer was silently skipped')
    assert not (host / 'backups/first-start-retained.tar').exists()

with tempfile.TemporaryDirectory(prefix="rewind-retained-test-") as temp:
    root = Path(temp)
    host = root / 'host'
    (host / 'data').mkdir(parents=True)
    (host / 'media').mkdir()
    source = sqlite3.connect(root / 'source.sqlite')
    source.execute('PRAGMA journal_mode=WAL')
    source.execute('CREATE TABLE retained (id INTEGER PRIMARY KEY, value TEXT)')
    source.execute("INSERT INTO retained VALUES (1, 'kept in WAL')")
    source.commit()
    for suffix in ('', '-wal', '-shm'):
        shutil.copyfile(root / ('source.sqlite' + suffix), host / ('data/rewind.sqlite' + suffix))
    source.close()
    (host / 'media' / 'clip.bin').write_bytes(b'retained media')
    before = {str(p.relative_to(host)): p.read_bytes() for p in host.rglob('*') if p.is_file()}
    preserve(host)
    report = json.loads((host / 'backups/first-start-inventory.json').read_text())
    assert report['sqlitePresent'] is True
    assert report['tables']['retained']['rows'] == 1
    assert 'data/rewind.sqlite-wal' in report['files']
    # Preservation must allow the qualified SQLite deployment to migrate this
    # retained, pre-application-schema database before the final import window.
    assert not (host / 'database-maintenance').exists()
    assert not (host / 'database-maintenance-mode').exists()
    for name, contents in before.items():
        assert (host / name).read_bytes() == contents
    with tarfile.open(host / 'backups/first-start-retained.tar') as archive:
        for name, contents in before.items():
            assert archive.extractfile(name).read() == contents
    preserve(host)  # idempotent and verifies the preserved archive
    assert not (host / 'database-maintenance').exists()
    with open(host / 'backups/first-start-retained.tar', 'ab') as stream:
        stream.write(b'changed')
    try:
        preserve(host)
    except ValueError:
        pass
    else:
        raise AssertionError('tampered preservation accepted')

with tempfile.TemporaryDirectory(prefix="rewind-empty-retained-test-") as temp:
    host = Path(temp)
    preserve(host)
    assert json.loads((host / 'backups/first-start-inventory.json').read_text())['sqlitePresent'] is False
    assert not (host / 'database-maintenance').exists()

with tempfile.TemporaryDirectory(prefix="rewind-retained-symlink-test-") as temp:
    host = Path(temp)
    (host / 'data').mkdir()
    (host / 'data/link').symlink_to('/etc/passwd')
    try:
        preserve(host)
    except ValueError:
        pass
    else:
        raise AssertionError('retained symlink accepted')

with tempfile.TemporaryDirectory(prefix="rewind-reconciliation-test-") as temp:
    host = Path(temp)
    (host / 'backups').mkdir()
    (host / 'database-maintenance').write_text('release\n')
    (host / 'database-maintenance-mode').write_text('import\n')
    (host / 'rewind.env').write_text('REWIND_MEDIA_ENVIRONMENT=release\nREWIND_DATABASE_ENVIRONMENT=release\n')
    manifest = 'rewind-20261018T000000Z.manifest.json'
    (host / 'backups' / manifest).write_text('{}')
    table = {'table': 'retained', 'rows': 1, 'sha256': 'a' * 64}
    receipt = {'environment': 'release', 'manifest': manifest, 'manifestSha256': hashlib.sha256(b'{}').hexdigest(),
               'finalSnapshot': True, 'reconciliation': {'tables': [table]}}
    status = {'ready': True, 'environment': 'release', 'tables': [table]}
    status_path = host / 'status.json'
    status_path.write_text(json.dumps(status))
    for change in ({'environment': 'dev'}, {'finalSnapshot': False}, {'manifestSha256': 'b' * 64}):
        (host / 'database-reconciled.json').write_text(json.dumps({**receipt, **change}))
        try:
            release.check_maintenance(host, status_path)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid reconciliation accepted')
        assert (host / 'database-maintenance').exists()
    (host / 'database-reconciled.json').write_text(json.dumps(receipt))
    release.check_maintenance(host, status_path)
    status['tables'] = [{**table, 'sha256': 'b' * 64}]
    status_path.write_text(json.dumps(status))
    try:
        release.check_maintenance(host, status_path)
    except ValueError:
        pass
    else:
        raise AssertionError('same-count changed content accepted')
    assert (host / 'database-maintenance').exists()

print('retained preservation and maintenance reconciliation tests passed')
