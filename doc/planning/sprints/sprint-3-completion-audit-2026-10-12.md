# Sprint 3 project completion audit

Reviewed 12 October 2026 against dev `a1dc77e940a824b0d4e9ffaabf1e4ac517e38816` and main `bac471c749b93651d4081d231b5c9b67753b6fdb`.

The remaining project work is now represented by **13 open MVP issues in Sprint 3**: eight new issues, four refined release/recovery issues, and the existing final-report issue. The review found five concrete product behavior defects and one measurement-contract defect. Two additional issues deliver a bounded hosted-client check and a refreshed Android artifact.

## Sources and scope

- [Sprint 2 Progress Report](sprint-2-report/rewind-sprint-2-progress-report.docx), reporting 27 September–10 October with a 10 October snapshot.
- [Submitted project proposal](../proposals/rewind-project.md), the detailed baseline used by the report.
- [Earlier proposal](../proposals/proposal-rewind.md) and [module brief](../context/project-brief.md), for requirement and assessment context.
- [Working agreement](../../../AGENTS.md), which supersedes older execution contracts, roles and evidence gates.
- Current source, focused test source, GitHub issue decisions, release artifacts and Actions records, accessed through authenticated `gh`.

Three in-thread GPT-6.1 Sol subagents reviewed product parity, client delivery, and release/recovery after the user approved Sol as the fallback for unavailable Sonnet. Their findings were reconciled with current source and existing issues before filing.

This was a backlog audit, not an implementation or live acceptance run. No AWS operation, deployment, application-code change, device verification or full test suite was performed. The report and frozen final-report/archive folders were not edited. Existing user workspace changes were preserved.

## New issues

All eight have the `mvp` label and **Sprint 3 (11–24 October 2026)** milestone. Each contains Problem, Expected, How to check, evidence and a bounded scope.

| Issue                                                            | Remaining outcome                                                                                            | Verification basis                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [#521](https://github.com/Collaboration95/rewind-app/issues/521) | Refresh cycle, allowance and release state during an open session; restore capture eligibility after a reset | Mounted client tests across time boundaries/context changes, then one local short-cycle browser journey    |
| [#522](https://github.com/Collaboration95/rewind-app/issues/522) | Save every eligible own clip from an older film, including beyond the first 50 archive entries               | Pagination fixtures with a cycle beyond/split across pages, failure/retry, exact clip identity checks      |
| [#523](https://github.com/Collaboration95/rewind-app/issues/523) | Propagate reaction updates to other open chats and reconcile missed changes after reconnect                  | Two-member add/remove/reconnect, duplicate/unread checks and outsider denial                               |
| [#524](https://github.com/Collaboration95/rewind-app/issues/524) | Stop claiming this device is enabled after reminder registration fails                                       | Settings tests for enabled, denied, error, cleanup-pending, revoked and rejected enable calls              |
| [#525](https://github.com/Collaboration95/rewind-app/issues/525) | Export Android downloaded media to an accessible destination instead of only app-private cache               | Transfer/export/cancellation tests and opening the exported film/clip outside the app cache                |
| [#526](https://github.com/Collaboration95/rewind-app/issues/526) | Repair obsolete 180×320 measurement assertions and measure current 720p behavior                             | Focused runner tests, current five-member/25-clip workload and declared database/storage/timing boundaries |
| [#527](https://github.com/Collaboration95/rewind-app/issues/527) | Establish current hosted Safari/Home Screen integration outcomes once                                        | Real provider invitation return, capture/sealing, playback/download and visible push/tap with owned data   |
| [#528](https://github.com/Collaboration95/rewind-app/issues/528) | Publish a current Android hosted-dev test APK after client fixes                                             | Source/config/checksum provenance, clean install/upgrade and current-client smoke                          |

The [#521](https://github.com/Collaboration95/rewind-app/issues/521) shutter/allowance defect is marked `high priority`. The first six issues are labelled `bug`; [#528](https://github.com/Collaboration95/rewind-app/issues/528) is an `enhancement`. [#527](https://github.com/Collaboration95/rewind-app/issues/527) records a missing verification result rather than claiming a reproduced platform defect.

### Directly checked evidence

- `src/groups/RealAccountGroupExperience.tsx` loads the group and ledger through mount/context callbacks while deriving the displayed week from the advancing clock. It has no boundary/foreground refresh for those snapshots.
- `src/real/Film.tsx` fetches one archive page at limit 50, filters that page by cycle and ignores the next clip cursor; `server/src/db.ts` orders own clips across released cycles.
- The reaction mutation in `server/src/http.ts` returns to its caller without publishing an update; the chat client's merge retains existing message rows.
- `src/real/Settings.tsx` stops notification enabling only for a denied result; other unsuccessful results still reach the device-enabled success toast.
- `src/archive/archive-download.ts` returns a native cache URI; the Film actions ignore it and announce “Saved.”
- `scripts/measure-real-group-performance.mjs` expects 180×320 while `server/src/ffmpeg.ts` produces 720×1280. A small direct assertion probe rejected the 720p-shaped report with `720 !== 180` and accepted the obsolete dimensions. This proves the assertion mismatch, not current end-to-end performance.

The other product findings are source-supported defects with explicit reproduction tests in their issues; no fresh UI execution was claimed.

## Existing delivery issues refined

| Issue                                                            | Refinement                                                                                                                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#230](https://github.com/Collaboration95/rewind-app/issues/230) | Complete release deployment and environment isolation; remove retired cost-audit/hibernation obligations; preserve main/release protections                                                   |
| [#504](https://github.com/Collaboration95/rewind-app/issues/504) | Deliver release PostgreSQL, operation targeting, host backup settings, isolated backup permissions and a measured restore                                                                     |
| [#505](https://github.com/Collaboration95/rewind-app/issues/505) | Export from a consistent PostgreSQL snapshot, quiesce writers, reconcile every table, install atomically and prove preservation of post-cutover writes; added missing `mvp`                   |
| [#515](https://github.com/Collaboration95/rewind-app/issues/515) | Replace the already-resolved scope question with operational release Cognito delivery, callbacks/invitation return, sign-out and disabled password login; changed `question` to `enhancement` |

All four remain open in Sprint 3. Their older comments remain historical records; current issue bodies and AGENTS.md express the current outcome.

**Release status correction:** [run 37211284199](https://github.com/Collaboration95/rewind-app/actions/runs/37211284199) still waits at the protected release environment for main `bac471c`; its deploy job has executed no steps. Infrastructure was provisioned, but this is not a completed application release. Configured release SQLite must not be described as a verified live product. Completing these issues does not authorize bypassing the existing release approval.

## Proposal and report reconciliation

| Report or baseline area                               | Disposition                                                                                                                                                                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed identity                                      | Dev implementation exists; operational release gap is [#515](https://github.com/Collaboration95/rewind-app/issues/515)                                                                                                           |
| Private groups, invitations and membership boundaries | Implemented; provider/PWA integration is included in the bounded [#527](https://github.com/Collaboration95/rewind-app/issues/527) check                                                                                          |
| Photo/video, landscape support and Home entry         | Current product choices; no return to video-only or forced camera-first startup                                                                                                                                                  |
| Four retro modes                                      | Implemented. [#367](https://github.com/Collaboration95/rewind-app/issues/367) explicitly accepts native original upload followed by server processing; do not create universal native pre-upload work                            |
| Contribution count/time limits and correction         | Server behavior exists; [#521](https://github.com/Collaboration95/rewind-app/issues/521) fixes the stale client allowance                                                                                                        |
| Sealed contributions and private media                | Existing authorization/processing checks remain; no new privacy mechanism inferred solely from narrower device evidence                                                                                                          |
| Four-week cycle, next cycle and 24-hour premiere      | Server lifecycle exists; [#521](https://github.com/Collaboration95/rewind-app/issues/521) updates continuing client sessions                                                                                                     |
| Film ordering/audio and labelled filler               | Existing implementation accepted in [#59](https://github.com/Collaboration95/rewind-app/issues/59); exact filler selection is discretionary in the submitted baseline, so no member-first/duration-policy expansion              |
| Film and own-clip downloads                           | [#522](https://github.com/Collaboration95/rewind-app/issues/522) fixes older-cycle discovery; [#525](https://github.com/Collaboration95/rewind-app/issues/525) completes Android user-accessible export                          |
| Processed-media retention and pinned versions         | [#513](https://github.com/Collaboration95/rewind-app/issues/513) accepts fresh output keys, exact-version deletion and the 30-day noncurrent-version policy; no duplicate retention project                                      |
| PostgreSQL and managed backups                        | Dev delivered; release completion [#504](https://github.com/Collaboration95/rewind-app/issues/504) and lossless rollback [#505](https://github.com/Collaboration95/rewind-app/issues/505)                                        |
| Web push                                              | Delivered implementation; truthful opt-in [#524](https://github.com/Collaboration95/rewind-app/issues/524) and actual visible receipt/tap [#527](https://github.com/Collaboration95/rewind-app/issues/527)                       |
| Android distribution                                  | [An APK already exists](https://github.com/Collaboration95/rewind-app/releases/tag/apk-dev-e39f707); [#528](https://github.com/Collaboration95/rewind-app/issues/528) refreshes it rather than claiming it was never distributed |
| Native iOS and native push                            | Outside the active delivery scope; do not reactivate App Store/TestFlight tasks                                                                                                                                                  |
| API/compilation targets                               | Historical results remain valid under old conditions; [#526](https://github.com/Collaboration95/rewind-app/issues/526) repairs and refreshes current measurement                                                                 |
| Operational metrics                                   | [#514](https://github.com/Collaboration95/rewind-app/issues/514) accepts structured logs and persisted operational records; CloudWatch paging/dashboard work stays out of scope                                                  |
| Release workflow                                      | [#230](https://github.com/Collaboration95/rewind-app/issues/230) completes deployment; exact-revision Quality remains required                                                                                                   |
| Final report, presentation, Scrum and contributions   | Already covered by [#362](https://github.com/Collaboration95/rewind-app/issues/362); no duplicate assessment issue. Final artifacts were not inspected because their folder remains frozen                                       |

## Work order

1. Start [#521](https://github.com/Collaboration95/rewind-app/issues/521) and [#524](https://github.com/Collaboration95/rewind-app/issues/524) for immediate user-facing correctness; implement [#522](https://github.com/Collaboration95/rewind-app/issues/522), [#523](https://github.com/Collaboration95/rewind-app/issues/523) and [#525](https://github.com/Collaboration95/rewind-app/issues/525) as focused changes.
2. In parallel, deliver [#505](https://github.com/Collaboration95/rewind-app/issues/505) and prepare [#504](https://github.com/Collaboration95/rewind-app/issues/504)/[#515](https://github.com/Collaboration95/rewind-app/issues/515) under [#230](https://github.com/Collaboration95/rewind-app/issues/230). Authentication, private-media, database and infrastructure/deployment merges stay with the owner.
3. Repair and run [#526](https://github.com/Collaboration95/rewind-app/issues/526) against current code. Report the actual environment and measured result; local results are not hosted claims.
4. After relevant client fixes, complete [#527](https://github.com/Collaboration95/rewind-app/issues/527) and rebuild/smoke [#528](https://github.com/Collaboration95/rewind-app/issues/528). These are bounded project deliverables, not new recurring per-PR device gates.
5. Finish the reviewed main promotion/release and environment checks through [#230](https://github.com/Collaboration95/rewind-app/issues/230); consolidate actual implementation/results, presentation and factual contributions in [#362](https://github.com/Collaboration95/rewind-app/issues/362) when that work is opened.

The existing [#497](https://github.com/Collaboration95/rewind-app/issues/497) deployment-trigger improvement and [#498](https://github.com/Collaboration95/rewind-app/issues/498) speedup umbrella remain optional, non-MVP follow-ups. Current polling still enforces exact-revision Quality. [#170](https://github.com/Collaboration95/rewind-app/issues/170) stays parked under the explicit disposable-test-media decision; it is reconsidered only when its data-preservation trigger occurs.

## Audit verification

All eight creations and four edits were read back from GitHub. Titles, exact bodies, required labels, open state and Sprint 3 milestone matched. No Project board was changed; no implementation was marked Doing or Done. Historical closures were not reopened merely because their old contracts demanded additional evidence.

## Follow-up regression review on 12 October

The owner requested a parallel check that fulfilling these issues would preserve existing behavior, specifically the 1080p media upgrade. Three new GPT-6.1 Sol subagents reviewed client state/chat, downloads/reminders/Android, and release/report scope. The main agent traced and exercised the media-resolution boundary.

All 13 outcomes remain valid. Eleven issue bodies were corrected or given explicit regression constraints; #515 and #527 already preserve the relevant current scope. These are pre-implementation safeguards, not proof that a future patch cannot regress.

### Resolution correction for #526

The original title and brief wording conflated capture and film output. #526 is now **Repair the film benchmark without changing capture or media quality**.

| Stage                      | Current behavior                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Browser recording          | Requests 1080p at ideal 30 fps, with 8 Mbps video and 128 kbps audio; actual browser/device resolution can vary |
| Browser retro video        | Preserves orientation and fits within 1920 long-edge / 1080 short-edge pixels without upscaling                 |
| Individual processed video | Retains source dimensions and rate; no repeated look on client-processed clips                                  |
| Photo-derived segment      | 720×1280                                                                                                        |
| Compiled group film        | 720×1280 at 30 fps, landscape letterboxing, existing Safari-compatible encoding and normalized audio            |

The benchmark repair must not change production capture/retro/encoding code to fit an assertion. Its existing 720p synthetic inputs are a declared fixture, not a maximum allowed capture size.

Checks actually executed:

- `npm run test:focused -- frontend tests/retro-looks.test.ts`: **17 passed**.
- `npm run test:focused -- server server/tests/film-compilation.test.mjs`: server build and **6 tests passed**.
- Temporary real-FFmpeg probe: **1080×1920 → individual 1080×1920 → film 720×1280**, with audio.
- Temporary real-FFmpeg probe: **1920×1080 → individual 1920×1080 → film 720×1280**, with audio.

Only owned generated temporary media was used and cleaned up. These checks prove current processing behavior, not physical capture, hosted performance or completed issue #526.

### Constraints added before implementation

| Issues | Existing behavior protected                                                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #521   | Quiet refresh preserves navigation, draft/reply/Settings state and live capture/transfer recovery; confirmed quota stays authoritative during errors; already-open Archive reconciles without losing pages |
| #522   | Retain existing paginated fresh-download authorization; metadata-only discovery, independent cursor termination/deduplication and request/account/group/cycle fencing                                      |
| #523   | Reaction updates preserve message IDs/order, unread counts, reconnect behavior and composer state; no resurrection of reported/blocked content or quoted text                                              |
| #524   | Confirm enabled registration only on a successful snapshot; preserve preference-only behavior, consent gesture, uncertain-registration recovery and sign-out cleanup                                       |
| #525   | Use a real SDK-supported external export, disk-backed transfer, accurate cancellation/share outcomes and asset-level full-operation serialization                                                          |
| #528   | Retain Android package/signing identity, increase version code, and prove upgrade without uninstalling or clearing data; no unrelated SDK migration                                                        |
| #230   | Do not reintroduce retired host stop/destroy or hibernation tooling                                                                                                                                        |
| #504   | Drain all writers before the final snapshot, not just HTTP traffic; preserve private/TLS/environment/backup isolation and explicit release settings                                                        |
| #505   | Use database-only installation and retain current media/S3 versions; rehearse on isolated data rather than mandating a live reverse cutover; unreadable PostgreSQL requires a different recovery path      |
| #362   | Preserve completed model assembly and refresh actual facts; remove obsolete contracts/approval roles without reopening frozen report work                                                                  |

#515 remains managed release authentication with local/dev developer sign-in preserved. #527 remains a one-off platform verification deliverable, not a blanket device gate or reason to reopen historical closures.

GitHub readback confirmed the exact amended bodies, open state, MVP labels and Sprint 3 milestone for all eleven edited issues. No application source was changed and no PR, deployment or cloud operation occurred during this follow-up.
