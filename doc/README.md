# SWE5006 Project Documentation

Start here for Rewind product, design, delivery and project-process references.
Current scope is the real-account app: photo and video capture, web push
reminders, and iOS delivery through the PWA. The synthetic Demo and compiled
native iOS release are outside current scope.

Documentation records its source revision and verification limits; implementation
presence and historical evidence do not establish current runtime or device
results.

## Product

- [Current product baseline](planning/current-product-baseline.md): requirements, use cases, implemented behavior and verification limits.
- [Product walkthrough](planning/product-walkthrough.md): current user journeys and their verification limits.
- [Project context and constraints](planning/context/project-brief.md): the working interpretation of the official module brief.

## Design and architecture

- [Current system architecture](../docs/architecture/current-system.md): boundaries, environments and implementation structure.
- [Analysis and design models](../docs/design/README.md): use cases, static and dynamic views, coverage gaps.
- [Database design](../docs/domain/database-design.md) and [domain contracts](../docs/domain/contracts.md).
- [Architecture decision records and guardrails](../docs/architecture/architecture-guardrails.md); [ADR-0003 PostgreSQL](../docs/architecture/ADR-0003-postgresql.md).
- [Learn Rewind](../docs/learn/README.md): browser-friendly explainer pages.

## Delivery and operations

- [Delivery and verification guide](../docs/architecture/delivery-and-verification.md): environments, checks and delivery boundaries.
- [Client artifacts guide](planning/client-artifacts.md): build configuration, available artifacts and device verification.
- [PostgreSQL operations](../docs/architecture/postgresql-operations.md) and [release cutover](../docs/architecture/release-cutover.md): a merged runbook does not establish deployment or acceptance.
- [Hosted deployment, backup and recovery](../deploy/README.md) and [Terraform and AWS](../infra/terraform/README.md).
- [Operational signals](planning/operations/operational-signals.md) and [local performance measurement](planning/performance/353-local-measurement.md).

Documentation-only changes get a cheap required Quality result and skip hosted
deployment. Code, workflow, executable documentation and mixed changes run the
full checks. See the [Quality workflow](../.github/workflows/quality.yml) and
[dev deployment workflow](../.github/workflows/deploy-dev.yml).

## Process

- [Working agreement](../AGENTS.md): delivery rules and verification tiers.
- [Project-conduct evidence](planning/project-conduct-evidence.md): factual Sprint 0 to 3 records, source references and gaps; no inferred attendance, hours or ceremonies.
- [Sprint 3 completion audit](planning/sprints/sprint-3-completion-audit-2026-10-12.md) and [Cognito decisions](planning/sprints/sprint-3-cognito/design-decisions.md).
- [Sprint analytics](analytics/sprint-analytics.html).

Sprint 0 ends 12 September; Sprint 1 runs 13 to 26 September; Sprint 2 runs
27 September to 10 October; Sprint 3 runs 11 to 24 October 2026. Current work is
the open `mvp` issues in the active Sprint milestone; run `make issues` to list
them. After the Sprint end date, use `scripts/issues.sh "Sprint 3"` to select it
explicitly. Project boards are not maintained.

## Historical planning

These explain earlier proposals and decisions. Use the current product baseline
and working agreement for present scope.

- [Discovery handoff](planning/ideation/rewind-product-discovery-handoff.md) and [selected proposal](planning/proposals/proposal-rewind.md).
- [Sprint 0 plan](planning/sprints/sprint-0-plan.md) and [extension](planning/sprints/sprint-0-plan-extension.md).
- [Sprint 1 plan](planning/sprints/sprint-1-plan.md): superseded Sprint naming and synthetic Demo scope.
- [Sprint 2 user journey and issue map](planning/sprints/sprint-2-user-journey-plan.md).
- [Native client build reference](planning/native-client-builds.md): earlier build guidance; it does not define the current iOS PWA scope.
