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


def image_bytes(image):
    config = json.dumps({"config": {"Labels": {"org.opencontainers.image.revision": sha}}}).encode()
    config_path = "blobs/sha256/" + hashlib.sha256(config).hexdigest()
    image_manifest = json.dumps([{"Config": config_path, "RepoTags": [f"{image}:{sha}"]}]).encode()
    return tar_bytes({"manifest.json": image_manifest, config_path: config})


template = b"fixture config template"
files = {
    "source.tar": tar_bytes({"deploy/compose.yaml": b"fixture\n", "deploy/rewind.env.example": template}),
    "runtime.tar": image_bytes("rewind-demo"),
    "web.tar": image_bytes("rewind-demo-web"),
}
config_hash = hashlib.sha256(template).hexdigest()
runtime_config = json.loads(tarfile.open(fileobj=io.BytesIO(files["runtime.tar"])).extractfile("manifest.json").read())[0]["Config"]
web_config = json.loads(tarfile.open(fileobj=io.BytesIO(files["web.tar"])).extractfile("manifest.json").read())[0]["Config"]
manifest = {"format": 1, "sha": sha, "config_version": "fixture-v1", "schema_version": 17,
            "config_template_sha256": config_hash,
            "images": {"runtime": "sha256:" + runtime_config.split("/")[-1],
                       "web": "sha256:" + web_config.split("/")[-1]},
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
files["manifest.json"] = json.dumps(manifest).encode()
with open(output, "wb") as target:
    target.write(tar_bytes(files))
