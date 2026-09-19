"""Read-only cost-safety audit for the deliberately small Rewind Demo."""

import json
import os

from cost_safety_notification import (
    delivery_record,
    publisher_from_environment,
    publish_failure,
)


AUDIT_EVENT = "rewind.demo.cost_safety_audit"

# This is the policy contract consumed by ``evaluate``. It intentionally
# describes states, not resource names, so reports can be shared safely.
EXPECTED_STATE_MATRIX = {
    "demo_off": {
        "instance": "absent",
        "static_ip": "absent_unless_explicitly_retained",
        "snapshots": "configured_allowlist_only",
        "distributions": "configured_allowlist_only",
        "backup_lifecycle": "rewind_demo_retention_enabled",
    },
    "expected_stopped": {
        "instance": "present_stopped_and_tagged_demo",
        "static_ip": "present_and_attached_to_demo_instance",
        "snapshots": "configured_allowlist_only",
        "distributions": "configured_allowlist_only",
        "backup_lifecycle": "rewind_demo_retention_enabled",
    },
    "approved_active_demo": {
        "instance": "present_running_and_tagged_demo",
        "static_ip": "present_and_attached_to_demo_instance",
        "snapshots": "configured_allowlist_only",
        "distributions": "configured_allowlist_only",
        "backup_lifecycle": "rewind_demo_retention_enabled",
    },
}

# Findings contain no AWS names, bucket names, object keys, or exception text.
# The remediation values are stable references for an operator or a later
# notification adapter; this Lambda never performs the remediation itself.
FINDING_DEFINITIONS = {
    "instance_missing": {
        "severity": "error",
        "resource_identifier_class": "lightsail_instance",
        "expected_state": "configured_demo_instance_state",
        "remediation": "review-active-demo-terraform-state",
    },
    "instance_not_stopped": {
        "severity": "error",
        "resource_identifier_class": "lightsail_instance",
        "expected_state": "expected_stopped",
        "remediation": "review-demo-power-state",
    },
    "instance_not_running": {
        "severity": "error",
        "resource_identifier_class": "lightsail_instance",
        "expected_state": "approved_active_demo",
        "remediation": "review-demo-power-state",
    },
    "instance_not_tagged_demo": {
        "severity": "error",
        "resource_identifier_class": "lightsail_instance",
        "expected_state": "configured_demo_instance_state",
        "remediation": "review-demo-tags",
    },
    "instance_present_while_demo_off": {
        "severity": "error",
        "resource_identifier_class": "lightsail_instance",
        "expected_state": "absent_no_billable_compute",
        "remediation": "review-demo-off-terraform-state",
    },
    "static_ip_missing": {
        "severity": "error",
        "resource_identifier_class": "lightsail_static_ip",
        "expected_state": "present_and_attached_to_demo_instance",
        "remediation": "review-demo-static-ip",
    },
    "retained_static_ip_missing": {
        "severity": "error",
        "resource_identifier_class": "lightsail_static_ip",
        "expected_state": "present_and_unattached_for_retention",
        "remediation": "review-demo-off-static-ip-retention",
    },
    "static_ip_unattached_or_misattached": {
        "severity": "error",
        "resource_identifier_class": "lightsail_static_ip",
        "expected_state": "present_and_attached_to_demo_instance",
        "remediation": "review-demo-static-ip",
    },
    "static_ip_present_while_demo_off": {
        "severity": "error",
        "resource_identifier_class": "lightsail_static_ip",
        "expected_state": "absent_unless_explicitly_retained",
        "remediation": "review-demo-off-static-ip-retention",
    },
    "static_ip_attached_while_demo_off": {
        "severity": "error",
        "resource_identifier_class": "lightsail_static_ip",
        "expected_state": "unattached_only_if_explicitly_retained",
        "remediation": "review-demo-off-static-ip-retention",
    },
    "unexpected_snapshot": {
        "severity": "error",
        "resource_identifier_class": "lightsail_instance_snapshot",
        "expected_state": "configured_allowlist_only",
        "remediation": "review-cost-safety-snapshot-allowlist",
    },
    "expected_snapshot_missing": {
        "severity": "error",
        "resource_identifier_class": "lightsail_instance_snapshot",
        "expected_state": "configured_allowlist_only",
        "remediation": "review-cost-safety-snapshot-allowlist",
    },
    "unexpected_distribution": {
        "severity": "error",
        "resource_identifier_class": "lightsail_distribution",
        "expected_state": "configured_allowlist_only",
        "remediation": "review-cost-safety-distribution-allowlist",
    },
    "expected_distribution_missing": {
        "severity": "error",
        "resource_identifier_class": "lightsail_distribution",
        "expected_state": "configured_allowlist_only",
        "remediation": "review-cost-safety-distribution-allowlist",
    },
    "expected_distribution_disabled": {
        "severity": "error",
        "resource_identifier_class": "lightsail_distribution",
        "expected_state": "enabled_with_expected_origin",
        "remediation": "review-cost-safety-distribution-allowlist",
    },
    "distribution_origin_mismatch": {
        "severity": "error",
        "resource_identifier_class": "lightsail_distribution",
        "expected_state": "enabled_with_expected_origin",
        "remediation": "review-cost-safety-distribution-allowlist",
    },
    "backup_lifecycle_misconfigured": {
        "severity": "error",
        "resource_identifier_class": "s3_backup_bucket_lifecycle",
        "expected_state": "rewind_demo_retention_enabled",
        "remediation": "review-backup-retention-policy",
    },
    "audit_read_failed": {
        "severity": "error",
        "resource_identifier_class": "aws_inventory_read",
        "expected_state": "all-configured-inventory-reads-succeed",
        "remediation": "review-audit-read-permissions-or-availability",
    },
}


def lifecycle_is_valid(rules):
    for rule in rules:
        if (
            rule.get("ID") == "expire-demo-backups"
            and rule.get("Status") == "Enabled"
            and rule.get("Filter", {}).get("Prefix") == "rewind-demo/"
            and rule.get("Expiration", {}).get("Days") == 30
            and rule.get("NoncurrentVersionExpiration", {}).get("NoncurrentDays") == 7
        ):
            return True
    return False


def paginated_instance_snapshots(lightsail):
    snapshots = []
    page_token = None
    while True:
        request = {} if page_token is None else {"pageToken": page_token}
        response = lightsail.get_instance_snapshots(**request)
        snapshots.extend(response.get("instanceSnapshots", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            return snapshots


def paginated_distributions(lightsail):
    distributions = []
    page_token = None
    while True:
        request = {} if page_token is None else {"pageToken": page_token}
        response = lightsail.get_distributions(**request)
        distributions.extend(response.get("distributions", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            return distributions


def _finding(code):
    return {"code": code, **FINDING_DEFINITIONS[code]}


def _add_finding(findings, code):
    if not any(finding["code"] == code for finding in findings):
        findings.append(_finding(code))


def _is_demo_tagged(instance):
    return any(
        tag.get("key") == "Environment" and tag.get("value") == "demo"
        for tag in instance.get("tags", [])
    )


def _is_attached_to_instance(static_ip, instance_name):
    return bool(
        static_ip
        and static_ip.get("attachedTo") == instance_name
        and static_ip.get("isAttached", False)
    )


def evaluate(
    instance,
    static_ip,
    snapshots,
    distributions,
    lifecycle_rules,
    instance_name,
    expected_snapshot_names,
    expected_distributions,
    expected_state="expected_stopped",
    static_ip_expected=None,
):
    """Return a deterministic, redacted report for the configured state."""
    if expected_state not in EXPECTED_STATE_MATRIX:
        raise ValueError("expected_state must be a known cost-safety state")

    instance_expected = expected_state != "demo_off"
    if static_ip_expected is None:
        static_ip_expected = instance_expected

    findings = []

    if instance_expected:
        expected_power_state = (
            "running" if expected_state == "approved_active_demo" else "stopped"
        )
        if not instance:
            _add_finding(findings, "instance_missing")
        else:
            if instance.get("state", {}).get("name") != expected_power_state:
                _add_finding(
                    findings,
                    "instance_not_running"
                    if expected_power_state == "running"
                    else "instance_not_stopped",
                )
            if not _is_demo_tagged(instance):
                _add_finding(findings, "instance_not_tagged_demo")

        if static_ip is None:
            _add_finding(findings, "static_ip_missing")
        elif not _is_attached_to_instance(static_ip, instance_name):
            _add_finding(findings, "static_ip_unattached_or_misattached")
    else:
        if instance:
            _add_finding(findings, "instance_present_while_demo_off")

        if static_ip_expected:
            if static_ip is None:
                _add_finding(findings, "retained_static_ip_missing")
            elif static_ip.get("isAttached", False):
                _add_finding(findings, "static_ip_attached_while_demo_off")
        elif static_ip:
            if static_ip.get("isAttached", False):
                _add_finding(findings, "static_ip_attached_while_demo_off")
            else:
                _add_finding(findings, "static_ip_present_while_demo_off")

    expected_snapshot_names = set(expected_snapshot_names)
    actual_snapshot_names = {
        snapshot.get("name") for snapshot in snapshots if snapshot.get("name")
    }
    if len(actual_snapshot_names) != len(snapshots):
        _add_finding(findings, "unexpected_snapshot")
    if actual_snapshot_names - expected_snapshot_names:
        _add_finding(findings, "unexpected_snapshot")
    if expected_snapshot_names - actual_snapshot_names:
        _add_finding(findings, "expected_snapshot_missing")

    actual_distributions = {
        distribution.get("name"): distribution
        for distribution in distributions
        if distribution.get("name")
    }
    if len(actual_distributions) != len(distributions):
        _add_finding(findings, "unexpected_distribution")
    if set(actual_distributions) - set(expected_distributions):
        _add_finding(findings, "unexpected_distribution")
    for name in sorted(expected_distributions):
        expected_origin = expected_distributions[name]
        distribution = actual_distributions.get(name)
        if distribution is None:
            _add_finding(findings, "expected_distribution_missing")
            continue
        if not distribution.get("isEnabled", False):
            _add_finding(findings, "expected_distribution_disabled")
        if distribution.get("origin", {}).get("name") != expected_origin:
            _add_finding(findings, "distribution_origin_mismatch")

    if not lifecycle_is_valid(lifecycle_rules):
        _add_finding(findings, "backup_lifecycle_misconfigured")

    instance_tagged_demo = _is_demo_tagged(instance) if instance else False
    return {
        "event": AUDIT_EVENT,
        "status": "pass" if not findings else "fail",
        "expected_state": expected_state,
        "issues": [finding["code"] for finding in findings],
        "findings": findings,
        "resources": {
            "instance_state": instance.get("state", {}).get("name", "unknown"),
            "instance_expected": instance_expected,
            "instance_present": bool(instance),
            "instance_tagged_demo": instance_tagged_demo,
            "static_ip_expected": static_ip_expected,
            "static_ip_present": static_ip is not None,
            "static_ip_attached": _is_attached_to_instance(static_ip, instance_name),
            "snapshot_count": len(snapshots),
            "distribution_count": len(distributions),
            "backup_lifecycle_valid": lifecycle_is_valid(lifecycle_rules),
        },
    }


def no_lifecycle_rules(s3, bucket):
    try:
        return s3.get_bucket_lifecycle_configuration(Bucket=bucket).get("Rules", [])
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") == "NoSuchLifecycleConfiguration":
            return []
        raise


def run_audit(
    lightsail,
    distribution_lightsail,
    s3,
    instance_name,
    static_ip_name,
    backup_bucket,
    expected_snapshot_names,
    expected_distributions,
    expected_state="expected_stopped",
    static_ip_expected=None,
):
    try:
        instance = lightsail.get_instance(instanceName=instance_name).get("instance", {})
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") in {"NotFound", "NoSuchResource"}:
            instance = {}
        else:
            raise
    try:
        static_ip = lightsail.get_static_ip(staticIpName=static_ip_name).get("staticIp")
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") in {"NotFound", "NoSuchResource"}:
            static_ip = None
        else:
            raise
    snapshots = paginated_instance_snapshots(lightsail)
    distributions = paginated_distributions(distribution_lightsail)
    return evaluate(
        instance,
        static_ip,
        snapshots,
        distributions,
        no_lifecycle_rules(s3, backup_bucket),
        instance_name,
        expected_snapshot_names,
        expected_distributions,
        expected_state,
        static_ip_expected,
    )


def read_failure_report():
    finding = _finding("audit_read_failed")
    return {
        "event": AUDIT_EVENT,
        "status": "fail",
        "expected_state": "unknown",
        "issues": [finding["code"]],
        "findings": [finding],
        "resources": {},
    }


def _env_bool(name, default):
    default_value = "true" if default else "false"
    return os.environ.get(name, default_value).strip().lower() == "true"


def handler(_event, _context):
    import boto3

    instance_name = os.environ["INSTANCE_NAME"]
    static_ip_name = os.environ["STATIC_IP_NAME"]
    backup_bucket = os.environ["BACKUP_BUCKET"]
    expected_snapshot_names = json.loads(os.environ["EXPECTED_SNAPSHOT_NAMES"])
    expected_distributions = json.loads(os.environ["EXPECTED_DISTRIBUTIONS"])
    expected_state = os.environ.get("EXPECTED_STATE", "expected_stopped").strip()
    static_ip_expected = _env_bool(
        "STATIC_IP_EXPECTED", expected_state != "demo_off"
    )
    try:
        report = run_audit(
            boto3.client("lightsail"),
            boto3.client("lightsail", region_name="us-east-1"),
            boto3.client("s3"),
            instance_name,
            static_ip_name,
            backup_bucket,
            expected_snapshot_names,
            expected_distributions,
            expected_state,
            static_ip_expected,
        )
    except Exception:
        report = read_failure_report()
    if report["status"] != "pass":
        notification = publish_failure(
            report,
            publisher_from_environment(),
            FINDING_DEFINITIONS,
        )
        report = {**report, "notification": delivery_record(notification)}
    print(json.dumps(report, separators=(",", ":"), sort_keys=True))
    if report["status"] != "pass":
        raise RuntimeError("cost-safety audit failed: " + ",".join(report["issues"]))
    return report
