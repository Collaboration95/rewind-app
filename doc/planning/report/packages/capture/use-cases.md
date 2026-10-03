# Capture and contribution use cases

**Evidence cut:** accepted dev commit [`fc2b8c811e9c13b176113fa0bdb2c015798990b4`](https://github.com/Collaboration95/rewind-app/commit/fc2b8c811e9c13b176113fa0bdb2c015798990b4). These are modeled flows from source inspection, not product acceptance results.

## Scope and actors

The primary actor is an authenticated group member. The capture surface is used through a browser or native adapter; local Demo fixtures are a separate development path and do not prove hardware capture. The real-account photo/video flows choose their transfer route from `GET /real/media/config?uploadProtocol=2`: direct upload intent when configured, authenticated staged-source intake otherwise. Both paths converge on server contribution validation, quota/job creation, and post-upload FFmpeg processing.

The three use cases are:

- **UC04:** record, review, trim, choose a current mode, and submit video.
- **UC05:** capture/review and submit one photo contribution.
- **UC06:** read and enforce allowance; allow one eligible delete-and-replace correction.

## UC04 — Record, review, trim and submit video

**Goal:** capture a short portrait MP4 with audio, review and trim it, select an implemented mode, and submit it for processing.

**Preconditions:** a member is signed in and has selected a group in a collecting cycle. Video capture also requires an available camera and microphone and applicable browser/device permission.

### UC04-F1 — Acquire access and record

**Normal flow:** the screen checks video capability and permission. The member grants access and starts recording. The platform boundary starts browser or native capture while the preview remains visible. Elapsed time is bounded at 15 seconds. Stop stores an owned clip and enters review; cancel or route exit releases the active capture.

**Relevant exceptions:** denied permission offers recovery/Settings guidance; unavailable or unsupported live capture may offer the labelled video-file fallback; permission lookup, recorder, camera, or file-write failure does not create a review clip. Backgrounding interrupts an active recording and releases its live capture. A late completion after cancellation is discarded by operation ownership.

### UC04-F2 — Review, trim, choose mode or retake

**Normal flow:** the locally owned clip is mounted in the review player. The member plays, pauses and seeks within the trim bounds, selects valid trim bounds (at least 0.5 seconds and no more than the clip), chooses `soft-focus` or `high-contrast`, then submits or retakes. Retake cancels active work as applicable, unmounts the player before file deletion, clears review and pending-upload state, and returns to capture.

**Relevant exceptions:** invalid/out-of-range/too-short trim stays in review with an explanation; landscape/non-MP4/no-audio or over-limit metadata is rejected before submission; player failure permits recovery/retake; if file cleanup fails, the owned clip is retained and an error is shown. A backgrounded in-flight upload is cancelled and the local capture is retained only when the upload session permits retry.

### UC04-F3 — Transfer, accept and process video

**Normal flow:** the client persists pending review metadata, reads the managed clip, and builds a keyed submission with media facts, trim, mode and optional replacement target. In configured direct mode it requests an upload intent, persists a checkpoint, PUTs bytes to the private storage capability without app credentials, captures the exact storage version, and completes the intent. In server mode it POSTs bytes to the authenticated `/contributions/upload/source` endpoint and posts the staged reference and metadata to `/contributions/upload`. The server validates authority, active cycle, source/media facts and allowance, creates one contribution and pending job idempotently, then processes the job with FFmpeg. Success refreshes contribution status and disposes local review media.

**Relevant exceptions:** lost network response checks/reconciles intent status and exact object version before retrying; it does not assume an unconfirmed PUT succeeded. Expired capability, unknown/conflicting version, unauthorized member/group, closed cycle, invalid metadata/source, quota exhaustion or invalid replacement fails safely. The staged path rejects unavailable/mismatched source, conflicting idempotency key and quota failure. Processing conflict checks job status; processing/media failure reports retry state. Cancel applies only while the owned job remains cancellable; local review bytes remain available for a permitted retry. Successful server acceptance followed by local cleanup failure is surfaced as cleanup trouble, not rolled back server acceptance.

## UC05 — Contribute a photo

**Goal:** capture or select a still, review it, and submit one photo as a three-second contribution.

**Preconditions:** signed-in member, selected collecting group, and available still capture permission; explicit file selection is a fallback where provided.

### UC05-F1 — Capture and review a photo

**Normal flow:** the screen checks camera capability and permission. The platform produces a still; the session validates and copies it to app-managed storage, persists metadata without the preview URI, and exposes an active preview. The member may submit, retake, or discard. A retake/discard removes the managed preview and associated metadata.

**Relevant exceptions:** denied/blocked permission offers recovery; unsupported live camera can use the labelled file fallback where available. Camera, copy, file-store, or metadata-store failure never becomes a ready preview. An asynchronous capture that completes after route interruption is discarded only if it still belongs to that operation. Backgrounding abandons an in-flight capture and discards its preview; a pending submitted photo is retained for retry.

### UC05-F2 — Transfer, accept and process photo

**Normal flow:** the client validates JPEG/PNG bytes, dimensions and a maximum 10 MiB source; it submits `mediaType=photo`, fixed three-second duration, mode and optional replacement ID through the configured direct upload-intent or authenticated staged-source route. The server rechecks the image and current allowance, accepts one contribution/job idempotently, and creates the standard three-second processed clip. The client reports queued/processing/ready and refreshes its self-scoped ledger. It removes local preview content after confirmed completion.

**Relevant exceptions:** missing/corrupt file, unsupported type, excessive size or invalid dimensions is rejected; server probe can reject bytes that passed client checks. Authorization, closed-cycle, quota, expired intent/version, idempotency, or replacement conflict does not count as a successful replacement. Network or processing failure keeps retry state and local media when available. Cleanup failure is reported independently from the accepted contribution.

## UC06 — Enforce allowance and one correction

**Goal:** enforce each member's contribution limits in an active cycle and permit at most one eligible delete-and-replace correction in the same seven-day window.

**Preconditions:** the request is scoped to an authorized account/member, group and collecting cycle. The ledger returns the member's own entries and allowance metadata; it does not reveal other members' unreleased media.

### UC06-F1 — Read allowance and reserve a contribution

**Normal flow:** the client reads the self-scoped ledger for status/allowance. On submit, the server derives a seven-day window from cycle start, applies limits of five items, 30 seconds and at most 15 seconds per video, then reserves allowance and creates contribution/job state in the acceptance transaction. A photo consumes one item and three seconds. An accepted identical idempotency key resolves to the existing intent/upload rather than charging twice. The queued job is processed after acceptance.

**Relevant exceptions:** malformed media/duration, missing or non-collecting cycle, invalid/stale source or object version, exhausted item/time allowance, reused key with different intent, or database/storage conflict rejects or rolls back the new contribution. Intent expiry and ineligible storage state are handled as intent errors; staged-source mismatch is rejected. Quota denial is a business result, not an offline retry.

### UC06-F2 — Delete and replace once

**Normal flow:** the member selects their own eligible contribution while its cycle is collecting and the contribution remains in its original seven-day quota window. The server writer transaction checks job state (pending, failed or ready; not processing), confirms the per-window deletion allowance remains unused, tombstones the item, restores its count/seconds, and clears its media references. The next submission carries that deleted contribution ID; acceptance links the replacement to the tombstone in the same server transaction that creates the new job.

**Relevant exceptions:** another member's ID, different group, missing/closed cycle, prior deletion, used correction, processing/ineligible job, old quota window, or existing replacement is rejected. A replacement acceptance race rolls back its new contribution/job. A failed replacement may be retried against the same target/key according to the upload path; it does not restore a second correction. Disk cleanup after the committed tombstone is bounded to configured server-owned roots and is idempotent.

## Flow-to-sequence inventory

Every major flow below has its own analysis and design sequence in [models.md](models.md). Exception panels in each sequence name the relevant alternate paths.

| Flow | Normal path | Relevant alternate/error paths | Sequence pair |
| --- | --- | --- | --- |
| UC04-F1 | Permission, preview, record, stop to review | Denied/unsupported/file fallback, recorder/write failure, cancel/background/late completion | [analysis](diagrams/uc04-f1-analysis-sequence.svg) · [design](diagrams/uc04-f1-design-sequence.svg) |
| UC04-F2 | Playback, trim/mode save, submit or retake | Invalid trim/media, playback error, cleanup failure, upload interruption/retry | [analysis](diagrams/uc04-f2-analysis-sequence.svg) · [design](diagrams/uc04-f2-design-sequence.svg) |
| UC04-F3 | Direct capability PUT/completion or staged intake, accept, FFmpeg | Reconcile/version errors, authorization/cycle/quota/source/idempotency rejection, processing failure/cancel | [analysis](diagrams/uc04-f3-analysis-sequence.svg) · [design](diagrams/uc04-f3-design-sequence.svg) |
| UC05-F1 | Permission, capture, managed preview, submit/retake | Permission/file fallback, stale operation, file/metadata failure, background/discard | [analysis](diagrams/uc05-f1-analysis-sequence.svg) · [design](diagrams/uc05-f1-design-sequence.svg) |
| UC05-F2 | Validate, transfer, three-second job, process and confirm | Invalid image, intent/staged upload failure, quota/auth/replacement failure, process/cleanup retry | [analysis](diagrams/uc05-f2-analysis-sequence.svg) · [design](diagrams/uc05-f2-design-sequence.svg) |
| UC06-F1 | Read own allowance; atomically reserve once; process | Limit/window/media/source failures, idempotent replay/conflict, transaction rollback | [analysis](diagrams/uc06-f1-analysis-sequence.svg) · [design](diagrams/uc06-f1-design-sequence.svg) |
| UC06-F2 | Eligible delete, restore quota, linked replacement | Wrong owner/group/window, closed/processing/used, replacement race/rollback | [analysis](diagrams/uc06-f2-analysis-sequence.svg) · [design](diagrams/uc06-f2-design-sequence.svg) |

## Requirement and source crosswalk

The bounded summaries below map the identifiers listed by issue #358. The issue itself is the source for the required ID set. Exact proposal wording is outside this source package; the summaries are a trace aid, not a canonical rewrite.

| Requirement | Flow mapping | Code evidence at pinned commit | Boundary |
| --- | --- | --- | --- |
| R04 | UC04-F1 capture; UC04-F2 review/trim; UC04-F3 submit/process | [VideoCaptureScreen lifecycle](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/VideoCaptureScreen.tsx#L562), [review session](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/video-review.ts#L34), [platform boundary](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/contracts.ts#L76) | Source model only; no device acceptance claim. |
| R05 | UC04-F2 mode selection; UC04-F3/UC05-F2 server processing | [two accepted modes](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/ffmpeg.ts#L11), [mode filter and post-upload clip processing](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/ffmpeg.ts#L206) | Current processing is after source acceptance. Four pre-upload original treatments remain future work: [#365](https://github.com/Collaboration95/rewind-app/issues/365)–[#367](https://github.com/Collaboration95/rewind-app/issues/367). |
| R06 | UC05-F1 capture/review; UC05-F2 submit/process | [still session](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/still-image-session.ts#L48), [real photo submit](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/groups/RealAccountGroupExperience.tsx#L514), [photo processing](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/ffmpeg.ts#L302) | Code walkthrough only; no hosted-phone acceptance. |
| R07 | UC06-F1 allowance; UC06-F2 one correction | [quota window/reservation](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/contributions/index.ts#L77), [atomic deletion](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/contributions/index.ts#L240), [replacement link](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/contributions/ledger.ts#L575) | No fresh quota concurrency tests run. |
| R16 | UC04-F3/UC05-F2 configured direct and staged paths | [runtime mode routing](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/real-account-video-runtime.ts#L46), [resumable client](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/direct-transfer.ts#L337), [intent API](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/media/upload-intents.ts#L386), [private media store boundary](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/media/store.ts#L45) | Direct mode depends on server configuration and provider availability; this package does not claim a live upload. |
| R22 | All UC04–UC06 report models | This package is a source-pinned report input, linked to #358. | No final report assembly, named contribution, hours or approval is inferred. |

## Source and design links

- Platform variations: [ADR-0002 Camera Capture Boundary](../../../../../docs/architecture/ADR-0002-camera-capture-boundary.md) (repository-local design context); implementation [CameraPlatform contract](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/contracts.ts#L101), [web/native adapters](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/platform.ts#L340).
- Transfer selection: [real-group configuration fetch](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/groups/RealAccountGroupExperience.tsx#L360), [direct/server runtime routing](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/real-account-video-runtime.ts#L67).
- Media and privacy vocabulary: [media domain contract](../../../../../docs/domain/media-contract.md).
- Source processor: [FFmpeg contracts and transformations](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/ffmpeg.ts#L11).

See [analysis/design classes and sequence models](models.md) and the [pattern comparison](design-problem.md).
