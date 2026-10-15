# SWE5006 Project Documentation

Start here for Rewind product, design, delivery and project-process references.
Current scope is the real-account app: photo and video capture, web push
reminders, and iOS delivery through the PWA. The synthetic Demo and compiled
native iOS release are outside current scope.

## Product

- [Current product baseline](planning/current-product-baseline.md) — requirements, use cases, implemented behavior and verification limits at its stated source revision.
- [Project context and constraints](planning/context/project-brief.md) — the working interpretation of the official module brief.
- [Product walkthrough](planning/product-walkthrough.md) — current user journeys and their verification limits.

## Design

- [Database design](../docs/domain/database-design.md) — relational structure, constraints and persistence boundaries.
- [Current system architecture](../docs/architecture/current-system.md) — system boundaries and implementation structure.
- [Analysis and design models](../docs/design/README.md) — detailed use cases, static/dynamic views and canonical coverage gaps.

## Delivery

- [Delivery and verification guide](../docs/architecture/delivery-and-verification.md) — environments, checks and delivery boundaries.
- [Client artifacts guide](planning/client-artifacts.md) — build configuration, available artifacts and device verification.
- [Release cutover guide](../docs/architecture/release-cutover.md) — preparation and deployment procedure; a merged runbook does not establish deployment or acceptance.

Documentation records its source revision and verification limits; implementation
presence and historical evidence do not establish current runtime or device results.

Documentation-only changes receive a cheap required Quality result without
running application tests. Code, workflow, executable documentation, mixed
changes and unavailable comparisons still run the existing checks. Dev pushes
containing only documentation skip deployment before obtaining AWS credentials
or waiting for a deployment Quality result. See the current
[Quality workflow](../.github/workflows/quality.yml) and
[dev deployment workflow](../.github/workflows/deploy-dev.yml) for the executable
rules.

## Process

- [Working agreement](../AGENTS.md) — delivery rules and verification tiers.
- [Project-conduct evidence](planning/project-conduct-evidence.md) — factual Sprint 0–3 records, source references and gaps; no inferred attendance, hours or ceremonies.

Sprint 0 ends 12 September; Sprint 1 runs 13–26 September; Sprint 2 runs
27 September–10 October; Sprint 3 runs 11–24 October 2026. Current work is the
open `mvp` issues in the active Sprint milestone; run `make issues` to list them.
Track work through milestones and `mvp`/`doing` labels; Project boards are not
maintained.

## Historical planning

These documents explain earlier proposals and decisions. Use the current product
baseline and working agreement for present scope.

- [Discovery handoff](planning/ideation/rewind-product-discovery-handoff.md) — early research, product decisions and open questions.
- [Selected proposal](planning/proposals/proposal-rewind.md) — original requirements and product proposal.
- [Sprint 0 plan](planning/sprints/sprint-0-plan.md) and [extension](planning/sprints/sprint-0-plan-extension.md) — foundation work and the Sprint 1 handoff.
- [Sprint 2 user journey and issue map](planning/sprints/sprint-2-user-journey-plan.md) — an earlier journey and delivery plan.
- [Earlier hosted Demo proposal](planning/sprints/sprint-1-plan.md) — superseded Sprint naming and synthetic Demo scope.
- [Native client build reference](planning/native-client-builds.md) — earlier build guidance; its iOS preview instructions do not define the current iOS PWA delivery scope.
