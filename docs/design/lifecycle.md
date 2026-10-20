# Cycle, compiler, reveal and Archive lifecycle

<a id="scope-and-use-cases"></a>

## Scope and use cases

Developer reference for issue #538, based on static inspection of source revision `40ebeb5673d103b4b6950d095192aae744980769`. Paths below are relative to this document. Domain diagrams describe responsibilities; design diagrams name actual modules, functions and types. Mermaid blocks are editable; their `A-*`, `D-*` and `B-*` identifiers are stable cross-reference labels.

Scope starts with an accepted contribution and an existing group cycle. Capture/intake, sign-in internals and media export UX are outside this model. The system clock/scheduler is an actor: lifecycle progress does not require an open client. Members consume releases within their selected group.

| Use case                                    | Normal flow and outcome                                                                                                                                                                              | Major alternatives/exceptions                                                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **UC-01 Advance a cycle**                   | At `endsAt`, close collecting cycle, ensure its film job, create one boundary-anchored successor and move the group's current pointer atomically. Next capture proceeds while the old film develops. | Before boundary: no transition. Replay repairs/reuses successor/job without rewinding a newer pointer. Missing cycle or invalid persisted time/state fails without partial rollover.                                           |
| **UC-02 Claim or recover compiler work**    | Scheduler selects durable work; claim owns a generation and lease. An abandoned claim can be reclaimed after expiry without consuming another intentional attempt.                                   | Accepted clips still processing: wait without spending a film attempt. Live claim: busy. Ready: no-op. Failed film gets at most three intentional attempts; exhausted failure stays delayed.                                   |
| **UC-03 Generate a group film**             | Freeze settled processed inputs, preserve chronological order, verify retained bytes, concatenate/normalize, probe output, then commit the exact verified film as ready.                             | A single current clip may receive one labelled same-group archived filler. Zero inputs, unavailable accepted clips, corruption or FFmpeg failure cannot publish. Removal or ownership change during work defeats finalization. |
| **UC-04 Publish and finish premiere**       | Verify ready output, publish once at/after cycle end, retain premiere for 24 hours from publication, then archive with verified output still available.                                              | Pending/failed/missing/changed output blocks publication or archival. Early publication fails. Repeated publication preserves its timestamp; repeated archival is idempotent.                                                  |
| **UC-05 Inspect reveal and access Archive** | Authorized member requests premiere/Archive, receives only eligible media capabilities, and plays group film or downloads their own released clips.                                                  | Unpublished media has no playable URL; exhausted film is delayed. Session/group changes deny access. Missing/resized output is withheld; changed bytes fail streaming integrity. Invalid page cursor fails explicitly.         |

Persisted and derived states must stay distinct:

| Dimension           | Values / rule                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cycle `status`      | `collecting → revealing → archived`; successor is a separate collecting row. Lifecycle keeps `lock_state = locked`, including archived cycles.                       |
| Cycle release       | `unpublished → published`, with `release_published_at`; publication is separate from job readiness.                                                                  |
| Film job            | `pending → processing → ready` or `failed`; failed may retry below cap; stale processing may be reclaimed with a new generation. `ready` is terminal for processing. |
| Lifecycle action    | `waiting_for_boundary`, `revealing`, `waiting_for_release`, `premiere`, `archived`, `already_archived`; these are return values, not extra cycle statuses.           |
| Premiere HTTP view  | `locked`, `processing`, `delayed`, `ready`. Client `Premiere` also permits `failed`; the inspected server classifier does not emit it.                               |
| Archive eligibility | Published release plus ready output; the query does **not** wait for cycle status `archived`. Availability, current identity and capability checks apply separately. |

<a id="analysis-model"></a>

## Analysis model

<a id="a-c1"></a>

### A-C1 — Domain class model

These are analysis concepts, not proposed runtime classes. `Release` is publication metadata on a cycle; `Film` is the result of a compilation job.

```mermaid
classDiagram
  Group "1" --> "1..*" Cycle : owns
  Cycle "0..1" --> "0..1" Cycle : successor
  Cycle "1" --> "0..*" Contribution : accepts
  Member "1" --> "0..*" Contribution : authors
  Contribution "1" --> "0..1" ProcessedClip : becomes
  Cycle "1" --> "0..1" CompilationWork : schedules
  CompilationWork "1" *-- "0..*" OrderedInput : orders
  OrderedInput --> ProcessedClip : references
  CompilationWork "1" --> "0..1" Film : produces
  Cycle "1" *-- "1" Release : controls visibility
  Release --> Film : exposes when verified
  Cycle "1" --> "0..*" LifecycleReceipt : records
  Member --> Group : selects and belongs to
```

<a id="a-s1"></a>

### A-S1 — Advance and continue collecting (UC-01)

```mermaid
sequenceDiagram
  actor Clock
  participant Control as Lifecycle control
  participant Old as Ending cycle
  participant Work as Compilation work
  participant Group
  Clock->>Control: Evaluate cycle at current instant
  alt Before boundary
    Control-->>Clock: Still collecting
  else Boundary reached or closure replayed
    Control->>Old: Close collection if needed
    Control->>Work: Ensure one film work item
    Control->>Group: Ensure successor at old end, same duration/quota
    Control->>Group: Move current pointer only if still on old cycle
    Control-->>Clock: Old cycle revealing, successor collecting
  else Invalid cycle data
    Control-->>Clock: Reject without partial transition
  end
```

<a id="a-s2"></a>

### A-S2 — Recover work and generate film (UC-02, UC-03)

```mermaid
sequenceDiagram
  participant Worker as Compiler control
  participant Work as Durable compilation work
  participant Clips as Accepted processed clips
  participant Encoder
  Worker->>Work: Request ownership
  alt Accepted clips still settling
    Work-->>Worker: Wait without new attempt
  else Live owner, ready result, or exhausted failure
    Work-->>Worker: Busy, existing result, or delayed
  else New attempt or abandoned ownership
    Work-->>Worker: Claim with ownership version
    Worker->>Clips: Freeze/reconcile ordered retained identities
    Worker->>Clips: Verify all accepted inputs and bytes
    alt Inputs unavailable or empty
      Worker->>Work: Record owned failure, release remains sealed
    else Inputs usable
      Worker->>Encoder: Join normalized clips, label optional archive filler
      Encoder-->>Worker: Candidate film
      Worker->>Work: Verify output and commit if owner and inputs unchanged
      alt Ownership or inputs changed / encoding failed
        Worker->>Work: Reject candidate, clean own temporary output
      else Candidate accepted
        Work-->>Worker: Ready film, still unpublished
      end
    end
  end
```

<a id="a-s3"></a>

### A-S3 — Publish, premiere and archive (UC-04)

```mermaid
sequenceDiagram
  actor Clock
  participant Control as Release control
  participant Film
  participant Cycle
  Clock->>Control: Evaluate closed cycle
  Control->>Film: Verify committed output identity and bytes
  alt Not ready, corrupt, missing or too early
    Control-->>Clock: Keep release unavailable
  else Verified release can publish
    Control->>Cycle: Publish once, retain original publication time
    Clock->>Control: Evaluate again
    alt Before publication time plus 24 hours
      Control-->>Clock: Premiere remains active
    else Premiere elapsed
      Control->>Film: Verify output again
      alt Verification succeeds
        Control->>Cycle: Archive once, retain film
      else Verification fails
        Control-->>Clock: Wait for available verified release
      end
    end
  end
```

<a id="a-s4"></a>

### A-S4 — Reveal and Archive eligibility (UC-05)

```mermaid
sequenceDiagram
  actor Member
  participant Boundary as Reveal / Archive boundary
  participant Policy as Access and release policy
  participant Media as Retained media
  Member->>Boundary: Request premiere or Archive page
  Boundary->>Policy: Check session, selected membership and release
  alt Unauthorized or unpublished
    Boundary-->>Member: Denial or sealed state without media links
  else Published and ready
    Boundary->>Media: Check finalized output availability
    Boundary-->>Member: Ready film / own clips and short-lived access grants
    Member->>Boundary: Use grant
    Boundary->>Policy: Recheck grant, identity and exact output
    Boundary->>Media: Read verified bytes
    alt Expired grant, changed identity or bad bytes
      Boundary-->>Member: Refuse media
    else Still eligible
      Boundary-->>Member: Stream retained media
    end
  end
```

<a id="design-model-and-flow-mapping"></a>

## Design model and flow mapping

<a id="d-c1"></a>

### D-C1 — Actual module/type model (AFTER)

`functional_module` boxes group functions in files; they are not instantiated classes. `data_type` boxes represent TypeScript records. Only `MediaCapabilities` below is a runtime class. The database type abstracts the supplied connection; this diagram does not imply an ORM.

```mermaid
classDiagram
  class Scheduler {
    <<functional_module>>
    runCycleSchedulerTick()
    startCycleSchedulerLoop()
  }
  class Lifecycle {
    <<functional_module>>
    advanceCycleLifecycleWithStore()
    publishCycleReleaseWithStore()
    ensureSuccessor()
  }
  class Worker {
    <<functional_module>>
    listWorkerCandidates()
    runWorkerTick()
  }
  class Jobs {
    <<functional_module>>
    claimCompilationJob()
    processCompilationJobInternal()
    publishCompilationOutput()
    verifyReadyJobOutput()
  }
  class CompilationJobRecord {
    <<data_type>>
    status
    attemptCount
    claimGeneration
  }
  class Ffmpeg {
    <<functional_module>>
    compileFilmWithFfmpeg()
    probeClipWithFfmpeg()
  }
  class RewindDatabase {
    <<connection_type>>
    prepare()
    exec()
  }
  class MediaStore {
    <<interface>>
    put()
    head()
    read()
    delete()
  }
  class MediaObjectRef {
    <<data_type>>
    versionId
    sha256
    byteLength
  }
  class Http {
    <<functional_module>>
    premiereState()
    filterServableArchive()
    protectedAssetPath()
    openVerifiedServingFile()
  }
  class MediaCapabilities {
    issue()
    resolve()
  }
  Scheduler --> Lifecycle
  Scheduler --> Worker
  Lifecycle --> Jobs
  Lifecycle --> RewindDatabase
  Worker --> Jobs
  Jobs --> CompilationJobRecord
  Jobs --> RewindDatabase
  Jobs --> Ffmpeg
  Jobs --> MediaStore
  MediaStore --> MediaObjectRef
  Http --> RewindDatabase : getPremiereFilm / listReleasedArchive
  Http --> Jobs : servableJobOutput
  Http --> MediaCapabilities
```

<a id="d-s1"></a>

### D-S1 — Atomic rollover (UC-01)

```mermaid
sequenceDiagram
  participant S as scheduler.ts
  participant L as lifecycle.ts
  participant J as jobs/index.ts
  participant DB as RewindDatabase
  S->>L: advanceCycleLifecycleWithStore(groupId, cycleId, clock)
  L->>DB: BEGIN IMMEDIATE, read cycle and current pointer
  alt Collecting before endsAt
    L->>DB: COMMIT unchanged
  else Valid boundary or replay
    L->>DB: If collecting: revealing + locked + deduplicated receipt
    opt Cycle not archived
      L->>J: ensureCompilationJob() within same transaction
      J->>DB: Reuse or insert film job and ordered processed inputs
    end
    L->>DB: ensureSuccessor(), conditional current pointer update
    L->>DB: COMMIT cycle, job, successor, receipts together
  else Missing / invalid state or time
    L->>DB: ROLLBACK
  end
  L-->>S: Typed action/result
```

<a id="d-s2"></a>

### D-S2 — Durable claim and film generation (UC-02, UC-03; AFTER)

```mermaid
sequenceDiagram
  participant W as worker.ts
  participant J as jobs/index.ts
  participant DB as RewindDatabase
  participant IO as Disk / MediaStore
  participant F as ffmpeg.ts
  W->>J: processCompilationJobForWorker()
  J->>DB: claimCompilationJob(): writer transaction
  alt Accepted inputs waiting / live lease / ready / retry cap
    J-->>W: waiting_for_inputs / already_processing / ready / retry_exhausted
  else Claimable
    J->>DB: First settled claim freezes inputs, reconcile tombstones
    J->>DB: generation++, attempt++ only for pending/failed, COMMIT
    J->>IO: Resolve/materialize inputs, verify persisted digest and size
    J->>F: compileFilmWithFfmpeg(unique temp path), probeClipWithFfmpeg()
    J->>IO: Hash output, optionally put and verify pinned stored version
    J->>DB: publishCompilationOutput(): writer transaction
    alt Same generation, complete accepted inputs, exact ordered ids, same temp identity
      J->>IO: Rename local temp if disk path
      J->>DB: ready + output identity + integrity + progress 100, COMMIT
      J-->>W: Ready (publication still separate)
    else Failure or fence rejected
      J->>DB: ROLLBACK, markCompilationFailed() only for owned generation
      J->>IO: Remove own partial output / unpublished stored version
      J-->>W: Failed, delayed at attempt cap
    end
  end
```

Input verification/FFmpeg failures also enter the owned-failure cleanup path. Stale reclaim increments generation but keeps attempt count. `updateCompilationJobProgress()` provides a generation-fenced, monotonic heartbeat API; the inspected film processor does not run a periodic heartbeat timer. A long-running claim can therefore be reclaimed; finalization fences remain essential.

<a id="d-s3"></a>

### D-S3 — Store-aware release and archival (UC-04)

```mermaid
sequenceDiagram
  participant S as runCycleSchedulerTick
  participant L as lifecycle.ts
  participant J as verifyReadyJobOutput
  participant IO as Disk / MediaStore
  participant DB as RewindDatabase
  S->>L: advanceCycleLifecycleWithStore()
  Note over S,L: Then try publication if revealing and unpublished
  S->>L: publishCycleReleaseWithStore()
  L->>J: Verify ready row and exact output before writer lock
  J->>IO: Hash disk bytes or verify pinned stored version
  J->>DB: Recheck persisted identity after read
  alt No verified proof
    L-->>S: not_ready
  else Proof available
    L->>DB: BEGIN IMMEDIATE, compare proof with current output row
    L->>DB: Require revealing, at/after endsAt, publish once or retain timestamp
    L->>DB: COMMIT (otherwise rollback with typed reason)
  end
  S->>L: Later advanceCycleLifecycleWithStore()
  alt Premiere not elapsed
    L-->>S: premiere (if published and ready metadata)
  else Publication plus 24 hours elapsed
    L->>J: Verify output outside transaction again
    L->>DB: Writer fence rechecks proof, archive + unique receipt
    L-->>S: archived or waiting_for_release
  end
```

The first closing tick attempts publication before running its worker. Newly compiled output is normally published on a later tick. Scans are bounded (default 16, maximum 100), cursor-based, and interleave one claimed media job through round-robin real groups. Correctness comes from persisted transitions/claims, not the in-memory cursor. The CLI starts/stops the scheduler with the runtime.

<a id="d-s4"></a>

### D-S4 — Read and serve eligible media (UC-05)

```mermaid
sequenceDiagram
  participant UI as ArchiveScreen / FilmScreen
  participant H as http.ts
  participant DB as db.ts queries
  participant C as MediaCapabilities
  participant IO as Verified serving file
  UI->>H: GET premiere or /archive with groupId
  H->>H: requireAuthorisedMediaGroup()
  H->>DB: getPremiereFilm() / listReleasedArchive()
  H->>H: premiereState(), servableOutput() / filterServableArchive()
  H->>H: mediaIdentityIsCurrent() and premiere row recheck
  alt Sealed, delayed, unauthorized or unavailable
    H-->>UI: State without playable URL, filtered entries, or denial
  else Eligible
    H->>C: issue() via protectedAssetPath()
    H-->>UI: Safe metadata and /media/access token paths
    UI->>H: GET /media/access/token
    H->>C: resolve(): session, selection, release and exact output checks
    H->>IO: openVerifiedServingFile(): pinned snapshot + integrity
    alt Invalid capability / changed or unavailable output
      H-->>UI: Refuse stream
    else Verified
      H-->>UI: Stream MP4
    end
  end
```

Listing checks finalized metadata and existence/size, not a full hash per item. Streaming and release perform byte verification. Archive returns published ready films and the requesting member's ready clips; HTTP strips storage paths and issues capabilities. `MediaCapabilities` grants last two minutes and are process-local; restart requires reacquisition. `getRealGroup()`'s release summaries are display metadata: unpublished failed jobs are `delayed` there even before the premiere endpoint's three-attempt threshold. They are not media authorization.

<a id="traceability"></a>

### Traceability — use cases to implementation and existing tests

Line anchors identify symbols at the inspected revision. Test links identify existing coverage to consult; **none of these tests was run for this document**.

| UC    | Analysis → design diagrams                                  | Exact relative source / symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Existing relevant tests                                                                                                                                                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-01 | [A-C1](#a-c1), [A-S1](#a-s1) → [D-C1](#d-c1), [D-S1](#d-s1) | [lifecycle.ts: `advanceCycleLifecycle`](../../server/src/cycles/lifecycle.ts#L419), [`advanceCycleLifecycleWithStore`](../../server/src/cycles/lifecycle.ts#L435), [`ensureSuccessor`](../../server/src/cycles/lifecycle.ts#L276); [scheduler.ts: `runCycleSchedulerTick`](../../server/src/cycles/scheduler.ts#L45); [engine.ts: `cyclePhase`](../../server/src/cycles/engine.ts#L65), [`advanceCycleWindow`](../../server/src/cycles/engine.ts#L80)                                         | [cycles: closure, legacy repair, concurrent lifecycle](../../server/tests/cycles.test.mjs#L91); [scheduler: absent clients](../../server/tests/cycle-scheduler.test.mjs#L102)                                                                                                                                                                           |
| UC-02 | [A-C1](#a-c1), [A-S2](#a-s2) → [D-C1](#d-c1), [D-S2](#d-s2) | [jobs/index.ts: `claimCompilationJob`](../../server/src/jobs/index.ts#L599), [`updateCompilationJobProgress`](../../server/src/jobs/index.ts#L674); [worker.ts: `listWorkerCandidates`](../../server/src/jobs/worker.ts#L153), [`runWorkerTick`](../../server/src/jobs/worker.ts#L266)                                                                                                                                                                                                        | [compilation-jobs: restart and progress](../../server/tests/compilation-jobs.test.mjs#L119); [durable-worker: terminal film](../../server/tests/durable-worker.test.mjs#L402), [stale film generation](../../server/tests/durable-worker.test.mjs#L436); [private-media-jobs: wait across restart](../../server/tests/private-media-jobs.test.mjs#L310) |
| UC-03 | [A-C1](#a-c1), [A-S2](#a-s2) → [D-C1](#d-c1), [D-S2](#d-s2) | [jobs/index.ts: `processCompilationJobInternal`](../../server/src/jobs/index.ts#L980), [`publishCompilationOutput`](../../server/src/jobs/index.ts#L899), [`eligibleCompilationInputs`](../../server/src/jobs/index.ts#L380); [ffmpeg.ts: `compileFilmWithFfmpeg`](../../server/src/ffmpeg.ts#L469)                                                                                                                                                                                           | [film-compilation: order/audio](../../server/tests/film-compilation.test.mjs#L249), [archive filler](../../server/tests/film-compilation.test.mjs#L434), [partial failure](../../server/tests/film-compilation.test.mjs#L531); [private-media-jobs: missing/exhausted/corrupt accepted inputs](../../server/tests/private-media-jobs.test.mjs#L358)     |
| UC-04 | [A-C1](#a-c1), [A-S3](#a-s3) → [D-C1](#d-c1), [D-S3](#d-s3) | [lifecycle.ts: `publishCycleReleaseWithStore`](../../server/src/cycles/lifecycle.ts#L426), [`advanceCycleLifecycleWithStore`](../../server/src/cycles/lifecycle.ts#L435), [`hasReadyCompilationOutput`](../../server/src/cycles/lifecycle.ts#L175); [jobs/index.ts: `verifyReadyJobOutput`](../../server/src/jobs/index.ts#L1934); [cli.ts: `startCycleSchedulerLoop` call](../../server/src/cycles/scheduler.ts#L113)                                                                        | [cycles: 24-hour publication clock](../../server/tests/cycles.test.mjs#L91), [invalid output](../../server/tests/cycles.test.mjs#L174); [real-archive: pinned publication](../../server/tests/real-archive.test.mjs#L325), [changed during read](../../server/tests/real-archive.test.mjs#L395)                                                         |
| UC-05 | [A-C1](#a-c1), [A-S4](#a-s4) → [D-C1](#d-c1), [D-S4](#d-s4) | [db.ts: `listReleasedArchive`](../../server/src/db.ts#L651), [`getPremiereFilm`](../../server/src/db.ts#L749); [media-access.ts: `premiereState`](../../server/src/routes/media-access.ts#L162), [`filterServableArchive`](../../server/src/routes/media-access.ts#L300); [capabilities.ts: `MediaCapabilities.resolve`](../../server/src/archive/capabilities.ts#L43); [Archive.tsx: `ArchiveScreen`](../../src/real/Archive.tsx#L18); [Film.tsx: `FilmScreen`](../../src/real/Film.tsx#L53) | [real-archive: release and selected membership](../../server/tests/real-archive.test.mjs#L196), [expiry/corruption](../../server/tests/real-archive.test.mjs#L281); [film-screen: per-viewer segments](../../tests/film-screen.test.tsx#L59)                                                                                                            |

<a id="design-problem-and-alternatives"></a>

## Design problem and alternatives

**Problem:** rollover must enable new collection even when encoding fails or a process dies. Duplicate runtimes and replay must not create multiple successors/jobs, publish an obsolete worker's output, or expose a partial film. Database transactions cannot roll back FFmpeg or object-store side effects.

<a id="b-c1"></a>

### B-C1 — BEFORE: conceptual rejected baseline

This is an illustrative alternative, **not historical implemented architecture**. The fictional classes deliberately collapse lifecycle and compilation into one synchronous request.

```mermaid
classDiagram
  class RequestLifecycle {
    closeCompilePublishAndRollOver()
  }
  class Encoder {
    encodeToSharedFinalPath()
  }
  class MutableCycle {
    status
    filmPath
  }
  RequestLifecycle --> Encoder
  RequestLifecycle --> MutableCycle
```

<a id="b-s1"></a>

### B-S1 — BEFORE: conceptual failure sequence

```mermaid
sequenceDiagram
  actor Client
  participant R as Fictional RequestLifecycle
  participant E as Fictional Encoder
  participant C as Fictional MutableCycle
  Client->>R: End cycle
  R->>E: Encode directly to shared final path
  E-->>R: Bytes written
  Note over R: Process dies before recording success / next cycle
  Client->>R: Retry after restart
  R->>E: Encode again to same path (no durable ownership)
  R->>C: Publish path and create successor
  Note over C: Duplicate/partial output risk, rollover depends on encoding
```

| Candidate                                                                             | Assessment                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request-bound synchronous compiler + process mutex                                    | Simple locally; loses ownership on restart and coordinates neither multiple processes nor storage side effects. Rejected baseline above.                                                                                 |
| External broker + distributed workflow/saga                                           | Could scale work and express compensation, but adds broker/coordination operations. Not required by the inspected local durable runtime; not claimed as implemented.                                                     |
| **Chosen: transactional rollover + database-backed work + fenced output publication** | Actual [D-C1 AFTER](#d-c1), [D-S1](#d-s1), [D-S2 AFTER](#d-s2), [D-S3](#d-s3). Durable identity prevents duplicate work items; leases permit recovery; generations exclude stale writers; integrity proof gates release. |

This is a durable work-queue / transaction-boundary architecture with optimistic generation checks around expensive work. Lifecycle receipts are deduplicated records, **not an event bus or transactional outbox dispatcher**. `MediaStore` supplies dependency inversion and interchangeable storage implementations; no GoF pattern is needed to explain the lifecycle. String unions and conditional transition functions do **not** implement GoF State: there are no polymorphic state objects receiving delegated behavior.

<a id="transition-and-implementation-choices"></a>

## Transition and implementation choices

- **Boundary/control/entity decomposition:** analysis reveal/Archive boundaries map to HTTP handlers and `ArchiveScreen`/`FilmScreen`; lifecycle and compiler controls map to functional modules; cycles/contributions/work map to persisted rows and read types. Entity behavior is expressed by functions, rather than invented entity classes.
- **Persistence identity mapping:** `Group.currentCycleIdentity` becomes `groups.current_cycle_id`; successor identity becomes `cycles.previous_cycle_id` with a unique partial index. [Migration 009](../../server/migrations/sqlite-baseline.sql) gives unique `(cycle_id, transition)` receipts. [`compilationJobId`](../../server/src/jobs/index.ts#L213) deterministically hashes group/cycle; [`applyCompilationJobsMigration`](../../server/src/db.ts#L1204) also enforces one film per cycle. Ordered inputs persist clip/contribution identities and position, not raw source paths.
- **Refine analysis ownership into concurrency controls:** writer transactions serialize state changes; `claim_generation` is a fencing token; `processing_started_at` is a renewable 15-minute lease. Pending/failed claims increment attempts; stale processing recovery does not. The default film cap is three; clip worker retry policy is distinct and allows request retries after automatic exhaustion.
- **Extract storage/encoding interfaces:** compiler functions receive FFmpeg binary/options and optional `MediaStore`/environment. [MediaStore and MediaObjectRef](../../server/src/media/store.ts#L1) carry explicit group/environment/version/integrity identity. Disk runs use processed paths; hosted storage uses pinned S3 refs. The retained `local` object-store adapter is not a recommendation to extend that backend.
- **Separate slow work from commit:** input materialization, FFmpeg, probing, hashing and stored verification happen outside short writer transactions. Local publication checks temp-file identity and renames while holding its fence; stored publication commits an encoded version reference. These protect durable visibility, not exactly-once execution of FFmpeg or a distributed database/storage transaction.
- **Preserve acceptance completeness:** initial job creation snapshots currently ready clips; processing waits for accepted inputs to settle and freezes the complete selection on the first claim. Reconciliation removes invalid/tombstoned references; completeness checks prevent silently omitting a retained accepted contribution. No accepted usable inputs means failure, not an empty published release.
- **Map domain ordering into media processing:** current inputs sort by contribution creation/id and clip id. Exactly one current clip may append one latest eligible archived clip from the same group; absent filler does not force failure. FFmpeg visibly labels filler, letterboxes into 720×1280, normalizes audio and emits H.264/AAC MP4 at 30 fps; probing precedes ready publication.
- **Keep timing separate from visibility:** successor starts at the old boundary and copies duration/prompt/quota, resetting usage. `advanceCycleWindow()` shifts a window for controlled clock advancement; it is not the persistent rollover routine. A late scheduler may require further passes to catch up. Premiere duration uses publication time, while Archive query visibility begins with publication immediately.
- **Tradeoffs and limits:** serial scheduler passes can be delayed by a long FFmpeg job; bounded scans are not a throughput guarantee. Stale leases can cause overlapping computations, but only the current generation may finalize. Cleanup is best effort for some unpublished stored objects; a crash between storage writes and database commit can leave unreferenced bytes. Published metadata does not guarantee continuing availability: serving must recheck bytes and identity.

<a id="sources-and-limits"></a>

## Sources and limits

The [traceability table](#traceability) is the primary source index. Additional read models: [Cycle / CycleStatus](../../src/domain/cycles.ts#L1), [Premiere / FilmSegment](../../src/domain/premiere.ts#L1), [getRealGroup release summaries](../../server/src/groups/real.ts#L128), and [servableJobOutput](../../server/src/jobs/index.ts#L1904). Lifecycle's internal `StoredCycle` includes release/successor metadata absent from the client `Cycle` interface. Legacy reveal education helpers do not replace server publication/access gates.

Inspection used only current source/tests and the root working agreement plus shipping skill. The supplied issue brief defines this document's scope; no GitHub operation was performed. No application code, schema or runtime behavior was changed. Test names/assertions were inspected as references; no application tests, server, FFmpeg execution, deployment or device verification was run. Static documentation checks are reported separately by the authoring agent.

The model explains the inspected local SQL transaction/worker paths and store-aware release APIs. It does not establish production performance, multi-host database equivalence, recovery from every possible crash point, or a guarantee that a ready/published asset cannot later disappear. Sequence diagrams omit audit/logging and low-level transport details except where they affect eligibility or durable ownership. Revalidate source anchors and state guards when implementation changes.
