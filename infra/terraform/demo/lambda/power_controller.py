"""Rewind's deliberately small AWS control-plane entry point."""

import json
import os
from datetime import datetime, timedelta, timezone

import boto3


LIGHTSAIL = boto3.client("lightsail")
S3 = boto3.client("s3")
INSTANCE_NAME = os.environ["INSTANCE_NAME"]
BACKUP_BUCKET = os.environ["BACKUP_BUCKET"]
BACKUP_PREFIX = os.environ["BACKUP_PREFIX"]
MAX_BACKUP_AGE_MINUTES = int(os.environ["MAX_BACKUP_AGE_MINUTES"])


def handler(event, _context):
    action = event.get("action")
    current_state = LIGHTSAIL.get_instance_state(instanceName=INSTANCE_NAME)["state"]["name"]

    if action == "start":
        if current_state == "running":
            result = None
        else:
            result = LIGHTSAIL.start_instance(instanceName=INSTANCE_NAME)
    elif action == "stop":
        manifest_key = event.get("backup_manifest_key", "")
        expected_prefix = f"{BACKUP_PREFIX}/rewind-"
        if not (
            manifest_key.startswith(expected_prefix)
            and manifest_key.endswith(".manifest.json")
        ):
            raise ValueError("stop requires a Rewind backup_manifest_key")

        # A host-side pause script uploads this last. Its presence is the gate
        # preventing a remote stop request from bypassing the backup workflow.
        manifest = S3.head_object(Bucket=BACKUP_BUCKET, Key=manifest_key)
        oldest_allowed = datetime.now(timezone.utc) - timedelta(
            minutes=MAX_BACKUP_AGE_MINUTES
        )
        if manifest["LastModified"] < oldest_allowed:
            raise ValueError("backup manifest is older than the permitted stop window")
        if current_state == "stopped":
            result = None
        else:
            result = LIGHTSAIL.stop_instance(instanceName=INSTANCE_NAME)
    else:
        raise ValueError("action must be 'start' or 'stop'")

    response = {
        "statusCode": 200,
        "body": json.dumps(
            {
                "action": action,
                "instance": INSTANCE_NAME,
                "previous_state": current_state,
                "operation": None if result is None else result["operations"][0]["operationType"],
            }
        ),
    }
    print(response["body"])
    return response
