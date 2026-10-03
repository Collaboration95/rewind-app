# Participation model package

This draft models UC09 owner prompt/timezone controls, UC10 member reminder preferences and asynchronous delivery, and UC11 private group chat. It supports the participation slice of the report; it is not the assembled report or final Sprint 3 architecture review.

## Requirements crosswalk

The working IDs and wording below follow the Sprint 2 execution plan’s §3 rows and the accepted #360 execution contract. They are requirement trace labels, not independent proof of implementation or course acceptance.

| Requirement                                                                                  | Trace and model coverage                                                                                                                                                                                              | Evidence cut and limit                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R12 — §4.5 built-in/custom owner prompt controls                                             | UC09 owner loads the existing prompt/timezone and saves built-in or custom prompt plus IANA timezone; current collecting cycle and future-cycle effect; unauthorized, invalid, closed-cycle and persistence failures. | Accepted `dev` snapshot `1128b6a68985cf68215beb4a7a80fd00ec4242fa`; the package traces the implementation at this cut. It does not claim hosted or two-owner acceptance.                                                                                                                                                                                                 |
| R13 — §4.5 Sunday 19:00 group-local reminder, snooze/disable, asynchronous provider outcomes | UC10 preferences and schedule, device destination register/disable/revoke, due-job scan and idempotent queue, provider send, receipt check, retries, invalid destination, cancellation and status.                    | The code cut contains preference persistence, destination/outbox functions, provider adapters and an explicit bounded `reminders --once` CLI pass; it does not start a periodic reminder schedule. A configured provider receipt and actual device delivery are separate acceptance gates; a one-shot CLI outcome is not proof of recurring operation or actual display. |
| R14 — §4.6 private text/reply/reaction, reconnect/persistence                                | UC11 bounded history, idempotent text/reply, supported reaction toggle, persisted SSE event replay after reconnect, access denial and session/group context changes.                                                  | SQLite persistence and local client/server paths are source evidence, not a real two-member hosted run or device acceptance. No message editing, attachments or read receipts are modeled.                                                                                                                                                                               |
| R22 — supplied report template §§3.3.2/3.4.1/3.5.1 plus presentation/Agile evidence          | Ten major flows; three analysis and three design class diagrams; twenty paired flow sequences; four before/after problem figures; source and domain crosswalk.                                                        | This package draft does not supply human contribution facts, lecturer approval, final report assembly or final implementation/compliance sign-off. Assembly and final refresh belong to #339/#362.                                                                                                                                                                       |

## Package map

- [Use cases and flow inventory](use-cases.md) defines actors, normal outcomes and relevant exceptions for every diagrammed flow.
- [Analysis and design models](models.md) contains the per-UC class pair and per-flow sequence pairs, with exact source pins.
- [Design problem](design-problem.md) compares the Observer, Adapter and Strategy candidates with the actual transport, persistence and outbox design.

The fixed source pin is the accepted `dev` commit above. GitHub links in this package use that exact commit rather than a moving branch. Domain context reuses [`docs/domain/contracts.md`](../../../../../docs/domain/contracts.md), [`docs/domain/session-contract.md`](../../../../../docs/domain/session-contract.md), and [`docs/architecture/hosted-demo-persistence.md`](../../../../../docs/architecture/hosted-demo-persistence.md). The local Demo session contract applies to Demo chat only; real-account reminder APIs use the real-account session described by their implementation.

## Coverage inventory

| Use case                              | Included major flows | Analysis/design class pair | Paired sequence diagrams |
| ------------------------------------- | -------------------: | -------------------------: | -----------------------: |
| UC09 Owner prompt and timezone        |                    2 |                          2 |                        4 |
| UC10 Reminder preference and delivery |                    4 |                          2 |                        8 |
| UC11 Private group chat               |                    4 |                          2 |                        8 |
| Design problem                        |     before and after |              2 class views |         2 sequence views |
| **Total**                             |               **10** |                      **8** |                   **22** |

All 30 SVG source figures are rendered and inspected at normal and contact-sheet scale. This is an editable SVG draft; final source refresh is required after OIDC, PostgreSQL and client-retro work changes relevant boundaries.

## Boundaries and future work

Managed OIDC, PostgreSQL, managed backups and client-side pre-upload retro processing are future Sprint 3 work, not current behavior represented by this pin. No provider, hosted, Safari/Home Screen, device, physical-device, institutional compliance or final report acceptance is inferred here. Pattern labels describe conceptual alternatives only; the design views name observed functions, components, tables and transports rather than introducing absent pattern classes.
