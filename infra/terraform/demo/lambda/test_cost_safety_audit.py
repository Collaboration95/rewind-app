import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("cost_safety_audit.py")
SPEC = importlib.util.spec_from_file_location("cost_safety_audit", MODULE_PATH)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


VALID_RULES = [
    {
        "ID": "expire-demo-backups",
        "Status": "Enabled",
        "Filter": {"Prefix": "rewind-demo/"},
        "Expiration": {"Days": 30},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 7},
    }
]
VALID_INSTANCE = {
    "state": {"name": "stopped"},
    "tags": [{"key": "Environment", "value": "demo"}],
}
VALID_IP = {"name": "rewind-demo-ip", "attachedTo": "rewind-demo", "isAttached": True}


class FakeLightsail:
    def __init__(self, snapshot_pages=None, distribution_pages=None):
        self.snapshot_pages = snapshot_pages or [{"instanceSnapshots": []}]
        self.distribution_pages = distribution_pages or [{"distributions": []}]
        self.snapshot_calls = []
        self.distribution_calls = []
        self.instance_calls = []
        self.ip_calls = []

    def get_instance(self, **kwargs):
        self.instance_calls.append(kwargs)
        return {"instance": VALID_INSTANCE}

    def get_static_ip(self, **kwargs):
        self.ip_calls.append(kwargs)
        return {"staticIp": VALID_IP}

    def get_instance_snapshots(self, **kwargs):
        self.snapshot_calls.append(kwargs)
        return self.snapshot_pages[len(self.snapshot_calls) - 1]

    def get_distributions(self, **kwargs):
        self.distribution_calls.append(kwargs)
        return self.distribution_pages[len(self.distribution_calls) - 1]


class FakeS3:
    def __init__(self, rules=VALID_RULES):
        self.rules = rules
        self.calls = []

    def get_bucket_lifecycle_configuration(self, **kwargs):
        self.calls.append(kwargs)
        return {"Rules": self.rules}


class CostSafetyAuditTest(unittest.TestCase):
    def report(self, **overrides):
        values = {
            "instance": VALID_INSTANCE,
            "static_ip": VALID_IP,
            "snapshots": [],
            "distributions": [],
            "lifecycle_rules": VALID_RULES,
            "instance_name": "rewind-demo",
            "expected_snapshot_names": set(),
            "expected_distributions": {},
        }
        values.update(overrides)
        return audit.evaluate(**values)

    def test_expected_stopped_demo_passes(self):
        report = self.report()
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["issues"], [])

    def test_running_or_wrongly_tagged_demo_is_actionable(self):
        report = self.report(instance={"state": {"name": "running"}, "tags": []})
        self.assertEqual(report["status"], "fail")
        self.assertEqual(report["issues"], ["instance_not_stopped", "instance_not_tagged_demo"])

    def test_unexpected_snapshot_distribution_and_bad_origin_fail(self):
        report = self.report(
            snapshots=[{"name": "unapproved-snapshot"}],
            distributions=[
                {
                    "name": "rewind-web",
                    "isEnabled": False,
                    "origin": {"name": "wrong-origin"},
                }
            ],
            expected_distributions={"rewind-web": "rewind-demo"},
        )
        self.assertEqual(report["status"], "fail")
        self.assertEqual(
            report["issues"],
            ["unexpected_snapshot", "expected_distribution_disabled", "distribution_origin_mismatch"],
        )

    def test_wrong_lifecycle_prefix_and_unattached_ip_fail(self):
        report = self.report(
            static_ip={"name": "rewind-demo-ip", "attachedTo": None, "isAttached": False},
            lifecycle_rules=[{**VALID_RULES[0], "Filter": {"Prefix": "wrong/"}}],
        )
        self.assertEqual(
            report["issues"],
            ["static_ip_unattached_or_misattached", "backup_lifecycle_misconfigured"],
        )

    def test_run_audit_paginates_snapshots_and_checks_empty_distribution_allowlist(self):
        lightsail = FakeLightsail(
            snapshot_pages=[
                {"instanceSnapshots": [{"name": "expected-snapshot"}], "nextPageToken": "next"},
                {"instanceSnapshots": []},
            ]
        )
        distributions = FakeLightsail()
        report = audit.run_audit(
            lightsail,
            distributions,
            FakeS3(),
            "rewind-demo",
            "rewind-demo-ip",
            "backup-bucket",
            ["expected-snapshot"],
            {},
        )
        self.assertEqual(report["status"], "pass")
        self.assertEqual(lightsail.instance_calls, [{"instanceName": "rewind-demo"}])
        self.assertEqual(lightsail.ip_calls, [{"staticIpName": "rewind-demo-ip"}])
        self.assertEqual(lightsail.snapshot_calls, [{}, {"pageToken": "next"}])
        self.assertEqual(distributions.distribution_calls, [{}])

    def test_unconfigured_distribution_is_actionable(self):
        report = self.report(
            distributions=[
                {
                    "name": "unapproved-distribution",
                    "isEnabled": True,
                    "origin": {"name": "rewind-demo"},
                }
            ]
        )
        self.assertEqual(report["issues"], ["unexpected_distribution"])

    def test_handler_uses_a_separate_virginia_distribution_client(self):
        regional = FakeLightsail()
        global_client = FakeLightsail(
            distribution_pages=[
                {
                    "distributions": [
                        {
                            "name": "rewind-web",
                            "isEnabled": True,
                            "origin": {"name": "rewind-demo"},
                        }
                    ]
                }
            ]
        )
        s3 = FakeS3()
        calls = []

        def client(name, **kwargs):
            calls.append((name, kwargs))
            if name == "s3":
                return s3
            return global_client if kwargs.get("region_name") == "us-east-1" else regional

        fake_boto3 = types.SimpleNamespace(client=client)
        environment = {
            **os.environ,
            "INSTANCE_NAME": "rewind-demo",
            "STATIC_IP_NAME": "rewind-demo-ip",
            "BACKUP_BUCKET": "backup-bucket",
            "EXPECTED_SNAPSHOT_NAMES": "[]",
            "EXPECTED_DISTRIBUTIONS": '{"rewind-web":"rewind-demo"}',
        }
        with patch.dict(sys.modules, {"boto3": fake_boto3}), patch.dict(os.environ, environment, clear=True):
            report = audit.handler({}, None)
        self.assertEqual(report["status"], "pass")
        self.assertEqual(
            calls,
            [("lightsail", {}), ("lightsail", {"region_name": "us-east-1"}), ("s3", {})],
        )
        self.assertEqual(global_client.distribution_calls, [{}])


if __name__ == "__main__":
    unittest.main()
