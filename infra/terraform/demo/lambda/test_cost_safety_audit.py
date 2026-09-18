import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("cost_safety_audit.py")
sys.path.insert(0, str(MODULE_PATH.parent))
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


class FakeAwsError(Exception):
    def __init__(self, code, message="mocked AWS read error"):
        super().__init__(message)
        self.response = {"Error": {"Code": code}}


class FakeLightsail:
    def __init__(
        self,
        snapshot_pages=None,
        distribution_pages=None,
        instance=VALID_INSTANCE,
        static_ip=VALID_IP,
        instance_error=None,
        static_ip_error=None,
        snapshot_error=None,
        distribution_error=None,
    ):
        self.snapshot_pages = snapshot_pages or [{"instanceSnapshots": []}]
        self.distribution_pages = distribution_pages or [{"distributions": []}]
        self.instance = instance
        self.static_ip = static_ip
        self.instance_error = instance_error
        self.static_ip_error = static_ip_error
        self.snapshot_error = snapshot_error
        self.distribution_error = distribution_error
        self.snapshot_calls = []
        self.distribution_calls = []
        self.instance_calls = []
        self.ip_calls = []

    def get_instance(self, **kwargs):
        self.instance_calls.append(kwargs)
        if self.instance_error:
            raise self.instance_error
        return {"instance": self.instance}

    def get_static_ip(self, **kwargs):
        self.ip_calls.append(kwargs)
        if self.static_ip_error:
            raise self.static_ip_error
        return {"staticIp": self.static_ip}

    def get_instance_snapshots(self, **kwargs):
        self.snapshot_calls.append(kwargs)
        if self.snapshot_error:
            raise self.snapshot_error
        return self.snapshot_pages[len(self.snapshot_calls) - 1]

    def get_distributions(self, **kwargs):
        self.distribution_calls.append(kwargs)
        if self.distribution_error:
            raise self.distribution_error
        return self.distribution_pages[len(self.distribution_calls) - 1]


class FakeS3:
    def __init__(self, rules=VALID_RULES, error=None):
        self.rules = rules
        self.error = error
        self.calls = []

    def get_bucket_lifecycle_configuration(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
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

    def test_expected_state_matrix_has_distinct_non_error_outcomes(self):
        active = self.report()
        demo_off = self.report(
            instance={},
            static_ip=None,
            instance_expected=False,
            static_ip_expected=False,
        )

        self.assertEqual(active["status"], "pass")
        self.assertEqual(active["expected_state"], "approved_active_demo")
        self.assertEqual(demo_off["status"], "pass")
        self.assertEqual(demo_off["expected_state"], "demo_off")
        self.assertEqual(
            set(audit.EXPECTED_STATE_MATRIX),
            {"demo_off", "approved_active_demo"},
        )

    def test_demo_off_allows_an_explicitly_retained_unattached_static_ip(self):
        report = self.report(
            instance={},
            static_ip={"name": "rewind-demo-ip", "attachedTo": None, "isAttached": False},
            instance_expected=False,
            static_ip_expected=True,
        )

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["issues"], [])
        self.assertTrue(report["resources"]["static_ip_expected"])

    def test_demo_off_reports_missing_explicitly_retained_static_ip(self):
        report = self.report(
            instance={},
            static_ip=None,
            instance_expected=False,
            static_ip_expected=True,
        )

        self.assertEqual(report["issues"], ["retained_static_ip_missing"])
        self.assertEqual(
            report["findings"][0]["expected_state"],
            "present_and_unattached_for_retention",
        )

    def test_demo_off_rejects_billable_compute_and_unexpected_unattached_ip(self):
        report = self.report(
            instance=VALID_INSTANCE,
            static_ip={"name": "rewind-demo-ip", "attachedTo": None, "isAttached": False},
            instance_expected=False,
            static_ip_expected=False,
        )

        self.assertEqual(
            report["issues"],
            ["instance_present_while_demo_off", "static_ip_present_while_demo_off"],
        )
        self.assertEqual(report["findings"][0]["severity"], "error")
        self.assertEqual(
            report["findings"][1]["resource_identifier_class"],
            "lightsail_static_ip",
        )

    def test_hibernated_demo_rejects_attached_static_ip(self):
        report = self.report(
            instance_expected=False,
            static_ip_expected=False,
        )
        self.assertEqual(
            report["issues"],
            ["instance_present_while_demo_off", "static_ip_attached_while_demo_off"],
        )

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

    def test_findings_do_not_expose_resource_names_or_read_errors(self):
        report = self.report(
            snapshots=[{"name": "unapproved-snapshot"}],
            distributions=[{"name": "unapproved-distribution", "isEnabled": True}],
        )
        serialized = json.dumps(report, sort_keys=True)
        self.assertNotIn("unapproved-snapshot", serialized)
        self.assertNotIn("unapproved-distribution", serialized)
        self.assertNotIn("rewind-demo-ip", serialized)
        for finding in report["findings"]:
            self.assertEqual(
                set(finding),
                {"code", "severity", "resource_identifier_class", "expected_state", "remediation"},
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

    def test_missing_optional_resources_are_expected_when_demo_is_off(self):
        lightsail = FakeLightsail(
            instance_error=FakeAwsError("NotFound"),
            static_ip_error=FakeAwsError("NoSuchResource"),
        )
        report = audit.run_audit(
            lightsail,
            FakeLightsail(),
            FakeS3(),
            "rewind-demo",
            "rewind-demo-ip",
            "backup-bucket",
            [],
            {},
            instance_expected=False,
            static_ip_expected=False,
        )
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["issues"], [])
        self.assertFalse(report["resources"]["instance_present"])
        self.assertFalse(report["resources"]["static_ip_present"])

    def test_missing_lifecycle_configuration_is_a_safe_actionable_failure(self):
        report = audit.run_audit(
            FakeLightsail(),
            FakeLightsail(),
            FakeS3(error=FakeAwsError("NoSuchLifecycleConfiguration")),
            "rewind-demo",
            "rewind-demo-ip",
            "backup-bucket",
            [],
            {},
        )
        self.assertEqual(report["issues"], ["backup_lifecycle_misconfigured"])

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

    def test_handler_redacts_unexpected_read_errors(self):
        regional = FakeLightsail()
        global_client = FakeLightsail(
            distribution_error=FakeAwsError(
                "AccessDenied",
                "secret-bucket/rewind-demo/private-object should not be logged",
            )
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
            "EXPECTED_DISTRIBUTIONS": "{}",
        }
        printed = []
        with (
            patch.dict(sys.modules, {"boto3": fake_boto3}),
            patch.dict(os.environ, environment, clear=True),
            patch("builtins.print", side_effect=printed.append),
        ):
            with self.assertRaisesRegex(RuntimeError, "audit_read_failed"):
                audit.handler({}, None)

        self.assertEqual(calls, [("lightsail", {}), ("lightsail", {"region_name": "us-east-1"}), ("s3", {})])
        self.assertEqual(len(printed), 1)
        self.assertNotIn("AccessDenied", printed[0])
        self.assertNotIn("private-object", printed[0])
        self.assertIn('"resource_identifier_class":"aws_inventory_read"', printed[0])

    def test_handler_logs_notification_failure_without_masking_audit_failure(self):
        regional = FakeLightsail(
            instance={
                "state": {"name": "running"},
                "tags": [{"key": "Environment", "value": "demo"}],
            }
        )
        global_client = FakeLightsail()
        s3 = FakeS3()

        class FakeSns:
            def publish(self, **_kwargs):
                raise FakeAwsError("AccessDenied", "private notification detail")

        sns = FakeSns()

        def client(name, **kwargs):
            if name == "s3":
                return s3
            if name == "sns":
                return sns
            return global_client if kwargs.get("region_name") == "us-east-1" else regional

        fake_boto3 = types.SimpleNamespace(client=client)
        environment = {
            **os.environ,
            "INSTANCE_NAME": "rewind-demo",
            "STATIC_IP_NAME": "rewind-demo-ip",
            "BACKUP_BUCKET": "backup-bucket",
            "EXPECTED_SNAPSHOT_NAMES": "[]",
            "EXPECTED_DISTRIBUTIONS": "{}",
            "AUDIT_NOTIFICATION_MODE": "sns",
            "AUDIT_NOTIFICATION_TOPIC_ARN": "arn:aws:sns:ap-southeast-1:123456789012:cost-safety",
        }
        printed = []
        with (
            patch.dict(sys.modules, {"boto3": fake_boto3}),
            patch.dict(os.environ, environment, clear=True),
            patch("builtins.print", side_effect=printed.append),
        ):
            with self.assertRaisesRegex(RuntimeError, "instance_not_stopped"):
                audit.handler({}, None)

        self.assertEqual(len(printed), 1)
        logged = json.loads(printed[0])
        self.assertEqual(logged["status"], "fail")
        self.assertEqual(logged["notification"]["status"], "failed")
        self.assertEqual(logged["notification"]["error_code"], "AccessDenied")
        self.assertNotIn("private notification detail", printed[0])

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
        self.assertEqual(report["expected_state"], "approved_active_demo")
        self.assertEqual(
            calls,
            [("lightsail", {}), ("lightsail", {"region_name": "us-east-1"}), ("s3", {})],
        )
        self.assertEqual(global_client.distribution_calls, [{}])


if __name__ == "__main__":
    unittest.main()
