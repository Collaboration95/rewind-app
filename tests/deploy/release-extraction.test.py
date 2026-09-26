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
