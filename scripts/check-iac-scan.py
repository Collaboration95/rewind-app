"""Fail on unaccepted high/critical Trivy IaC findings."""

import json
import sys
from datetime import date
from pathlib import Path


def finding_key(target, finding):
    return (
        finding["ID"],
        target,
        finding.get("CauseMetadata", {}).get("Resource"),
    )


def main():
    report = json.loads(Path(sys.argv[1]).read_text())
    policy_path = (
        Path(sys.argv[2])
        if len(sys.argv) > 2
        else Path(".github/iac-scan-exceptions.json")
    )
    policy = json.loads(policy_path.read_text())
    accepted = {}
    errors = []
    for exception in policy["exceptions"]:
        key = (exception["id"], exception["target"], exception["resource"])
        if key in accepted:
            errors.append(f"duplicate exception: {key}")
        accepted[key] = exception
        if not exception.get("owner") or not exception.get("reason"):
            errors.append(f"missing owner or rationale: {key}")
        if date.today() >= date.fromisoformat(exception["expires"]):
            errors.append(f"expired exception: {key} ({exception['expires']})")

    matches = {key: 0 for key in accepted}
    for result in report.get("Results", []):
        for finding in result.get("Misconfigurations", []):
            if finding["Severity"] not in ("HIGH", "CRITICAL"):
                continue
            key = finding_key(result["Target"], finding)
            if key not in accepted:
                errors.append(f"unaccepted {finding['Severity']} finding: {key}")
            else:
                matches[key] += 1

    for key, count in matches.items():
        if count != 1:
            errors.append(f"exception matched {count} findings (expected one): {key}")

    if errors:
        print("IaC scan gate failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"IaC scan gate passed with {len(matches)} exact, unexpired exceptions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
