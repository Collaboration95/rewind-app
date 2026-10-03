# Rewind report workspace

This workspace holds the Sprint 2 model packages and factual report draft. The report follows the supplied Practice Module template and retains the proposal's final OIDC, PostgreSQL, managed recovery and pre-upload retro obligations. A source model or green pull request does not establish hosted, provider, physical-device or assessment acceptance.

- [Report draft](report-draft.md) covers all five template chapters, current and future architecture, six transition strategies, UC01–UC14, design problem comparisons, current schema, DevSecOps and contribution fields.
- [Template contract](template-contract.md) records retained-source identities, editable slots and fidelity checks.
- [DOCX draft](exports/rewind-project-report-draft.docx) and [PDF draft](exports/rewind-project-report-draft.pdf) provide the bounded rendered draft. Both remain drafts; final model incorporation, actual member attribution/effort, Scrum records and compliance sign-off remain under [#362](https://github.com/Collaboration95/rewind-app/issues/362).
- Editable overview figures are in [diagrams](diagrams/). Their captions distinguish current implementation from future targets.

## Model packages

The following paths are the intended package locations. Their accepted/review status is recorded in each issue and pull request; this index alone is not acceptance evidence.

| Package                                           | Use cases                                               | Issue                                                            |
| ------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| [ACCESS](packages/access/README.md)               | UC01 account/session; UC02 group/selection; UC03 invite | [#357](https://github.com/Collaboration95/rewind-app/issues/357) |
| [CAPTURE](packages/capture/README.md)             | UC04 video; UC05 photo; UC06 allowance/correction       | [#358](https://github.com/Collaboration95/rewind-app/issues/358) |
| [CYCLE](packages/cycle/README.md)                 | UC07 rollover; UC08 compile/retry/reveal/Archive        | [#359](https://github.com/Collaboration95/rewind-app/issues/359) |
| [PARTICIPATION](packages/participation/README.md) | UC09 prompt/timezone; UC10 reminders; UC11 chat         | [#360](https://github.com/Collaboration95/rewind-app/issues/360) |
| [ARCHIVE](packages/archive/README.md)             | UC12 playback; UC13 download; UC14 client delivery      | [#361](https://github.com/Collaboration95/rewind-app/issues/361) |

Each package enumerates its major flows, pairs analysis and design class/sequence views, records requirement/source crosswalks and compares the actual implemented pattern choice with alternatives. Final assembly must refresh affected source pins and audit all models against the final implementation. At least one use case and one design problem per real team member still requires factual ownership; agent authorship and test counts do not supply it.
