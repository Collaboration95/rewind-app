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
(150 seconds nominal total), with alternating 180x320/12fps and 360x640/24fps
sources, 44.1/48kHz audio, varying sine frequencies and source volumes. Every
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

## Observed result — 3 October 2026

Final runner measurement: **exit 0**, 15:56:13–15:58:07 SGT. All three
normal declared repetitions passed. API results are 1,200 measured requests
(100 per operation per repetition), excluding warm-up. Films total 75 newly
generated six-second input files across three independent fixtures.

| Run | Operation | Samples | Errors | p50 ms | p95 ms | Max ms |
| --- | --------- | ------: | -----: | -----: | -----: | -----: |
| 1   | group     |     100 |      0 |  2.894 |  4.254 |  8.108 |
| 1   | prompt    |     100 |      0 |  3.091 |  4.375 |  8.312 |
| 1   | budget    |     100 |      0 |  2.846 |  3.349 |  8.105 |
| 1   | chat      |     100 |      0 |  2.963 |  4.206 |  8.180 |
| 2   | group     |     100 |      0 |  3.005 |  3.803 |  4.221 |
| 2   | prompt    |     100 |      0 |  3.215 |  3.979 |  7.039 |
| 2   | budget    |     100 |      0 |  3.001 |  3.713 |  4.236 |
| 2   | chat      |     100 |      0 |  3.060 |  3.807 |  4.324 |
| 3   | group     |     100 |      0 |  3.102 |  4.897 |  6.598 |
| 3   | prompt    |     100 |      0 |  3.297 |  5.046 |  8.751 |
| 3   | budget    |     100 |      0 |  3.102 |  4.394 |  6.382 |
| 3   | chat      |     100 |      0 |  3.183 |  4.845 |  8.632 |

| Run | Warm-up seconds | Warm-up requests | Queue ms | Worker seconds | End-to-end seconds | Output seconds |  LUFS |
| --- | --------------: | ---------------: | -------: | -------------: | -----------------: | -------------: | ----: |
| 1   |          30.103 |             1400 |    2.352 |          4.291 |              4.293 |          150.4 | -17.4 |
| 2   |          30.043 |             1400 |    1.421 |          4.232 |              4.233 |          150.4 | -17.4 |
| 3   |          30.005 |             1385 |    3.676 |          4.247 |              4.251 |          150.4 | -17.4 |

All films completed 25/25 inputs in one attempt, decoded video/audio fully,
and passed all 25 chronological frame positions. Production normalization
yielded -17.4 LUFS in all repetitions. Three repetitions of outsider group
(404), budget (403), chat (403), and prompt mutation (403) denial passed.
Non-owner prompt mutation returned 403; the actual seeded clip owner
received 404 for sealed download before compilation/release.

### Host, build and exact configuration

- Host: Apple M5, 10 logical CPUs, arm64, Darwin 25.6.0, 32 GiB RAM.
- Initial free memory: 1478623232 bytes; load averages: [3.51708984375, 3.591796875, 3.83203125].
- Power: AC attached was observed with `pmset -g batt` before the final run.
- Lead reported concurrent WebKit activity on owned port 10894. CPU contention
  was accepted and may affect these numbers; broad local suites were serialized
  after the measurement.
- Runtime: `/opt/homebrew/bin/node`, **v26.3.1**; npm 11.16.0. Node 22 was not
  used or verified; the usual node@22 path was unavailable per lead context.
- Encoder: ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers.
- Application base: `445b56424ad89ff549529dab5729074da3fe0c75`. The standalone runner was
  uncommitted during measurement; no production application files changed.
- Runner SHA-256: `4f6d897511f9c700ce8d9ad21fea1e4c5521e52475faa651073248f95c5c9ca5`.
- Lockfile SHA-256: `1a236e2911336985fd5b34b123348eb0a4a9429560223fd7bcba0f5c67f4b005`.
- Final measurement used an owned `npm ci --offline` install, not the original
  dependency symlink. Install-script warnings for fsevents/unrs-resolver were
  emitted; no package-script approvals were added.
- Configuration: loopback-only HTTP, OS-assigned ephemeral ports, local SQLite
  and retained local processed bytes; native bearer sessions and loopback auth
  exception. No IdP, object-storage provider, hosted traffic, profiler or
  external provisioning. One FFmpeg compilation worker; five HTTP clients.

Raw final samples, host/configuration, durable timestamps and all input/output
checksums are retained in [/var/folders/g8/5_hq0kbs4499lmjhph03mvgc0000gn/T/rewind-perf-353-u6YPEv/report.json](/var/folders/g8/5_hq0kbs4499lmjhph03mvgc0000gn/T/rewind-perf-353-u6YPEv/report.json). Fixture database/media
files were removed, and all owned measurement listeners closed. The runner
source and report can reproduce the declared workload; the report is local
temporary output and is not committed as a separate evidence folder.

### Verification commands and exits

| Command                                                                         | Exit | Observed result                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --offline`                                                              |    0 | Owned locked install; 1055 packages added                                                                                                                                  |
| `npm run server:build`                                                          |    0 | Server TypeScript build; rebuilt after owned install                                                                                                                       |
| `/opt/homebrew/bin/node --test scripts/measure-real-group-performance.test.mjs` |    0 | 3/3 focused runner tests, including refusal of supplied hosted URL                                                                                                         |
| `node_modules/.bin/eslint scripts/measure-real-group-performance*.mjs`          |    0 | Runner and focused tests                                                                                                                                                   |
| `/opt/homebrew/bin/node scripts/measure-real-group-performance.mjs`             |    0 | Final exact runner hash above; three target/chronology/audio/privacy repetitions                                                                                           |
| `npm run test:fast` (shared dependencies)                                       |    1 | Root entry failed node-forge bundle provenance at node-forge-security.test.mjs:46; server/Jest not reached                                                                 |
| `npm run test:fast` (owned pinned dependencies)                                 |    1 | Root: 97 passed, 1 failed, 1 skipped; braces-security.test.mjs:119 original expand negative control exits 0 instead of expected 1 on Node v26.3.1; server/Jest not reached |

The shared dependency symlink was unsuitable and replaced. Earlier development
runner attempts exited 1: two sandbox loopback bind denials, one incorrect
expected outsider-budget status, and one malformed negative settings request
missing its timezone. These failed attempts are excluded from final statistics.
The corrected runner retained explicit privacy assertions. Earlier successful
runs using shared dependencies or the previous runner hash are also excluded.

The existing braces negative-control test and vendor/package/lock files are
unchanged from the exact base. This is an observed failure with Node v26.3.1;
its broader runtime cause and a passing aggregate on the CI runtime remain
unverified. No test assertions or project gates were weakened.

Direct correctness regression command (exit **0**, **71/71 passed**, 16.81s):

```sh
/opt/homebrew/bin/node --test --test-concurrency=1 \
  server/tests/film-compilation.test.mjs \
  server/tests/private-media-jobs.test.mjs \
  server/tests/media-integrity.test.mjs \
  server/tests/media-processing.test.mjs \
  server/tests/real-chat.test.mjs \
  server/tests/real-group-settings.test.mjs \
  server/tests/real-archive.test.mjs \
  server/tests/real-account-video.test.mjs
```

This passed actual FFmpeg chronological/audio compilation and visibly labelled
same-group archive filler, write-then-fail artifact cleanup and three-attempt
exhaustion, invalid media rejection, missing/corrupt accepted-input failure,
integrity and stale-generation fencing, restart recovery, and real-account
sealed/outsider/cross-group authorization. It does not substitute for the
blocked aggregate fast check or hosted/client acceptance.

Final scoped Prettier check and `git diff --check` both exited **0**. Logs:

- [Final measurement](/private/tmp/rewind-353-measurement-final.log)
- [Owned dependency install](/private/tmp/rewind-353-npm-ci.log)
- [Fast check with shared dependencies](/private/tmp/rewind-353-test-fast.log)
- [Fast check with owned dependencies](/private/tmp/rewind-353-test-fast-pinned.log)
- [71 media/privacy regressions](/private/tmp/rewind-353-media-regressions.log)

No slow/browser/native journeys, coverage campaign, exact-head CI/CodeQL scan,
PR, push, merge, deployment, issue closure or Project transition was performed.
The lead owns review/integration and resolving the aggregate check on the
supported CI runtime. No performance bottleneck was demonstrated by this
bounded workload, so no performance optimization is proposed.
