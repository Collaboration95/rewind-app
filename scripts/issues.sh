#!/usr/bin/env bash
# List the current Sprint's issues: Doing, To do (mvp), and Done.
# The current Sprint is the open milestone with the earliest due date that has
# not passed. Pass a milestone title to override, e.g. scripts/issues.sh "Sprint 3".
set -euo pipefail

today=$(date -u +%Y-%m-%d)
milestone=${1:-$(gh api 'repos/{owner}/{repo}/milestones?state=open&sort=due_on&direction=asc' \
  --jq "[.[] | select(.due_on != null and .due_on[0:10] >= \"$today\")][0].title // empty")}

if [ -z "$milestone" ]; then
  echo "No open milestone with a future due date. Pass one: scripts/issues.sh \"Sprint 3\"" >&2
  exit 1
fi

row='.[] | "  #\(.number)  \(.title)"'

echo "$milestone"
echo
echo "Doing"
gh issue list --state open --milestone "$milestone" --label doing --limit 100 \
  --json number,title --jq "$row"
echo
echo "To do (mvp)"
gh issue list --state open --milestone "$milestone" --label mvp --limit 100 \
  --json number,title,labels \
  --jq "[.[] | select([.labels[].name] | index(\"doing\") | not)] | $row"
echo
echo "Done"
gh issue list --state closed --milestone "$milestone" --limit 200 \
  --json number,title,labels \
  --jq "[.[] | select([.labels[].name] | index(\"archived\") | not)] | $row"
