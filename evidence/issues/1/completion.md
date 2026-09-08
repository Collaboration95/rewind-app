# Issue #1 evidence — Sprint 0 delivery controls

Status: implementation complete pending PR review and merge.

Commit: [872209d8cdfd9c26b5379bfa16717ad0f74777f3](https://github.com/Collaboration95/rewind-app/commit/872209d8cdfd9c26b5379bfa16717ad0f74777f3)
PR: [#13](https://github.com/Collaboration95/rewind-app/pull/13)

## Acceptance evidence

- [x] GitHub Project `Rewind — Sprint 0` exists with `Product Backlog`,
      `Ready`, `In Progress`, `Review/Test`, `Done`, and `Blocked` statuses.
- [x] Milestone `Sprint 0` exists and contains the issue set.
- [x] The two-story In Progress WIP limit, working agreement, planning member
      labels/capacity, reviewer map, and exception-state rule are recorded in
      [`docs/agile/sprint-0-delivery-controls.md`](../../../docs/agile/sprint-0-delivery-controls.md).
- [x] The submitted project proposal confirms the real A–E member mapping and
      role ownership; planned Sprint 0 availability is recorded as committed
      capacity rather than an attendance log.
- [x] The primary issue record and secondary traceability comments link this
      grouped change-set.

## Checks run

- `gh project field-list 8 --owner Collaboration95 --format json` — passed;
  required status options are present.
- `gh project item-list 8 --owner Collaboration95 --format json` — passed;
  the Sprint 0 issue set is present with milestone and workflow fields.
- `git diff --check` — passed on the committed change-set.

## Boundary

The proposal does not define daily attendance or absence records. The repository
records the confirmed member names, role mapping, reviewer pairings, and
planned Sprint 0 capacity, but does not invent an attendance history or copy
member email addresses into this public repository.
