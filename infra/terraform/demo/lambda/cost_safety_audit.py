"""Read-only cost-safety audit for the deliberately small Rewind Demo."""

import json
import os


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


def evaluate(
    instance,
    static_ip,
    snapshots,
    distributions,
    lifecycle_rules,
    instance_name,
    expected_snapshot_names,
    expected_distributions,
):
    """Return a compact report without backup contents, paths, or credentials."""
    issues = []
    if instance.get("state", {}).get("name") != "stopped":
        issues.append("instance_not_stopped")
    if not any(
        tag.get("key") == "Environment" and tag.get("value") == "demo"
        for tag in instance.get("tags", [])
    ):
        issues.append("instance_not_tagged_demo")
    if static_ip is None:
        issues.append("static_ip_missing")
    elif static_ip.get("attachedTo") != instance_name or not static_ip.get("isAttached", False):
        issues.append("static_ip_unattached_or_misattached")

    actual_snapshot_names = {snapshot.get("name") for snapshot in snapshots if snapshot.get("name")}
    if actual_snapshot_names - expected_snapshot_names:
        issues.append("unexpected_snapshot")
    if expected_snapshot_names - actual_snapshot_names:
        issues.append("expected_snapshot_missing")

    actual_distributions = {
        distribution.get("name"): distribution
        for distribution in distributions
        if distribution.get("name")
    }
    if set(actual_distributions) - set(expected_distributions):
        issues.append("unexpected_distribution")
    for name, expected_origin in expected_distributions.items():
        distribution = actual_distributions.get(name)
        if distribution is None:
            issues.append("expected_distribution_missing")
            continue
        if not distribution.get("isEnabled", False):
            issues.append("expected_distribution_disabled")
        if distribution.get("origin", {}).get("name") != expected_origin:
            issues.append("distribution_origin_mismatch")

    if not lifecycle_is_valid(lifecycle_rules):
        issues.append("backup_lifecycle_misconfigured")
    return {
        "event": "rewind.demo.cost_safety_audit",
        "status": "pass" if not issues else "fail",
        "issues": issues,
        "resources": {
            "instance_state": instance.get("state", {}).get("name", "unknown"),
            "instance_tagged_demo": "instance_not_tagged_demo" not in issues,
            "static_ip_attached": static_ip is not None
            and static_ip.get("attachedTo") == instance_name
            and static_ip.get("isAttached", False),
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
):
    instance = lightsail.get_instance(instanceName=instance_name).get("instance", {})
    static_ip = lightsail.get_static_ip(staticIpName=static_ip_name).get("staticIp")
    snapshots = paginated_instance_snapshots(lightsail)
    distributions = paginated_distributions(distribution_lightsail)
    return evaluate(
        instance,
        static_ip,
        snapshots,
        distributions,
        no_lifecycle_rules(s3, backup_bucket),
        instance_name,
        set(expected_snapshot_names),
        expected_distributions,
    )


def handler(_event, _context):
    import boto3

    instance_name = os.environ["INSTANCE_NAME"]
    static_ip_name = os.environ["STATIC_IP_NAME"]
    backup_bucket = os.environ["BACKUP_BUCKET"]
    expected_snapshot_names = json.loads(os.environ["EXPECTED_SNAPSHOT_NAMES"])
    expected_distributions = json.loads(os.environ["EXPECTED_DISTRIBUTIONS"])
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
        )
    except Exception:
        report = {
            "event": "rewind.demo.cost_safety_audit",
            "status": "fail",
            "issues": ["audit_read_failed"],
            "resources": {},
        }
    print(json.dumps(report, separators=(",", ":"), sort_keys=True))
    if report["status"] != "pass":
        raise RuntimeError("cost-safety audit failed: " + ",".join(report["issues"]))
    return report
