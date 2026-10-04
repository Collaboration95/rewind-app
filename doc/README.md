# SWE5006 Project Planning Workspace

This repository contains the active planning documents for the SWE5006 Practice
Module project.

## Start here

- [Project context and constraints](planning/context/project-brief.md) — the working interpretation of the module brief and report expectations.
- [Rewind discovery handoff](planning/ideation/rewind-product-discovery-handoff.md) — product context, decisions, research, and open questions.
- [Selected Rewind proposal](planning/proposals/proposal-rewind.md) — the original product baseline; the Sprint 2 plan records the later pilot login and photo decisions.
- [Sprint 0 plan](planning/sprints/sprint-0-plan.md) — the first capacity-aware implementation slice.
- [Sprint 0 extension](planning/sprints/sprint-0-plan-extension.md) — the runtime-foundation move and Sprint 1 handoff.

Sprint names follow the GitHub milestones: Sprint 0 ends 12 September, Sprint 1
runs 13–26 September, Sprint 2 runs 27 September–10 October, and Sprint 3 runs
11–24 October 2026. Current work is the open `mvp` issues in the active
Sprint milestone; run `make issues` to list them. Delivery rules live in
[`AGENTS.md`](../AGENTS.md).

- [Sprint 2 user journey and issue map](planning/sprints/sprint-2-user-journey-plan.md) — the draft path from app launch through private group, capture, release, and installable clients.
- [Earlier hosted Demo proposal](planning/sprints/sprint-1-plan.md) — uses superseded Sprint naming and a narrower synthetic Demo scope.

Superseded plans, the Sprint 2 execution plan, planning handoffs and long agent
prompts are in the [planning archive](planning/archive/README.md). Agents do not
read them unless asked by name.

## Delivery guides

- [Native client builds](planning/native-client-builds.md) — prepare a pinned Android APK or iOS preview, record its source and public origins, and distinguish compilation from installed-client acceptance.

Documentation-only changes receive a cheap required Quality result without
running application tests. Code, workflow, executable documentation, mixed
changes and unavailable comparisons still run the existing checks. Dev pushes
containing only documentation skip deployment before obtaining AWS credentials
or waiting for a deployment Quality result. See the current
[Quality workflow](../.github/workflows/quality.yml) and
[dev deployment workflow](../.github/workflows/deploy-dev.yml) for the executable
rules.
