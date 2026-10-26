#!/usr/bin/env python3
"""Scan the verified bundle's saved images before any host upload."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

import release

SEVERITIES = ("UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL")


def vulnerability_counts(report, expected_id):
    if report.get("Metadata", {}).get("ImageID") != expected_id:
        raise ValueError("Trivy report image ID differs from the verified bundle")
    if not isinstance(report.get("Results"), list):
        raise ValueError("Trivy did not return vulnerability scan results")
    counts = Counter({severity: 0 for severity in SEVERITIES})
    for result in report["Results"]:
        for finding in result.get("Vulnerabilities", []):
            severity = finding["Severity"]
            if severity not in SEVERITIES:
                raise ValueError(f"unknown vulnerability severity: {severity}")
            counts[severity] += 1
    return dict(counts)


def image_manifest_digests(path):
    # Docker's OCI save format contains registry-style manifest digests. Older
    # Docker archives do not; their archive and config digests still bind bytes.
    with tarfile.open(path) as archive:
        if "index.json" not in archive.getnames():
            return []
        index = json.load(archive.extractfile("index.json"))
        return [entry["digest"] for entry in index["manifests"]]


def scan(bundle, output, version):
    output.mkdir(parents=True, exist_ok=False)
    extracted = output / "images"
    verified = release.verify(bundle, extracted)
    if verified["sha"] != os.environ["GITHUB_SHA"]:
        raise ValueError("bundle commit differs from workflow commit")
    cache = output / "cache"
    cache.mkdir()
    trivy = ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
             "-v", f"{output.resolve()}:/work", f"aquasec/trivy:{version.removeprefix('v')}",
             "image", "--cache-dir", "/work/cache", "--scanners", "vuln"]
    images = {}
    files = {"rewind-release.tar": release.digest(bundle)}
    for name in ("runtime", "web"):
        archive = extracted / f"{name}.tar"
        sbom = output / f"sbom-{name}.cdx.json"
        report = output / f"trivy-{name}.json"
        for fmt, path in (("cyclonedx", sbom), ("json", report)):
            subprocess.run([*trivy, "--input", f"/work/images/{name}.tar",
                            "--format", fmt, "--exit-code", "0",
                            "--output", f"/work/{path.name}"], check=True)
        if json.loads(sbom.read_text()).get("bomFormat") != "CycloneDX":
            raise ValueError("Trivy did not produce a CycloneDX SBOM")
        findings = json.loads(report.read_text())
        images[name] = {
            "image_id": verified["images"][name],
            "archive_digest": f"sha256:{release.digest(archive)}",
            "manifest_digests": image_manifest_digests(archive),
            "repo_digests": findings.get("Metadata", {}).get("RepoDigests", []),
            "counts": vulnerability_counts(findings, verified["images"][name]),
        }
        for path in (sbom, report):
            files[path.name] = release.digest(path)
    blocked = any(image["counts"][s] for image in images.values() for s in ("HIGH", "CRITICAL"))
    manifest = {
        "format": 1,
        "commit": verified["sha"],
        "run_id": os.environ["GITHUB_RUN_ID"],
        "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"],
        "workflow": os.environ["GITHUB_WORKFLOW"],
        "workflow_ref": os.environ["GITHUB_WORKFLOW_REF"],
        "quality_run_id": os.environ["REWIND_QUALITY_RUN_ID"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "scanner": {"name": "Trivy", "version": version},
        "security_gate": "fail" if blocked else "pass",
        "images": images,
        "sha256": files,
    }
    (output / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    summary = ["### Deployed bundle security gate", "",
               "| Image | HIGH | CRITICAL | Gate |", "| --- | ---: | ---: | --- |"]
    for name, image in images.items():
        counts = image["counts"]
        summary.append(f"| {name} | {counts['HIGH']} | {counts['CRITICAL']} | {'FAIL' if counts['HIGH'] + counts['CRITICAL'] else 'PASS'} |")
    summary += ["", "Scanned the verified bundle archives; no image rebuild. Manifest binds the bundle, SBOMs and JSON reports by SHA-256.",
                "Registry digests may be empty for locally built images; archive digests identify the shipped bytes.", ""]
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write("\n".join(summary))
    if blocked:
        raise ValueError("HIGH/CRITICAL vulnerabilities block host upload; reports retained")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--trivy-version", required=True)
    args = parser.parse_args()
    try:
        scan(args.bundle, args.output, args.trivy_version)
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f"release scan rejected: {error}", file=sys.stderr)
        sys.exit(1)
