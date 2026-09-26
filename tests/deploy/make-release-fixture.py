#!/usr/bin/env python3
"""Construct a tiny checksum-valid bundle for cloud-free wake fixtures."""
import hashlib
import io
import json
import sys
import tarfile

sha, output = sys.argv[1:]


def tar_bytes(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, value in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(value)
            archive.addfile(member, io.BytesIO(value))
    return buffer.getvalue()


files = {
    "source.tar": tar_bytes({"deploy/compose.yaml": b"fixture\n"}),
    "runtime.tar": tar_bytes({"manifest.json": json.dumps([{"RepoTags": [f"rewind-demo:{sha}"]}]).encode()}),
    "web.tar": tar_bytes({"manifest.json": json.dumps([{"RepoTags": [f"rewind-demo-web:{sha}"]}]).encode()}),
}
manifest = {"format": 1, "sha": sha, "config_version": "fixture-v1", "schema_version": 17,
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
files["manifest.json"] = json.dumps(manifest).encode()
with open(output, "wb") as target:
    target.write(tar_bytes(files))
