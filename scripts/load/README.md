# Hosted performance test

Run a bounded, read-heavy test against an authorized Rewind dev origin:

```sh
TARGET_URL=https://d2m6kz76y4kuvm.cloudfront.net \
MAX_VUS=100 OUTPUT=/tmp/rewind-performance/results.json \
node scripts/load/hosted.mjs
```

The dependency-free Node runner creates three synthetic accounts, signs in once
per account and shares those sessions across VUs. It creates one private group,
uploads and processes three 68-byte photos, and leaves the fixture in place.
It never deletes data. Use a dev environment with developer password sign-in.

The sequence is 1, 10, 25, 50 and 100 VUs, with 15-second ramps and 180-second
steady windows (16 minutes 15 seconds plus setup and drain). Each VU issues one
request, then thinks for 3–7 seconds. The repeating mix is Home/group state
20%, group listing 15%, chat reads 30%, contribution ledger 10%, Archive 15%,
Archive media-capability requests 5%, and chat sends 5%. Three photo-upload
journeys occur in the first steady window and are included in its statistics.
A new collecting group has an empty Archive: the runner counts empty capability
responses separately, rather than claiming media playback was tested.

Every steady stage must have p95 below two seconds and errors below 1%.
Unexpected HTTP status, rate limiting, invalid JSON, explicit API errors and
15-second timeouts count as failures and stay in latency distributions.
The runner writes per-request observations, nearest-rank p50/p95/p99, operation
summaries and stage throughput to JSON, with a sibling `SUMMARY.md`. Results
contain no credentials or response bodies. HTTP timing includes network and
response consumption; it does not measure browser rendering or host CPU.

`MAX_VUS` is restricted to 1–100. For harness checks only, reduce
`STEADY_SECONDS` (1–180) and `RAMP_SECONDS` (0–30). A private `SAVE_FIXTURE` file
can retain sessions with mode 0600, and `FIXTURE_FILE` reuses one for the same
origin. Never commit or upload that private file. Prefer an output directory
outside the checkout. A fresh run creates new accounts, so avoid repeated setup
attempts while registration or sign-in is throttled.

The manual `performance.yml` workflow accepts `target_url` and `max_vus`,
prevents simultaneous workflow runs, and uploads JSON plus the Markdown summary.
A failed gate still uploads the evidence. Dispatch it on the branch containing
this workflow; no merge is required for local use.

To build the presentation capacity model and three 1280×720 charts, install
numpy and matplotlib in a Python environment. Put the full default-profile
JSON at `<output>/results/hosted.json`, then run:

```sh
python scripts/load/analyze.py /absolute/path/to/output
```

The analyzer writes `RESULTS.md`, `results/capacity-model.json` and `charts/*.png`.
It fits an effective serialized service demand and fixed delay to the measured
API means, excluding the bounded upload burst from calibration. It applies
U = λS, R = L + S/(1−U) and λ = N/(5+R) to project 100–1,000 active users.
Projected values are means, not p95. The idealized two-host comparison assumes
unchanged database service time. It also records half/double service-demand
sensitivity. Use a fresh methodology note for each evidence run's environment
and fixture details.

Harness regression: `node --test tests/load-test.test.mjs`.

For an explicitly separate read-only confirmation after an interfering deployment,
set `CONFIRMATION_ONLY=true FIXTURE_FILE=/private/path/to/fixture.json` with a
new `OUTPUT` path. This runs only the maximum-VU stage, reuses existing sessions,
disables uploads and replaces chat sends with reads. Its workload and result
remain separate from the full mixed-workload acceptance run.
