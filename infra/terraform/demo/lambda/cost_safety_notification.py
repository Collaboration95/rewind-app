"""Redacted, optional notification delivery for the cost-safety audit."""

from dataclasses import dataclass
import json
import os
import re
from typing import Any, Protocol


NOTIFICATION_EVENT = "rewind.demo.cost_safety_audit.notification"
DELIVERY_EVENT = "rewind.demo.cost_safety_audit.notification_delivery"
NOTIFICATION_SCHEMA_VERSION = 1
DISABLED_MODE = "disabled"
SNS_MODE = "sns"
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$")
_SAFE_EXPECTED_STATES = {
    "approved_active_demo",
    "expected_stopped",
    "demo_off",
    "unknown",
}


class Publisher(Protocol):
    """Minimal publisher contract used by the audit handler."""

    def publish(self, event: dict[str, Any]) -> "DeliveryResult":
        ...


@dataclass(frozen=True)
class DeliveryResult:
    mode: str
    status: str
    delivered: bool
    error_code: str | None = None


def _safe_token(value: Any, fallback: str = "redacted") -> str:
    if isinstance(value, str) and _SAFE_TOKEN.fullmatch(value):
        return value
    return fallback


def _safe_error_code(error: BaseException) -> str:
    code = getattr(error, "response", {}).get("Error", {}).get("Code")
    return _safe_token(code, "delivery_failed")


def build_failure_event(
    report: dict[str, Any], finding_definitions: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """Build a deterministic event from canonical, redacted finding definitions."""
    issues = []
    for issue in report.get("issues", []):
        if (
            isinstance(issue, str)
            and issue in finding_definitions
            and issue not in issues
        ):
            issues.append(issue)

    # Do not copy report findings. The audit owns these definitions, which
    # prevents a future AWS response field or exception text from reaching SNS.
    findings = [
        {
            "code": issue,
            "severity": finding_definitions[issue]["severity"],
            "resource_identifier_class": finding_definitions[issue][
                "resource_identifier_class"
            ],
            "expected_state": finding_definitions[issue]["expected_state"],
            "remediation": finding_definitions[issue]["remediation"],
        }
        for issue in issues
    ]
    expected_state = report.get("expected_state")
    if not isinstance(expected_state, str) or expected_state not in _SAFE_EXPECTED_STATES:
        expected_state = "unknown"
    return {
        "event": NOTIFICATION_EVENT,
        "schema_version": NOTIFICATION_SCHEMA_VERSION,
        "status": "fail",
        "expected_state": expected_state,
        "issues": issues,
        "findings": findings,
    }


class DisabledPublisher:
    """Explicit no-op publisher; it never claims an operator was notified."""

    def publish(self, _event: dict[str, Any]) -> DeliveryResult:
        return DeliveryResult(DISABLED_MODE, "disabled", False)


class FailedPublisher:
    """Publisher used when non-secret notification configuration is invalid."""

    def __init__(self, mode: str, error_code: str):
        self.mode = mode
        self.error_code = _safe_token(error_code, "publisher_failed")

    def publish(self, _event: dict[str, Any]) -> DeliveryResult:
        return DeliveryResult(self.mode, "failed", False, self.error_code)


class SnsPublisher:
    """Managed SNS publisher; the topic ARN is configuration, not event data."""

    def __init__(self, sns_client: Any, topic_arn: str):
        self.sns_client = sns_client
        self.topic_arn = topic_arn

    def publish(self, event: dict[str, Any]) -> DeliveryResult:
        try:
            self.sns_client.publish(
                TopicArn=self.topic_arn,
                Message=json.dumps(event, separators=(",", ":"), sort_keys=True),
                Subject="Rewind Demo cost-safety audit failed",
            )
        except Exception as error:  # delivery must not replace the audit result
            return DeliveryResult(SNS_MODE, "failed", False, _safe_error_code(error))
        return DeliveryResult(SNS_MODE, "delivered", True)


def publisher_from_environment(sns_client_factory=None) -> Publisher:
    """Select a publisher using only non-secret environment configuration."""
    mode = os.environ.get("AUDIT_NOTIFICATION_MODE", DISABLED_MODE).strip().lower()
    if mode == DISABLED_MODE:
        return DisabledPublisher()
    if mode != SNS_MODE:
        return FailedPublisher("unknown", "notification_configuration_invalid")

    topic_arn = os.environ.get("AUDIT_NOTIFICATION_TOPIC_ARN", "").strip()
    if not topic_arn:
        return FailedPublisher(SNS_MODE, "notification_configuration_invalid")
    try:
        if sns_client_factory is None:
            import boto3

            sns_client_factory = boto3.client
        return SnsPublisher(sns_client_factory("sns"), topic_arn)
    except Exception:
        return FailedPublisher(SNS_MODE, "publisher_initialization_failed")


def publish_failure(
    report: dict[str, Any],
    publisher: Publisher,
    finding_definitions: dict[str, dict[str, Any]],
) -> DeliveryResult:
    """Publish exactly one redacted failure event and never raise delivery errors."""
    event = build_failure_event(report, finding_definitions)
    try:
        result = publisher.publish(event)
    except Exception:
        result = DeliveryResult(
            SNS_MODE,
            "failed",
            False,
            "publisher_failed",
        )
    if not isinstance(result, DeliveryResult):
        return DeliveryResult(SNS_MODE, "failed", False, "publisher_failed")
    return result


def delivery_record(result: DeliveryResult) -> dict[str, Any]:
    """Return the redacted structured log record for delivery observability."""
    record = {
        "event": DELIVERY_EVENT,
        "mode": _safe_token(result.mode, "unknown"),
        "status": _safe_token(result.status, "failed"),
        "delivered": bool(result.delivered),
    }
    if result.error_code:
        record["error_code"] = _safe_token(result.error_code, "delivery_failed")
    return record
