# Capture and contribution report package

**Status:** source-pinned model draft for issue [#358](https://github.com/Collaboration95/rewind-app/issues/358). **Evidence cut:** accepted dev commit [`fc2b8c811e9c13b176113fa0bdb2c015798990b4`](https://github.com/Collaboration95/rewind-app/commit/fc2b8c811e9c13b176113fa0bdb2c015798990b4). The package is a design/report input, not product acceptance or final report assembly.

This package models UC04 video capture/submission, UC05 photo contribution, and UC06 allowance/correction. It derives the bounded R04–R07, R16 and R22 mapping from issue #358 and the Sprint 2 planning contract. It describes code present at the pinned commit; later commits do not alter the evidence cut.

## Evidence boundary

- The browser/native capture boundary is `CameraPlatform`; video and still capture have separate screen/session lifecycles.
- Real-group transfer configuration is read before capture. When the server reports `directTransfer: true`, the client uses a resumable upload-intent flow and private object storage. When it reports false, the existing authenticated staged-source intake remains available. Photo and video share the server quota and processing boundaries.
- Both upload paths validate contribution metadata, use an idempotency key, reserve allowance when the contribution is accepted, and create a pending media job. Server FFmpeg validates/transforms after upload acceptance. The `soft-focus` and `high-contrast` modes are current post-upload processing choices.
- R05's four original retro treatments before final upload are not implemented by this evidence cut. The pre-upload retro tranche is future work tracked by [#365](https://github.com/Collaboration95/rewind-app/issues/365), [#366](https://github.com/Collaboration95/rewind-app/issues/366), and [#367](https://github.com/Collaboration95/rewind-app/issues/367). The diagrams do not imply that work is complete.
- The existing classes and boundaries below are read from code. Analysis models are technology-neutral responsibilities; they are not claims that analysis entities are runtime classes.

## Package map

| Deliverable                                            | Location                               | Coverage                                                                               |
| ------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------- |
| Use cases, branches, requirements, and evidence limits | [use-cases.md](use-cases.md)           | Seven major flows and their normal/relevant exceptional branches                       |
| Analysis/design classes and paired sequences           | [models.md](models.md)                 | One class pair per UC and one sequence pair per major flow                             |
| Pattern comparison and decision                        | [design-problem.md](design-problem.md) | Before/after class and sequence views; Adapter, Strategy and Template Method evaluated |
| Editable diagrams                                      | [diagrams/](diagrams/)                 | 24 SVG figures, rendered and checked for layout/readability                            |

## Requirement trace

The summary wording below is a bounded mapping to the requirements named by #358. It preserves the requirement IDs and connects each one to modeled flows and exact source links in [use-cases.md](use-cases.md). It does not replace the submitted proposal's canonical wording.

| Requirement                                                             | Use cases           | Package evidence                                                                                           | Limit                                                                                               |
| ----------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| R04 — short portrait video capture, audio, review/trim and contribution | UC04-F1–F3          | Platform boundary, review session, upload and processing paths                                             | This source walkthrough is not a physical-device acceptance run or proof of final encoding quality. |
| R05 — retro treatment before final upload                               | UC04-F2/F3; UC05-F2 | Current two-mode server processing is shown after upload; future pre-upload work is called out separately. | The required four original pre-upload treatments are future work (#365–#367).                       |
| R06 — photo contribution                                                | UC05-F1/F2          | Managed still capture, validation, one-item/three-second contribution and server processing                | No hosted-phone acceptance is asserted.                                                             |
| R07 — bounded allowance and one correction                              | UC06-F1/F2          | Server quota window, atomic reservation, idempotency, deletion eligibility and replacement link            | Concurrency behavior is represented from code, not newly tested here.                               |
| R16 — private media transfer                                            | UC04-F3; UC05-F2    | Configured direct upload intent to private storage and the authenticated staged-source fallback            | No live provider/storage acceptance is claimed.                                                     |
| R22 — report inputs and design evidence                                 | UC04–UC06           | Flow catalogue, crosswalk, models and pattern analysis                                                     | This package does not assemble the final report or assign member contributions, hours or approvals. |

## Assembly handoff

The lead can link [models.md](models.md) as the UC04–UC06 model catalogue. Incorporation of all figures into the final DOCX is pending lead-owned assembly; this package does not claim that the figures are already in the final report. Refresh the package against the final Sprint 3/OIDC/PostgreSQL and client-retro implementation before final sign-off.

## Verification record

The exact source links and pinned line anchors appear in [use-cases.md](use-cases.md) and [models.md](models.md). The diagrams are editable SVG. Package and supporting-document links are relative; implementation references pin the accepted code SHA. No product tests were run for this prose/model change. Diagram rendering and visual inspection, flow-to-sequence coverage, local-link validation, and a pinned-source walkthrough are the relevant checks.
