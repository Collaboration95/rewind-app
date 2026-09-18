import importlib.util
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("cost_safety_notification.py")
SPEC = importlib.util.spec_from_file_location("cost_safety_notification", MODULE_PATH)
notifications = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notifications)


class FakeSns:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    def publish(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return {"MessageId": "not used by the adapter"}


class FakeAwsError(Exception):
    def __init__(self, code):
        super().__init__("private exception text must not be logged")
        self.response = {"Error": {"Code": code}}


def failing_report():
    return {
        "event": "rewind.demo.cost_safety_audit",
        "status": "fail",
        "expected_state": "approved_active_demo",
        "issues": ["instance_not_stopped"],
        "findings": [
            {
                "code": "instance_not_stopped",
                "severity": "error",
                "resource_identifier_class": "lightsail_instance",
                "expected_state": "present_stopped_and_tagged_demo",
                "remediation": "review-active-demo-power-state",
            }
        ],
        "resources": {"instance_name": "private-resource-name"},
    }


FINDING_DEFINITIONS = {
    "instance_not_stopped": {
        "severity": "error",
        "resource_identifier_class": "lightsail_instance",
        "expected_state": "present_stopped_and_tagged_demo",
        "remediation": "review-active-demo-power-state",
    }
}


class CostSafetyNotificationTest(unittest.TestCase):
    def test_disabled_delivery_is_explicit_and_does_not_claim_notification(self):
        sns = FakeSns()
        with patch.dict(
            notifications.os.environ,
            {"AUDIT_NOTIFICATION_MODE": "disabled"},
            clear=True,
        ):
            publisher = notifications.publisher_from_environment(lambda _: sns)
        result = notifications.publish_failure(
            failing_report(), publisher, FINDING_DEFINITIONS
        )

        self.assertEqual(result, notifications.DeliveryResult("disabled", "disabled", False))
        self.assertEqual(sns.calls, [])
        self.assertEqual(
            notifications.delivery_record(result),
            {
                "event": notifications.DELIVERY_EVENT,
                "mode": "disabled",
                "status": "disabled",
                "delivered": False,
            },
        )

    def test_sns_success_publishes_one_stable_redacted_event(self):
        sns = FakeSns()
        with patch.dict(
            notifications.os.environ,
            {
                "AUDIT_NOTIFICATION_MODE": "sns",
                "AUDIT_NOTIFICATION_TOPIC_ARN": "arn:aws:sns:ap-southeast-1:123456789012:cost-safety",
            },
            clear=True,
        ):
            publisher = notifications.publisher_from_environment(lambda _: sns)
        result = notifications.publish_failure(
            failing_report(), publisher, FINDING_DEFINITIONS
        )

        self.assertEqual(result.status, "delivered")
        self.assertTrue(result.delivered)
        self.assertEqual(len(sns.calls), 1)
        self.assertEqual(sns.calls[0]["Subject"], "Rewind Demo cost-safety audit failed")
        event = json.loads(sns.calls[0]["Message"])
        self.assertEqual(
            event,
            notifications.build_failure_event(failing_report(), FINDING_DEFINITIONS),
        )
        self.assertNotIn("resources", event)
        self.assertNotIn("private-resource-name", sns.calls[0]["Message"])

    def test_sns_failure_is_visible_but_does_not_raise_or_change_audit_result(self):
        sns = FakeSns(FakeAwsError("AccessDenied"))
        publisher = notifications.SnsPublisher(sns, "arn:aws:sns:ap-southeast-1:123456789012:cost-safety")
        report = failing_report()

        result = notifications.publish_failure(report, publisher, FINDING_DEFINITIONS)

        self.assertEqual(result, notifications.DeliveryResult("sns", "failed", False, "AccessDenied"))
        self.assertEqual(report["status"], "fail")
        record = notifications.delivery_record(result)
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error_code"], "AccessDenied")
        self.assertNotIn("private exception text", json.dumps(record))

    def test_event_redacts_resource_names_errors_and_unknown_fields(self):
        report = failing_report()
        report["exception"] = "credential=private-secret"
        report["findings"][0]["resource_name"] = "private-resource-name"
        event = notifications.build_failure_event(report, FINDING_DEFINITIONS)
        serialized = json.dumps(event, sort_keys=True)

        self.assertNotIn("private-resource-name", serialized)
        self.assertNotIn("private-secret", serialized)
        self.assertNotIn("exception", event)
        self.assertNotIn("resources", event)
        self.assertEqual(event["schema_version"], 1)
        self.assertEqual(set(event["findings"][0]), {
            "code",
            "severity",
            "resource_identifier_class",
            "expected_state",
            "remediation",
        })

    def test_unknown_token_shaped_report_values_are_not_forwarded(self):
        report = failing_report()
        report["issues"] = ["private-resource-name"]
        report["expected_state"] = "secret-instance-name"

        event = notifications.build_failure_event(report, FINDING_DEFINITIONS)

        self.assertEqual(event["issues"], [])
        self.assertEqual(event["findings"], [])
        self.assertEqual(event["expected_state"], "unknown")

    def test_repository_configuration_contains_no_recipient_webhook_or_credential(self):
        root = Path(__file__).parents[1]
        files = [
            root / "lambda" / "cost_safety_audit.py",
            root / "lambda" / "cost_safety_notification.py",
            root / "cost-safety-audit.tf",
            root / "variables.tf",
            root / "terraform.tfvars.example",
        ]
        forbidden = [
            re.compile(r"(?i)https?://[^\s\"]*hooks?\.[^\s\"]*"),
            re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
            re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
            re.compile(r"-----BEGIN [^-]+ PRIVATE KEY-----"),
        ]
        for path in files:
            source = path.read_text()
            for pattern in forbidden:
                self.assertIsNone(pattern.search(source), f"forbidden destination or credential in {path}")


if __name__ == "__main__":
    unittest.main()
