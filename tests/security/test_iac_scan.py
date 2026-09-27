"""Exercise the IaC gate against accepted and unexpected Trivy results."""

import json
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
POLICY = json.loads((ROOT / ".github/iac-scan-exceptions.json").read_text())


def report_for(policy):
    return {
        "Results": [
            {
                "Target": item["target"],
                "Misconfigurations": [
                    {
                        "ID": item["id"],
                        "Severity": "HIGH",
                        "CauseMetadata": {"Resource": item["resource"]},
                    }
                ],
            }
            for item in policy["exceptions"]
        ]
    }


class IaCScanGateTests(unittest.TestCase):
    def gate(self, report, policy=None):
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "report.json"
            policy_path = Path(directory) / "policy.json"
            report_path.write_text(json.dumps(report))
            policy_path.write_text(json.dumps(policy or POLICY))
            return subprocess.run(
                [sys.executable, str(ROOT / "scripts/check-iac-scan.py"), str(report_path), str(policy_path)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )

    def test_exact_unexpired_findings_pass(self):
        result = self.gate(report_for(POLICY))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unexpected_high_finding_fails(self):
        report = report_for(POLICY)
        report["Results"].append(
            {"Target": "infra/terraform/demo/new.tf", "Misconfigurations": [
                {"ID": "NEW-0001", "Severity": "HIGH", "CauseMetadata": {"Resource": "aws_s3_bucket.new"}}
            ]}
        )
        result = self.gate(report)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unaccepted HIGH finding", result.stderr)

    def test_new_resource_under_existing_rule_fails(self):
        report = report_for(POLICY)
        report["Results"][0]["Misconfigurations"][0]["CauseMetadata"]["Resource"] = "data.aws_iam_policy_document.new"
        result = self.gate(report)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unaccepted HIGH finding", result.stderr)

    def test_expired_exception_fails(self):
        policy = deepcopy(POLICY)
        policy["exceptions"][0]["expires"] = "2000-01-01"
        result = self.gate(report_for(policy), policy)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expired exception", result.stderr)

    def test_duplicate_exception_fails(self):
        policy = deepcopy(POLICY)
        policy["exceptions"].append(deepcopy(policy["exceptions"][0]))
        result = self.gate(report_for(POLICY), policy)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate exception", result.stderr)

    def test_missing_scan_results_fail(self):
        for report in ({}, {"Results": []}):
            with self.subTest(report=report):
                result = self.gate(report)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("missing or empty Trivy scan results", result.stderr)


if __name__ == "__main__":
    unittest.main()
