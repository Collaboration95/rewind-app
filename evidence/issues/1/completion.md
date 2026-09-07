# Issue #1 evidence — Sprint 0 delivery controls

Status: partial; implementation evidence prepared, with the team-member input
blocker still open.

Commit: [4ee8242446389146ec13cbcf91d3b09a7b5a4817](https://github.com/Collaboration95/rewind-app/commit/4ee8242446389146ec13cbcf91d3b09a7b5a4817)
PR: [#13](https://github.com/Collaboration95/rewind-app/pull/13)

## Acceptance evidence

- [x] GitHub Project `Rewind — Sprint 0` exists with `Product Backlog`,
      `Ready`, `In Progress`, `Review/Test`, `Done`, and `Blocked` statuses.
- [x] Milestone `Sprint 0` exists and contains the issue set.
- [x] The two-story In Progress WIP limit, working agreement, planning member
      labels/capacity, reviewer map, and exception-state rule are recorded in
      [`docs/agile/sprint-0-delivery-controls.md`](../../../docs/agile/sprint-0-delivery-controls.md).
- [x] The primary issue record and secondary traceability comments link this
      grouped change-set.

## Checks run

- `gh project field-list 8 --owner Collaboration95 --format json` — passed;
  required status options are present.
- `gh project item-list 8 --owner Collaboration95 --format json` — passed;
  the Sprint 0 issue set is present with milestone and workflow fields.
- `git diff --check` — passed on the committed change-set.

## Limitation

Member labels A–E and planned hours are recorded from the sprint plan. The team
has not yet supplied real names or attendance availability, so no personal
identity data is invented in the repository. The team planning lead owns this
decision, targeted before Sprint 0 review; issue #1 must remain partial until
it is confirmed.
