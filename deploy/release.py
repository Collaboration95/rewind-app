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

ROOT = Path(__file__).resolve().parent.parent
SHA = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"[A-Za-z0-9._-]{1,64}")
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


def build(output, green_sha, config_version):
    sha = run("git", "rev-parse", "HEAD", output=True).decode().strip()
    if not SHA.fullmatch(sha) or green_sha != sha:
        fail("release requires the exact explicitly supplied green commit SHA")
    if not VERSION.fullmatch(config_version):
        fail("invalid configuration version")
    if run("git", "status", "--porcelain", "--untracked-files=all", output=True).strip():
        fail("release requires a clean checkout, including untracked files")
    main = run("git", "rev-parse", "refs/remotes/origin/main", output=True).decode().strip()
    if sha != main:
        fail("release commit must equal origin/main")
    remote = run("git", "remote", "get-url", "origin", output=True).decode().strip()
    match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[^/\s]+?)(?:\.git)?", remote)
    if not match:
        fail("origin must be a GitHub repository")
    receipt = json.loads(run("gh", "api", "-X", "GET",
                             f"repos/{match.group(1)}/actions/workflows/quality.yml/runs",
                             "-f", f"head_sha={sha}", "-f", "branch=main", "-f", "event=push",
                             output=True))
    if not any(item.get("head_sha") == sha and item.get("head_branch") == "main"
               and item.get("event") == "push" and item.get("conclusion") == "success"
               for item in receipt.get("workflow_runs", [])):
        fail("no successful main-branch Quality checks run for this commit")
    with tempfile.TemporaryDirectory(prefix="rewind-release-") as temp:
        temp = Path(temp)
        with open(temp / "source.tar", "wb") as stream:
            subprocess.run(("git", "archive", sha, "deploy", "infra/terraform/demo/cloud-init.sh"), cwd=ROOT, check=True, stdout=stream)
        for name, dockerfile, image in (("runtime", "deploy/Dockerfile", "rewind-demo"), ("web", "deploy/web.Dockerfile", "rewind-demo-web")):
            run("docker", "build", "--label", f"org.opencontainers.image.revision={sha}", "-f", dockerfile, "-t", f"{image}:{sha}", ".")
            run("docker", "save", "-o", str(temp / f"{name}.tar"), f"{image}:{sha}")
        migration_source = (ROOT / "server/src/db.ts").read_text()
        versions = [int(number) for number in re.findall(r"\{ version: (\d+), key:", migration_source)]
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
            seen_paths = set()
            for member in source:
                if (member.name.startswith("/") or ".." in Path(member.name).parts
                        or not (member.name.startswith("deploy/") or member.name == "deploy"
                                or member.name == "infra/terraform/demo/cloud-init.sh"
                                or member.name in ("infra", "infra/terraform", "infra/terraform/demo"))
                        or not (member.isfile() or member.isdir())):
                    fail("release source contains an unsafe or unexpected path")
                if member.name in seen_paths:
                    fail("release source contains a duplicate path")
                seen_paths.add(member.name)
                if member.name == "deploy/rewind.env.example":
                    template_hash = hashlib.sha256(source.extractfile(member).read()).hexdigest()
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
                source.extractall(destination / "source")
        print(manifest["sha"])
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("build")
    create.add_argument("--green-sha", required=True)
    create.add_argument("--config-version", required=True)
    create.add_argument("--output", required=True)
    check = commands.add_parser("verify")
    check.add_argument("bundle")
    check.add_argument("--extract")
    args = parser.parse_args()
    try:
        if args.command == "build":
            build(args.output, args.green_sha, args.config_version)
        else:
            verify(args.bundle, args.extract)
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f"release rejected: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
