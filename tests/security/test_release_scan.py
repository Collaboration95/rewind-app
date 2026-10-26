"""Security boundary tests: wrong images and findings must prevent transfer."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"
sys.path.insert(0, str(DEPLOY))
spec = importlib.util.spec_from_file_location("scan_release", DEPLOY / "scan-release.py")
scan_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan_release)
SHA = "a" * 40
IMAGE_ID = "sha256:" + "b" * 64


class ReleaseScanTests(unittest.TestCase):
    def exercise(self, severity=None, wrong_id=False, scanner_error=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / "release.tar"
            bundle.write_bytes(b"verified bundle")
            output = root / "security"
            commands = []

            def verify(_bundle, extracted):
                extracted.mkdir()
                for name in ("runtime", "web"):
                    with tarfile.open(extracted / f"{name}.tar", "w") as archive:
                        data = b"[]"
                        member = tarfile.TarInfo("manifest.json")
                        member.size = len(data)
                        archive.addfile(member, io.BytesIO(data))
                return {"sha": SHA, "images": {"runtime": IMAGE_ID, "web": IMAGE_ID}}

            def trivy(command, **_kwargs):
                commands.append(command)
                if scanner_error:
                    raise scan_release.subprocess.CalledProcessError(2, command)
                filename = command[-1].removeprefix("/work/")
                data = {"bomFormat": "CycloneDX"} if "--format" in command and command[command.index("--format") + 1] == "cyclonedx" else {
                    "Metadata": {"ImageID": "wrong" if wrong_id else IMAGE_ID},
                    "Results": [{"Vulnerabilities": [{"Severity": severity}]}] if severity else [],
                }
                (output / filename).write_text(json.dumps(data))

            environment = {
                "GITHUB_SHA": SHA, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2",
                "GITHUB_WORKFLOW": "Deploy dev", "GITHUB_WORKFLOW_REF": "repo/deploy@dev",
                "REWIND_QUALITY_RUN_ID": "456", "GITHUB_STEP_SUMMARY": str(root / "summary"),
            }
            error = None
            with patch.dict(os.environ, environment), patch.object(scan_release.release, "verify", verify), patch.object(scan_release.subprocess, "run", trivy):
                try:
                    scan_release.scan(bundle, output, "v0.70.0")
                except (ValueError, scan_release.subprocess.CalledProcessError) as caught:
                    error = caught
            manifest_path = output / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
            if manifest:
                for name, digest in manifest["sha256"].items():
                    path = bundle if name == "rewind-release.tar" else output / name
                    self.assertEqual(digest, scan_release.release.digest(path))
            return error, manifest, commands

    def test_clean_images_bind_all_reports_and_workflow_identity(self):
        error, manifest, commands = self.exercise()
        self.assertIsNone(error)
        self.assertEqual(manifest["security_gate"], "pass")
        self.assertEqual(manifest["quality_run_id"], "456")
        self.assertEqual(manifest["run_attempt"], "2")
        self.assertEqual(len(manifest["sha256"]), 5)
        self.assertEqual(len(commands), 4)
        for command in commands:
            self.assertIn("--input", command)
            self.assertNotIn("build", command)

    def test_each_blocking_severity_keeps_both_image_reports_before_failing(self):
        for severity in ("HIGH", "CRITICAL"):
            with self.subTest(severity=severity):
                error, manifest, commands = self.exercise(severity)
                self.assertIsInstance(error, ValueError)
                self.assertEqual(manifest["security_gate"], "fail")
                self.assertEqual(manifest["images"]["web"]["counts"][severity], 1)
                self.assertEqual(len(commands), 4)

    def test_mismatched_scan_identity_is_rejected(self):
        error, manifest, _ = self.exercise(wrong_id=True)
        self.assertIsInstance(error, ValueError)
        self.assertIsNone(manifest)

    def test_scanner_failure_never_becomes_a_clean_manifest(self):
        error, manifest, _ = self.exercise(scanner_error=True)
        self.assertIsInstance(error, scan_release.subprocess.CalledProcessError)
        self.assertIsNone(manifest)


if __name__ == "__main__":
    unittest.main()
