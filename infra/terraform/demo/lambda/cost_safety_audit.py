"""Read-only cost-safety audit for the deliberately small Rewind Demo."""

import json
import os


def lifecycle_is_valid(rules):
    for rule in rules:
        if (
            rule.get("ID") == "expire-demo-backups"
            and rule.get("Status") == "Enabled"
            and rule.get("Expiration", {}).get("Days") == 30
            and rule.get("NoncurrentVersionExpiration", {}).get("NoncurrentDays") == 7
        ):
            return True
    return False


def evaluate(
    instance_state,
    static_ips,
    snapshots,
    distributions,
    lifecycle_rules,
    instance_name,
    static_ip_name,
    expected_instance_state="stopped",
):
    """Return an intentionally small, non-sensitive audit report."""
    issues = []
    if instance_state != expected_instance_state:
        issues.append("instance_state_unexpected")

    static_ip = next((ip for ip in static_ips if ip.get("name") == static_ip_name), None)
    if static_ip is None:
        issues.append("static_ip_missing")
    elif static_ip.get("attachedTo") != instance_name:
        issues.append("static_ip_unattached_or_misattached")

    if not lifecycle_is_valid(lifecycle_rules):
        issues.append("backup_lifecycle_misconfigured")

    return {
        "event": "rewind.demo.cost_safety_audit",
        "status": "pass" if not issues else "fail",
        "issues": issues,
        "resources": {
            "instance_state": instance_state,
            "expected_instance_state": expected_instance_state,
            "static_ip_attached": static_ip is not None
            and static_ip.get("attachedTo") == instance_name,
            "snapshot_count": len(snapshots),
            "distribution_count": len(distributions),
            "backup_lifecycle_valid": lifecycle_is_valid(lifecycle_rules),
        },
    }


def handler(_event, _context):
    import boto3
    from botocore.exceptions import ClientError

    instance_name = os.environ["INSTANCE_NAME"]
    static_ip_name = os.environ["STATIC_IP_NAME"]
    backup_bucket = os.environ["BACKUP_BUCKET"]
    expected_instance_state = os.environ.get("EXPECTED_INSTANCE_STATE", "stopped")
    lightsail = boto3.client("lightsail")
    s3 = boto3.client("s3")

    instance = lightsail.get_instance_state(instanceName=instance_name)
    static_ips = lightsail.get_static_ips().get("staticIps", [])
    snapshots = lightsail.get_instance_snapshots().get("instanceSnapshots", [])
    distributions = lightsail.get_distributions().get("distributions", [])
    try:
        lifecycle_rules = s3.get_bucket_lifecycle_configuration(Bucket=backup_bucket).get(
            "Rules", []
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "NoSuchLifecycleConfiguration":
            raise
        lifecycle_rules = []
    report = evaluate(
        instance.get("state", {}).get("name", "unknown"),
        static_ips,
        snapshots,
        distributions,
        lifecycle_rules,
        instance_name,
        static_ip_name,
        expected_instance_state,
    )
    print(json.dumps(report, separators=(",", ":"), sort_keys=True))
    if report["status"] != "pass":
        raise RuntimeError("cost-safety audit failed: " + ",".join(report["issues"]))
    return report
