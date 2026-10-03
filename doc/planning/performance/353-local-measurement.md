# #353 bounded local measurement

This runner measures synthetic local API and film compilation performance on
existing application adapters. It does not establish hosted, device, provider,
or final database performance. The #267 research document remains unchanged.

## Reproduce

Use Node >=22.13.0, the locked project dependencies, and local FFmpeg/FFprobe
with libx264 and AAC. From the repository root:

```sh
npm run server:build
node --test scripts/measure-real-group-performance.test.mjs
node scripts/measure-real-group-performance.mjs
npm run test:fast
```

The focused runner tests are explicitly invoked: the existing package scripts
do not discover this new scripts test automatically. No package scripts change.
The runner accepts no arguments, URLs, cloud credentials, or external data. It
ignores inherited REWIND configuration, freezes the server clock at each
fixture's construction instant, binds only to an OS-assigned loopback
port, and creates a new temporary SQLite/media directory per repetition. It
removes each fixture's data and closes its listener in a finally block. Only a
mode-0600 JSON report remains in the runner's temporary output root. It contains
raw measured samples and fixture checksums, without session tokens, passwords,
message bodies, or response bodies. Requests time out after 10 seconds; FFmpeg
commands time out after 120 seconds. Any error stops the workload and exits 1;
target misses also exit 1. Interrupted/killed runs may need their own temporary
output directory removed; never clean another runner's data or processes.

## Declared protocol and measurement boundaries

Each of three repetitions provisions five synthetic real-password accounts and
an outsider through existing auth/group/invite interfaces. The fixture seeds
100 synthetic chat messages and 25 newly generated, already-processed clips,
with five clips/30 seconds and a full weekly budget for each member. Seeding
contributions/ready jobs/quota rows directly is a fixture boundary: upload,
retro preprocessing, and quota reservation are not benchmarked. There is no
fake encoder in the measured compilation path.

API: 30-second paced warm-up (five concurrent requests per batch with a 100ms
pause), followed by 80 closed-loop five-request batches. Each repetition has
100 measured samples per operation, 400 overall. Group GET, owner prompt POST,
member budget/ledger GET, and chat history GET occur in an equal mix. Prompt
updates use the owner's authority; the other operations rotate member tokens.
Report p50/p95/max and errors separately by operation and repetition, using
nearest-rank percentiles. Warm-up, account provisioning/sign-in, fixture
construction and media bytes are excluded. The external request timer spans
fetch through complete JSON consumption; the load generator and HTTP server
share one Node process. It is not a separate-host network measurement or an
open-loop throughput/SLA claim.

Film: each repetition creates 25 distinct six-second H.264/AAC portrait clips
(150 seconds nominal total), with 720x1280 sources at alternating 24/30fps, 44.1/48kHz audio, varying sine frequencies and source volumes. Every
file is generated and probed; hashes and metadata are retained. Reverse row
insertion and misleading job creation timestamps exercise accepted-time order.
The existing durable job is created and immediately dispatched through the
worker adapter, with one compilation at a time. Queue wait spans the cycle
transition/job creation to successful worker claim; worker time spans claim to
ready return; end-to-end spans transition to ready return. Durable enqueue,
claim and ready timestamps accompany monotonic elapsed times. Queue wait
excludes a hosted scheduler's polling interval and prior queued jobs. Source
construction and output verification are outside the compilation timer.

Every film must be ready with all 25 inputs, decode both video/audio fully,
have approximately 150 seconds of output, show the expected chronological
color at all 25 segment positions, and measure integrated loudness between
-18 and -14 LUFS around the production -16 LUFS target. This verifies decoded
synthetic source audio; it is not a human listening or mobile playback result.
Non-media p95 must be <=2 seconds for every operation in every repetition;
every transition-to-ready film must be <=10 minutes.

Before measurements, outsider group/budget/chat access and owner-only prompt
mutation are denied; sealed own-clip download is unavailable. These are local
HTTP privacy assertions, separate from the broader regression suite below.

## Correctness and remaining acceptance

Run the existing film, private-media job, integrity, processing, and real-account
privacy suites for failure/retry/filler evidence. Their fixtures replace external
storage boundaries where applicable. They retain real media encoding and
processing, including an actual write-then-fail FFmpeg wrapper in the film
failure test. These correctness tests are not included in benchmark timings.

Review, integration into dev, exact-head aggregate Quality, the prerequisites'
remaining acceptance, hosted resource/configuration performance, scheduler
queue delay, representative captured media and supported-client playback remain
lead-owned gates. Repeat against the final PostgreSQL/identity/storage setup
when that reserved work lands. No optimization or instrumentation change is
justified unless a measured target miss identifies a concrete bottleneck.

## Observed result — 3 October 2026, 720p inputs

Runner measurement: **exit 0**, 16:09:22–16:11:24 SGT. Three independent
repetitions passed with **25 newly generated 720x1280 clips at alternating
24/30fps, six seconds each**, five members and 150 seconds input per film.
API protocol remains unchanged: five concurrent clients, 30-second warm-up,
100 measured samples per operation per repetition, 1,200 measured requests.
Audio still varies frequency, volume and 44.1/48kHz sampling. All inputs are
synthetic solid-color/audio-tone fixtures, not captured camera footage.

**Output limitation:** the unchanged production film compiler scales/pads to
**180x320**, then encodes H.264/AAC. FFprobe measured nominal **24/1 fps** and
average **168000000/6264977 fps (26.816)** for this mixed-rate fixture. The
photo-to-clip path explicitly uses 12fps; the film compiler does not set a
12fps filter or encoder rate. No production profile was altered. This run
exercises realistic input dimensions and decode/downscale, while retaining
low-complexity synthetic content and a low-resolution film. It does **not**
establish 720p final client-retro/media acceptance, camera bitrate/entropy,
real-device playback or hosted performance.

Previous 180x320/12fps and 360x640/24fps input results are superseded for the
submitted 25-clip target. They are not headline acceptance evidence.

| Run | Operation | Samples | Errors | p50 ms | p95 ms | Max ms |
| --- | --------- | ------: | -----: | -----: | -----: | -----: |
| 1   | group     |     100 |      0 |  3.136 |  4.804 | 11.334 |
| 1   | prompt    |     100 |      0 |  3.300 |  5.105 | 11.681 |
| 1   | budget    |     100 |      0 |  3.134 |  4.820 |  6.264 |
| 1   | chat      |     100 |      0 |  3.226 |  4.864 | 11.275 |
| 2   | group     |     100 |      0 |  3.229 |  5.571 | 10.141 |
| 2   | prompt    |     100 |      0 |  3.414 |  5.659 | 10.426 |
| 2   | budget    |     100 |      0 |  3.227 |  5.477 |  9.998 |
| 2   | chat      |     100 |      0 |  3.321 |  5.405 | 10.103 |
| 3   | group     |     100 |      0 |  3.020 |  4.977 |  8.575 |
| 3   | prompt    |     100 |      0 |  3.192 |  5.298 |  8.993 |
| 3   | budget    |     100 |      0 |  3.016 |  4.898 |  8.153 |
| 3   | chat      |     100 |      0 |  3.128 |  4.870 |  8.335 |

| Run | Warm-up seconds | Warm-up requests | Queue ms | Worker seconds | End-to-end seconds | Output seconds |  LUFS |
| --- | --------------: | ---------------: | -------: | -------------: | -----------------: | -------------: | ----: |
| 1   |          30.036 |             1360 |    2.905 |          4.563 |              4.566 |          150.4 | -17.4 |
| 2   |          30.087 |             1360 |    1.936 |          4.525 |              4.527 |          150.4 | -17.4 |
| 3   |          30.036 |             1355 |    0.957 |          4.733 |              4.734 |          150.4 | -17.4 |

All films completed 25/25 inputs in one attempt, decoded video/audio fully,
passed all 25 chronological frame positions and measured -17.4 LUFS. All
three repetitions denied outsider group (404), budget (403), chat (403),
prompt mutation (403), non-owner prompt mutation (403) and the actual seeded
clip owner's sealed download (404). Input dimensions and nominal frame rates
are now asserted, independently probed and retained for every clip; output
dimensions are asserted and its actual frame rates are retained.

### Host, build and exact configuration

- Host: Apple M5, 10 logical CPUs, arm64, Darwin 25.6.0, 32 GiB RAM.
- Initial free memory: 401096704 bytes; load averages: [1.63232421875, 2.48046875, 3.18212890625].
- Lead continues independent infrastructure work; other local activity can
  affect resources. No benchmark claims an otherwise idle host. Broad local
  suites and braces diagnostics ran after the media measurement.
- Runtime: `/opt/homebrew/bin/node`, **v26.3.1**, V8 **14.6.202.34-node.20**;
  npm **11.16.0**. NODE_OPTIONS was unset during diagnosis. Node 22 was not
  used or verified; the usual node@22 path was unavailable per lead context.
- Encoder: ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers.
- Application base: `445b56424ad89ff549529dab5729074da3fe0c75`.
- Checkout HEAD during the new measurement: `44c6a9a8227833ee22bf7a04e91ddb6db2ed7d19`
  plus the uncommitted 720p runner/tests patch. Production sources unchanged.
- Measured runner SHA-256: `3184457245fe448c4e0bc88dadd6f1b943ebd342bd64de74d5deea588ce118fe`.
- Lockfile SHA-256: `1a236e2911336985fd5b34b123348eb0a4a9429560223fd7bcba0f5c67f4b005`.
- Dependencies: owned locked `npm ci --offline` install; no package/lockfile
  edits or subsequent dependency replacements. The initial shared dependency
  symlink had failed node-forge provenance and was removed before pinned runs.
- Configuration: loopback-only HTTP, OS-assigned ephemeral ports, SQLite and
  retained local processed bytes, native bearer sessions, local-only auth
  exception, one compilation worker and five HTTP clients. No hosted load,
  IdP latency, cloud storage, external provisioning or profiler.

Raw samples, durable timestamps, input/output probes and checksums remain in
the runner's temporary mode-0600 `report.json`; the runner prints its local
path. Fixture databases/media and listeners were cleaned. Local logs/reports
remain temporary user-local output and are not linked from committed prose.

### Braces negative-control investigation

The earlier owned-install `test:fast` exited 1 in the existing upstream
negative control: `tests/braces-security.test.mjs:119` expected exit 1 for
a 4,800-level nested expansion, but its unpatched child returned 0. Patched
entry-point guards and provenance checks passed. Tests/assertions, vendor
files, dependencies and runtime settings were left unchanged.

Comparison with the lead's `rewind-329-webkit-fixture` found byte-for-byte
identical installed braces (10 files), fill-range (4), to-regex-range (4),
is-number (4), lockfile, braces test, patch, provenance and vendored tarball.
Thus no locked installation correction was justified. The test SHA-256 is
`f22a63da2295e3d4da49422097c259a9e076795acece5cb899ce843d416b78f9`;
patch SHA-256 is
`fbe3698e830716a3dab2481f674deaeacaa01e1c48c1c777b3f8084640828cb6`.

A detached checkout of exact parent
`445b56424ad89ff549529dab5729074da3fe0c75` reused the same owned locked
dependencies, Node v26.3.1, unset NODE_OPTIONS and test-controlled 128MiB child
heap. Focused unchanged braces tests passed 7/7 on both parent and runner
checkout. The exact root phase of `test:fast` passed on the parent three
times, each 98 passed/0 failed/1 existing nginx skip. Twelve standalone cold
children using the identical test expression and hash-verified reconstructed
upstream source also exited 1 with stack overflow under default flags.

Temporary diagnostic-only child invocations demonstrated optimization
sensitivity: default/`--trace-opt` and `--jitless` overflowed, while
`--no-concurrent-recompilation` returned 0 for the same original code.
The trace showed recursive `walk` being optimized by Maglev. This supports
an optimization/timing-sensitive native-stack negative control rather than
a patched guard or dependency regression. **The original default-setting
failure was not reproduced on the parent; its exact initial timing cause
remains unproven.** Diagnostic flags were never used for project checks,
measurements or the final aggregate rerun. No assertion was weakened and no
runtime option was saved to make checks pass.

After comparing source/dependencies and serializing heavy work, the one
unchanged `npm run test:fast` rerun on the 720p runner patch exited **0**:
root 98 passed/0 failed/1 existing nginx skip; server 410/410; frontend
52 suites and 523/523 tests. Historical failures remain part of the record.
This green rerun does not prove the negative control cannot intermittently
fail or establish its earlier default-runtime failure cause.

### Verification commands and exits

| Command                                                                                   | Exit | Observed result                                                                          |
| ----------------------------------------------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------- |
| `npm ci --offline`                                                                        |    0 | Owned locked install; 1055 packages added; no file changes to package/lockfile           |
| `npm run server:build`                                                                    |    0 | Existing server build before measurements                                                |
| `node --test scripts/measure-real-group-performance.test.mjs`                             |    0 | 3/3; includes source-resolution/rate regression checks and hosted-URL refusal            |
| `node_modules/.bin/eslint scripts/measure-real-group-performance*.mjs`                    |    0 | Runner and tests                                                                         |
| `node scripts/measure-real-group-performance.mjs` (720p source profile)                   |    0 | Three repetitions; all timing, chronology, audio and privacy assertions pass             |
| `node --test tests/braces-security.test.mjs` (parent and runner checkout)                 |    0 | 7/7 on each; unchanged test/deps/runtime                                                 |
| Exact `test:fast` root phase (original parent, three diagnostic runs)                     |    0 | 98 passed, 0 failed, 1 existing skip each                                                |
| Final `npm run test:fast` (owned locked dependencies, default runtime, 720p runner patch) |    0 | Root 98 passed/1 existing skip; server 410/410; frontend 52 suites, 523/523              |
| Earlier `npm run test:fast` (shared dependencies)                                         |    1 | Node-forge security provenance failure; shared install replaced                          |
| Earlier `npm run test:fast` (owned dependencies)                                          |    1 | Braces upstream expand negative control returned 0 instead of 1; server/Jest not reached |

Direct correctness regression command previously passed (exit **0**,
**71/71**, 16.81 seconds) on the same production sources and owned dependencies:

```sh
node --test --test-concurrency=1 \
  server/tests/film-compilation.test.mjs \
  server/tests/private-media-jobs.test.mjs \
  server/tests/media-integrity.test.mjs \
  server/tests/media-processing.test.mjs \
  server/tests/real-chat.test.mjs \
  server/tests/real-group-settings.test.mjs \
  server/tests/real-archive.test.mjs \
  server/tests/real-account-video.test.mjs
```

This covered actual FFmpeg chronological/audio compilation and visible
same-group filler, write-then-fail cleanup and three-attempt exhaustion,
invalid media, missing/corrupt accepted inputs, stale-generation fencing,
restart recovery and real-account privacy. The 720p rerun retains the same
API/privacy protocol; it changes only the synthetic source profile and probes.

Earlier sandbox/fixture development attempts exited 1 and were excluded from
measurement statistics. Previous smaller-resolution successful runs are also
excluded from the new submitted-target summary. All diagnostic code/output
was temporary; no shared test, dependency or production source changes were
made for the investigation.

No slow/browser/native journeys, coverage campaign, exact-head CI/CodeQL, PR,
push, merge, deployment, issue closure or Project transition was performed.
Review/integration, aggregate Quality and hosted/provider/client gates remain
lead-owned. No measured bottleneck justifies optimization or instrumentation.

Final scoped Prettier, ESLint and `git diff --check` exited **0**. The measured
runner hash above matches the follow-up patch; final prose changes do not alter
its execution. Original measurement commit is retained; the 720p and diagnosis
update is a separate follow-up commit for lead integration.
