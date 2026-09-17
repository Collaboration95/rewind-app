import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("cost_safety_audit.py")
SPEC = importlib.util.spec_from_file_location("cost_safety_audit", MODULE_PATH)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


VALID_RULES = [
    {
        "ID": "expire-demo-backups",
        "Status": "Enabled",
        "Expiration": {"Days": 30},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 7},
    }
]


class CostSafetyAuditTest(unittest.TestCase):
    def report(self, **overrides):
        values = {
            "instance_state": "stopped",
            "static_ips": [{"name": "rewind-demo-ip", "attachedTo": "rewind-demo"}],
            "snapshots": [],
            "distributions": [],
            "lifecycle_rules": VALID_RULES,
            "instance_name": "rewind-demo",
            "static_ip_name": "rewind-demo-ip",
        }
        values.update(overrides)
        return audit.evaluate(**values)

    def test_expected_stopped_demo_passes(self):
        report = self.report()
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["issues"], [])
        self.assertTrue(report["resources"]["static_ip_attached"])

    def test_expected_running_demo_passes_when_explicitly_configured(self):
        report = self.report(instance_state="running", expected_instance_state="running")
        self.assertEqual(report["status"], "pass")

    def test_unexpected_running_demo_is_visible_as_an_actionable_failure(self):
        report = self.report(instance_state="running")
        self.assertEqual(report["status"], "fail")
        self.assertEqual(report["issues"], ["instance_state_unexpected"])

    def test_unattached_ip_and_bad_lifecycle_fail_without_object_data(self):
        report = self.report(
            static_ips=[{"name": "rewind-demo-ip", "attachedTo": None}], lifecycle_rules=[]
        )
        self.assertEqual(report["status"], "fail")
        self.assertEqual(
            report["issues"],
            ["static_ip_unattached_or_misattached", "backup_lifecycle_misconfigured"],
        )
        self.assertNotIn("backup_objects", report)


if __name__ == "__main__":
    unittest.main()
