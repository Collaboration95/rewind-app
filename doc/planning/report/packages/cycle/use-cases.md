# UC07 and UC08 — cycle close and reveal use cases

**Code evidence cut:** [`fc2b8c811e9c13b176113fa0bdb2c015798990b4`](https://github.com/Collaboration95/rewind-app/commit/fc2b8c811e9c13b176113fa0bdb2c015798990b4). “Current implementation” in this package means source at that exact accepted `dev` commit.

## Actors and domain boundary

| Actor/concept                   | Role in these use cases                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Group member                    | Contributes to the current collecting cycle and, after server publication, views an authorized release.                                                                  |
| Cycle scheduler                 | Scans persisted real-group cycles for due transitions and invokes the lifecycle operation; it also advances the bounded worker loop.                                     |
| Media worker                    | Claims persisted clip/film jobs, waits for accepted clip jobs to settle, compiles, and finalizes outputs.                                                                |
| SQLite persistence              | Stores group current-cycle pointer, cycle status/release timestamps, unique lifecycle events, film-job state, ordered compilation inputs, and output integrity metadata. |
| FFmpeg and media store boundary | Compiles a temporary film and probes it; the local file store is the source cut’s default, while storage adapters are code boundaries.                                   |

Analysis names responsibilities and information; it does not imply implementation classes. Design names actual functions and durable record concepts. The local `/cycles/demo/advance` control in the domain note is not the real-group automatic scheduler.

## UC07 — Automatically close a cycle and open its successor

**Goal:** At the configured end instant, stop accepting contributions into the old cycle, begin reveal/compilation, and make exactly one successor cycle current immediately.

**Preconditions:** a real group has a persisted current cycle with a valid start/end interval; the scheduler can read and write the application database.

### UC07-F1 — Close a due cycle and start its successor

**Normal flow:** the scheduler selects a real-group cycle in `collecting` whose `ends_at` is no later than the tick’s fixed `now`; `advanceCycleLifecycleWithStore` opens a writer transaction, re-reads the cycle, changes it to `revealing` while retaining the locked media state, records `collecting_to_revealing`, ensures the one cycle-scoped film job and its ordered candidate input snapshot, ensures a successor beginning at the old end instant with the same duration, then conditionally moves `groups.current_cycle_id` to that successor and commits. The successor can collect while the old film is being compiled.

**Relevant branches:** a future end instant returns `waiting_for_boundary` without changing the cycle; missing group/cycle returns `not_found`; invalid time/status returns a safe lifecycle error and rolls back; a database failure aborts the transaction; unsettled accepted clip jobs keep compilation from claiming/finalizing the film and the release remains unpublished.

### UC07-F2 — Replay a due transition after duplicate tick or restart

**Normal flow:** a later tick selects the same due/revealing row or an older explicitly processed cycle; the lifecycle transaction finds the existing successor through `previous_cycle_id`, finds the unique film job, preserves unique transition events, and conditionally advances the group pointer only if it still points at that old cycle. The same persisted rows make a process restart resume the work.

**Relevant branches:** duplicate or concurrent calls serialize at the writer transaction and converge on the existing records; replay of an older cycle cannot rewind a pointer already advanced to a newer cycle; a cycle not owned by the group, invalid persisted interval, or unsupported status is rejected. These are source-model statements, not a claim that a hosted restart exercise was run for this package.

## UC08 — Compile, retry, publish, premiere, and archive a cycle film

**Goal:** Produce a valid chronological film from the cycle’s settled processed contributions, make it available only after verified publication, show a 24-hour premiere measured from publication, then retain the release in the permanent authorized archive as required by R09. The pinned source model supports the published archive state and access paths; this package does not claim an indefinite hosted-storage guarantee or acceptance result.

**Preconditions:** the old cycle is `revealing` (or is an existing archived cycle during idempotent repair); the durable film job is scoped to that group/cycle; only settled, eligible processed clip jobs belong in its frozen input snapshot.

### UC08-F1 — Compile the settled chronological input snapshot

**Normal flow:** the worker lists claimable film work in bounded order, claims the job in a transaction with a lease and incremented claim generation, confirms accepted clip jobs have settled and freezes/reconciles the input set, verifies each retained clip against its finalized digest, compiles ordered inputs with normalized audio and any permitted labelled filler into a unique temporary file, probes the result, verifies its bytes, then atomically commits `ready`, output path/reference, digest, length and verification time while the same generation and input snapshot remain current.

**Relevant branches:** if an accepted clip remains pending, the film waits; an empty snapshot, unavailable/tampered input, invalid filler snapshot, failed probe or changed input is a safe failure; temporary files and uncommitted stored output are cleaned up. A film without a ready verified output cannot be published.

### UC08-F2 — Retry a failed or abandoned compilation safely

**Normal flow:** a failed film below the maximum attempt count is claimable again; a worker whose processing lease expired can be reclaimed without counting the same interrupted attempt as a deliberate retry. A new claim generation fences stale workers and separates their output files. A successful current generation can finalize; the earlier worker cannot publish its stale output.

**Relevant branches:** an active lease returns `already_processing`; an expired lease resumes; transient processing failure persists a failed/retryable job; attempt exhaustion yields a delayed release, not a published film; a worker crash leaves a reclaimable persisted claim; output verification failure or cleanup error leaves the release unavailable. The worker loop’s periodic wake is operational polling over durable rows, not the source of job durability.

### UC08-F3 — Publish one verified film at or after cycle end

**Normal flow:** the lifecycle operation requires the cycle to be `revealing`, checks that the current instant is no earlier than `ends_at`, verifies the ready film’s persisted output proof and bytes, then transactionally writes `release_status = published` with `release_published_at`. The operation returns `already_published` for an already published cycle only if its film remains ready and verified.

**Relevant branches:** early publication returns `too_early`; absent/unready/failed/exhausted or digest-mismatched output returns `not_ready`; a missing or invalid cycle returns a safe error. The film URL is not returned from a locked/processing/delayed Premiere value.

### UC08-F4 — End the premiere and retain an authorized archive release

**Normal flow:** the premiere duration is calculated as 24 hours from the persisted `release_published_at`, not from the cycle’s end. During that interval the old cycle can be in premiere while the successor is current and collecting. At/after the deadline, a lifecycle tick re-verifies the output bytes, changes the old cycle to `archived`, keeps its media locked, and records `revealing_to_archived`; archive listing/serving uses the group/member authorization boundary and the published release state.

**Relevant branches:** before the deadline the lifecycle reports `premiere`; if publication has not completed or the file no longer matches the integrity record it remains waiting/ unavailable and is not archived as a usable release; duplicate archive ticks return an already-archived outcome; a member or group without authority receives no media capability. This documentation does not claim hosted archive acceptance.

## Flow checklist

| Flow    | Normal path covered                                                                                                 | Relevant exceptional/recovery paths represented                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| UC07-F1 | Due scan → locked reveal → lifecycle event → film job/input snapshot → immediate successor/current pointer → commit | Early tick; missing/invalid persisted cycle; transaction failure; pending clip settlement delays film readiness/publication |
| UC07-F2 | Replay → reuse successor/job/event → safe pointer check → commit                                                    | Concurrent/duplicate tick; process restart; replay older than current pointer; group mismatch/invalid interval/status       |
| UC08-F1 | Claim → settled frozen inputs → ordered compile/probe → generation-fenced verified ready output                     | Waiting inputs; empty inputs; missing/tampered source; invalid filler/probe; changed input; cleanup                         |
| UC08-F2 | Retryable claim or expired lease → new/recovered generation → finalize or persist failure                           | Active lease; transient failure; stale worker; crash; retry exhaustion/delayed release; integrity/cleanup failure           |
| UC08-F3 | Ready verified output → end-time guard → persisted publication timestamp                                            | Too early; missing/not ready; invalid cycle/time; repeated publication with verification                                    |
| UC08-F4 | Publication + 24h → integrity-checked archive transition → authorized archive                                       | Before deadline; unpublished/delayed; integrity mismatch; duplicate archive tick; unauthorized media request                |

## Transition strategy links

The cycle state and time rules are in [the domain cycle-control contract](../../../../../docs/domain/cycle-control-contract.md); persisted lifecycle/job records and the local persistence boundary are summarized in [the architecture note](../../../../../docs/architecture/hosted-demo-persistence.md). A real-group close begins at the persisted `ends_at`; the Demo-only control may adjust its own deterministic window. The analysis and design sequences for each listed flow are linked from [models.md](models.md).
