# Rewind report workspace

> **Agents: do not modify, generate or regenerate anything in this folder**
> unless the user explicitly names this folder or the report in the request.
> The report is worked on only near the end of the project (Sprint 3, from
> about 17 October 2026). Until then it is frozen, including its exports,
> diagrams, packages and presentation.

This workspace holds the Sprint 2 model packages and factual report draft. The report follows the supplied Practice Module template and retains the proposal's final OIDC, PostgreSQL, managed recovery and pre-upload retro obligations. A source model or green pull request does not establish hosted, provider, physical-device or assessment acceptance.

- [Report draft](report-draft.md) covers all five template chapters, current and future architecture, six transition strategies, UC01–UC14, design problem comparisons, current schema, DevSecOps and contribution fields.
- [Template contract](template-contract.md) records retained-source identities, editable slots and fidelity checks.
- [DOCX draft](exports/rewind-project-report-draft.docx) and [PDF draft](exports/rewind-project-report-draft.pdf) provide the bounded rendered draft. Both remain drafts; all 137 package models are incorporated as complete foldout plates. Actual member attribution/effort, Scrum records and final compliance remain under [#362](https://github.com/Collaboration95/rewind-app/issues/362).
- Editable overview figures are in [diagrams](diagrams/). Their captions distinguish current implementation from future targets.
- The [nine-slide presentation draft](exports/rewind-project-demo-draft.pptx), [slide outline](presentation/presentation-outline.md) and [factual demo script](presentation/demo-script.md) prepare the module-brief story and local proof route. Editable deck text, tables and architecture figures retain source notes. A visible demo rehearsal, real Scrum outcomes and final assessment approval remain pending.

## Model packages

The following paths are the intended package locations. Their accepted/review status is recorded in each issue and pull request; this index alone is not acceptance evidence.

| Package                                           | Use cases                                               | Issue                                                            |
| ------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| [ACCESS](packages/access/README.md)               | UC01 account/session; UC02 group/selection; UC03 invite | [#357](https://github.com/Collaboration95/rewind-app/issues/357) |
| [CAPTURE](packages/capture/README.md)             | UC04 video; UC05 photo; UC06 allowance/correction       | [#358](https://github.com/Collaboration95/rewind-app/issues/358) |
| [CYCLE](packages/cycle/README.md)                 | UC07 rollover; UC08 compile/retry/reveal/Archive        | [#359](https://github.com/Collaboration95/rewind-app/issues/359) |
| [PARTICIPATION](packages/participation/README.md) | UC09 prompt/timezone; UC10 reminders; UC11 chat         | [#360](https://github.com/Collaboration95/rewind-app/issues/360) |
| [ARCHIVE](packages/archive/README.md)             | UC12 playback; UC13 download; UC14 client delivery      | [#361](https://github.com/Collaboration95/rewind-app/issues/361) |

Each package enumerates its major flows, pairs analysis and design class/sequence views, records requirement/source crosswalks and compares the actual implemented pattern choice with alternatives. The assembly baseline is accepted dev `25d5d83c3302491d5ea6796f31afd4a3593789a3`. The report preserves each model’s original accepted package cut and refreshes affected code anchors in its source crosswalk. At least one use case and one design problem per real team member still requires factual ownership; agent authorship and test counts do not supply it.

The combined draft catalogue has 44 major-flow pairs across UC01–UC14: ACCESS 12, CAPTURE 7, CYCLE 6, PARTICIPATION 10 and ARCHIVE 9. All 137 package SVGs are embedded unchanged in the report: 28 UC class views, 88 sequence views for 44 major-flow pairs, 20 before/after pattern views and one ACCESS overview; each use case has both class views and each major flow has both sequence views. This structural audit does not establish final model semantics, deployment, device acceptance or human ownership. The four report overview figures supplement the detailed package models; every package model is now a complete plate inside the intended System Design model/pattern slots. M001–M137 captions link the exact SVG, while package registers identify the issue, model cut and refreshed baseline code. Native SVGs with lossless PNG fallbacks preserve sharp zoom. The four original overview figures remain unchanged.

## Intentional template extension

The cover and all ordinary body sections retain the supplied A4 portrait geometry, styles, numbering, logo and header/footer. The batch lead selected complete readable foldouts under owner authority: 119 plates use A3 landscape (16.54 × 11.69 inches), and 18 dense/tall plates use a custom 22 × 16.54 inch landscape foldout. These custom plates are not standard A2. All retain one-inch margins and the template header/footer; the original A4 body geometry resumes between package blocks and after System Design. There are no fragmented model crops or repeated locator pages. Captions use 9 pt; principal 14 px SVG labels print at least 8.4 pt and 12 px annotations at least 7.2 pt. A few original 11 px notes print at least 6.6 pt.

## Current evidence boundary

PR #398 provides numeric filesystem-capacity visibility, not recovery or successful deployment. [#399](https://github.com/Collaboration95/rewind-app/issues/399) records the unsafe Demo/reset shared-media deletion path at this baseline. Its fail-closed fix is reviewed in batch `bb3b089` and awaits dev integration; worker checks were reported as 26 focused, 452 server, 612 frontend and 6 accessibility checks, not rerun for this report. No hosted reset/restore or final private-data acceptance is claimed. [#267](https://github.com/Collaboration95/rewind-app/issues/267) was independently accepted and closed through explicitly authorized substituted agent review; named researchers’ agreement and retroactive timeliness are not inferred. Unknown team ownership, effort and Scrum facts remain pending.

## Final artifact verification

The final DOCX was rendered with the bundled `render_docx.py --emit_pdf --dpi 90`. All 160 final page images were visually inspected at their original render resolution: 23 A4 portrait body pages, 119 A3 landscape model pages and 18 custom 22 × 16.54 inch foldouts. Every model is complete on one plate; captions, source registers, original overview figures, restored body geometry and page fields were checked. No export-induced clipping or blank pages were found. The matching PDF retains vector model text and shapes; exports are approximately 17.0 MB DOCX and 2.5 MB PDF.

The structural audit passed: 137 model/source mappings and byte-identical embedded SVGs; 44 major-flow analysis/design pairs; 25 unchanged template parts and four unchanged overview images; 29 preserved native contents fields with correct page caches; 117 baseline code anchors and 187 resolved local Markdown links. These artifact checks do not establish deployment or missing participant facts.
