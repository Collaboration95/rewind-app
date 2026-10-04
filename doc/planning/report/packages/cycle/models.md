# UC07 and UC08 — analysis and design models

**Pinned implementation:** [`fc2b8c811e9c13b176113fa0bdb2c015798990b4`](https://github.com/Collaboration95/rewind-app/commit/fc2b8c811e9c13b176113fa0bdb2c015798990b4). Every implementation link below names that immutable commit. Analysis diagrams use responsibility/concept names. Design diagrams use evidenced source functions, database records, adapters, and domain types.

## UC07 — Automatically close a cycle and open its successor

### Analysis class diagram

![UC07 analysis classes: member, scheduler, cycle, lifecycle, and successor](diagrams/uc07-analysis-class.svg)

### Design class diagram

![UC07 design classes: scheduler tick, lifecycle transaction, persisted cycle/event/job](diagrams/uc07-design-class.svg)

### UC07-F1 — Close due cycle and start successor

**Analysis sequence**

![UC07-F1 analysis sequence](diagrams/uc07-f1-analysis-sequence.svg)

**Design sequence**

![UC07-F1 design sequence](diagrams/uc07-f1-design-sequence.svg)

### UC07-F2 — Replay after duplicate tick or restart

**Analysis sequence**

![UC07-F2 analysis sequence](diagrams/uc07-f2-analysis-sequence.svg)

**Design sequence**

![UC07-F2 design sequence](diagrams/uc07-f2-design-sequence.svg)

## UC08 — Compile, retry, publish, premiere, and archive

### Analysis class diagram

![UC08 analysis classes: worker, settled inputs, film, release, and archive](diagrams/uc08-analysis-class.svg)

### Design class diagram

![UC08 design classes: persistent media job, compilation inputs, worker lease, lifecycle, and Premiere](diagrams/uc08-design-class.svg)

### UC08-F1 — Compile the settled chronological input snapshot

**Analysis sequence**

![UC08-F1 analysis sequence](diagrams/uc08-f1-analysis-sequence.svg)

**Design sequence**

![UC08-F1 design sequence](diagrams/uc08-f1-design-sequence.svg)

### UC08-F2 — Retry a failed or abandoned compilation safely

**Analysis sequence**

![UC08-F2 analysis sequence](diagrams/uc08-f2-analysis-sequence.svg)

**Design sequence**

![UC08-F2 design sequence](diagrams/uc08-f2-design-sequence.svg)

### UC08-F3 — Publish one verified film at or after cycle end

**Analysis sequence**

![UC08-F3 analysis sequence](diagrams/uc08-f3-analysis-sequence.svg)

**Design sequence**

![UC08-F3 design sequence](diagrams/uc08-f3-design-sequence.svg)

### UC08-F4 — End premiere and retain an authorized archive release

**Analysis sequence**

![UC08-F4 analysis sequence](diagrams/uc08-f4-analysis-sequence.svg)

**Design sequence**

![UC08-F4 design sequence](diagrams/uc08-f4-design-sequence.svg)

## Exact source pins

The commit component of every source URL is `fc2b8c811e9c13b176113fa0bdb2c015798990b4`. The line anchors resolve against that accepted source snapshot.

| Concern                                                                                                                                        | Pinned source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real-group due scan, bounded cursor, lifecycle call, publication attempt, round-robin worker tick                                              | [`server/src/cycles/scheduler.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/cycles/scheduler.ts#L45)                                                                                                                                                                                                                                                                                                                            |
| Transactional lifecycle: lock at end, event uniqueness, film-job ensure, successor creation, current-cycle pointer, 24-hour archive transition | [`server/src/cycles/lifecycle.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/cycles/lifecycle.ts#L200), [`advanceCycleLifecycleVerified`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/cycles/lifecycle.ts#L325), [`ensureSuccessor`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/cycles/lifecycle.ts#L276) |
| Publication time guard, persisted publication timestamp and ready-output checks                                                                | [`publishCycleReleaseVerified`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/cycles/lifecycle.ts#L216)                                                                                                                                                                                                                                                                                                                              |
| One film job per cycle, eligible input snapshot and persistent ordered inputs                                                                  | [`ensureCompilationJob`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/index.ts#L502), [`compilation_job_inputs` schema](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/db.ts#L1071)                                                                                                                                                                                    |
| Claim lease, generation fencing, attempt count, progress and recoverability                                                                    | [`claimCompilationJob`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/index.ts#L599), [`worker claim selection`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/worker.ts#L148)                                                                                                                                                                                    |
| Three-attempt compile bound and labelled-filler threshold                                                                                      | [`MAX_COMPILATION_ATTEMPTS`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/index.ts#L131), [`ARCHIVE_FILLER_MINIMUM_CLIP_COUNT`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/index.ts#L134)                                                                                                                                                                     |
| Chronological source ordering, eligible archived filler, and persisted input positions                                                         | [`eligibleCompilationInputs`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/index.ts#L380), [`ensureCompilationJob` input positions](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/index.ts#L546), [`ordered input read`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/index.ts#L785)              |
| FFmpeg film compilation, audio loudness normalization, and filler label overlay                                                                | [`compileFilmWithFfmpeg`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/ffmpeg.ts#L463)                                                                                                                                                                                                                                                                                                                                              |
| Ordered input reconciliation, verification, FFmpeg invocation, temp output and atomic ready publication                                        | [`publishCompilationOutput`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/index.ts#L895), [`processCompilationJobInternal`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/jobs/index.ts#L963)                                                                                                                                                                         |
| Persisted lifecycle, film, ordered-input and finalized output schema/migrations                                                                | [`server/src/db.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/db.ts#L963), [`film job fields and indexes`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/db.ts#L1071)                                                                                                                                                                                                  |
| Real-group release projection from persisted cycle/job state                                                                                   | [`server/src/groups/real.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/groups/real.ts#L142)                                                                                                                                                                                                                                                                                                                                     |
| Client-facing Premiere union; no playback URL in locked/processing/delayed/failed states                                                       | [`src/domain/premiere.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/domain/premiere.ts#L1)                                                                                                                                                                                                                                                                                                                                             |
| Protected premiere and archive serving boundaries                                                                                              | [`server/src/http.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/http.ts#L2995), [`archive authorization and listing`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/http.ts#L3146)                                                                                                                                                                                     |
| Domain/architecture constraints reused by the diagrams                                                                                         | [`docs/domain/cycle-control-contract.md`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/docs/domain/cycle-control-contract.md#L1), [`docs/architecture/hosted-demo-persistence.md`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/docs/architecture/hosted-demo-persistence.md#L21)                                                                                                               |

## Reading the design models

The lifecycle’s functional transition logic is coordinated by a periodic scheduler, but correctness lives in the transaction and unique persisted rows: status, lifecycle events, current-cycle pointer, film job, ordered inputs, publication time, and output proof. The queue is a durable `media_jobs` table with claim lease, attempt count and generation fencing. FFmpeg runs outside the short writer transaction; only a verified output from the current claim becomes `ready`. This evidence supports a persisted state-transition and job-queue design. It does not support claiming a GoF State object hierarchy or one Command object per operation.

The source package uses SQLite/local media as the current implementation cut. Managed OIDC, PostgreSQL, managed backups, and processing retro treatment before upload remain Sprint 3 targets and are not drawn as current design.
