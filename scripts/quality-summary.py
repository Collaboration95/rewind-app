#!/usr/bin/env python3
"""Summarise retained Quality reports without changing any gate result."""
import json
import os
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

suite = sys.argv[1]
row = [suite, "n/a", "n/a", "n/a", "n/a", "n/a"]
if suite == "audit":
    path = Path("coverage/npm-audit.json")
    if path.exists():
        report = json.loads(path.read_text())
        vulnerabilities = report.get("metadata", {}).get("vulnerabilities")
        if vulnerabilities is not None:
            result = "FAIL" if vulnerabilities.get("high", 0) + vulnerabilities.get("critical", 0) else "PASS"
            row[-1] = result + " (HIGH+ gate); " + ", ".join(f"{severity}: {vulnerabilities.get(severity, 0)}" for severity in ("low", "moderate", "high", "critical"))
        else:
            row[-1] = "Audit error; inspect npm-audit.json"
    else:
        row[-1] = "No report (step did not complete)"
else:
    junit = Path(f"coverage/test-results-{suite}.xml")
    if junit.exists():
        cases = list(ET.parse(junit).iter("testcase"))
        failed = sum(case.find("failure") is not None or case.find("error") is not None for case in cases)
        skipped = sum(case.find("skipped") is not None for case in cases)
        row[1:4] = [str(len(cases) - failed - skipped), str(failed), str(skipped)]
    elif suite == "frontend" and Path("coverage/frontend-results.json").exists():
        report = json.loads(Path("coverage/frontend-results.json").read_text())
        row[1:4] = [str(report[key]) for key in ("numPassedTests", "numFailedTests", "numPendingTests")]
    coverage = Path("coverage/coverage-summary.json")
    if suite in ("server", "frontend") and coverage.exists():
        totals = json.loads(coverage.read_text())["total"]
        metric = "statements" if "statements" in totals else "lines"
        row[4] = f"{totals[metric]['pct']}% {metric}"
with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
    stream.write("\n### Quality artifacts\n\n| Suite | Passed | Failed | Skipped | Coverage | Dependency audit |\n| --- | ---: | ---: | ---: | --- | --- |\n")
    stream.write("| " + " | ".join(row) + " |\n")
    stream.write("\nReports are available in this run's **Artifacts**. n/a means not measured in this job.\n")
