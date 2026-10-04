# External-provider agentic trial

This trial uses Vigolium 0.5.1's `agent swarm` with a hosted AI provider.
No local AI model or personal Codex login is needed. The app and scanner still
run on a computer or CI worker; the AI runs at the provider.

The existing native scanning workflow remains the automatic dev/PR scan.
Agentic execution is separate and opt-in. This branch is an initial bounded
chat-endpoint trial, not whole-app discovery or a completed live AI evaluation.

## Offline setup checks

```sh
npm run security:agentic:prepare
node --test tests/vigolium-provider.test.mjs
npm run security:agentic:verify
```

Preparation writes configuration status without launching the scanner. Verification
creates a temporary SQLite backend and account, creates a group, and verifies:

- Authenticated chat creation returns 201.
- Anonymous chat access returns 401.
- Requests outside the permitted chat endpoint return 403.

Reports are in `vigolium-result/agentic/summary.html` and `scope.json`.
`verified-offline` means setup works; it is not a security assessment and does
not mean the app has no vulnerabilities. Temporary accounts and databases are
removed at the end. Previous exported findings are removed before a new attempt.

## Live trial on a disposable worker

### Offline connection to the real Rewind backend

```sh
npm run server:build
node scripts/run-vigolium-rewind.mjs --build
node scripts/run-vigolium-rewind.mjs --verify
```

Set `REWIND_DOCKER_BIN` if Docker is not on PATH. This creates a separate backend
image with compiled runtime, migrations and synthetic demo fixtures. The scanner
image contains no Rewind runtime or source. The two disposable containers share
only a network namespace and the report directory, with external networking
disabled, no published ports and no provider key. Temporary databases live in
the backend's tmpfs. A short-lived `target.json` provides only the loopback chat
URL, disposable bearer token and baseline statuses; it is removed during cleanup.

The setup checks login, group creation, owner chat read/write, anonymous denial,
and unrelated-account read/write denial. The scanner independently checks the
authenticated seed and scope boundary. Reports are under
`vigolium-result/agentic-rewind-container/`; `summary.html`, `app-baselines.json`
and `isolation.json` describe setup and isolation, not AI vulnerability findings.
The wrapper currently supports build and offline verification only. Live Rewind
provider scanning needs separate data-sharing authorization and the app-specific
agent execution configuration; synthetic-fixture approval is insufficient.

### Container and known-vulnerability fixture

The isolated evaluation image contains only Vigolium and the synthetic fixture
harness. Application code, `.git`, personal files and credentials are excluded
from its build context and runtime image. The fixture is an in-memory SQL database
bound to loopback; it is never wired into the Rewind server or published on a host
port. It deliberately interpolates a chat filter into SQL. A second, parameterized
control uses the same data and input to show the fix.

Without Docker or API credentials, verify the known defect and control:

```sh
npm run security:agentic:fixture
```

The offline check confirms that a known SQL-injection payload exposes
`SYNTHETIC_PRIVATE_CANARY` in the vulnerable target and returns no rows in the
parameterized control. Its report labels `discoveredByAI: false`; these are
fixture checks, not AI findings. Reports are in `vigolium-result/agentic-fixture/`.

With Docker Desktop running in Linux-container mode (or Docker Engine on Linux):

```sh
npm run security:agentic:container:build
npm run security:agentic:container:verify
```

The image build downloads pinned project dependencies but runs no AI scan. It
uses a Dockerfile-specific allowlist for the build context. The wrapper starts
an unprivileged container with a read-only root filesystem, all capabilities
dropped, no privilege escalation, bounded CPU/memory/processes, and temporary
scratch storage. The only host mount is `vigolium-result/agentic-container/`
for reports; no Docker socket or home directory is mounted. Offline verification
uses `--network none`, so provider egress is disabled. No ports are published.
Verification also starts the Vigolium binary and checks effective UID,
capabilities, privilege-escalation restrictions, root filesystem writes, absence
of app source/Git, and external network interfaces. Results are saved to
`vigolium-result/agentic-container/isolation.json`.
Scratch storage permits execution because Vigolium extracts executable helpers
there. This is container isolation, not a guarantee against all container escapes.

Once API credentials and sharing approval are configured as described below:

```sh
npm run security:agentic:container:run
```

This runs the agent against the **synthetic vulnerable fixture**, not the app.
The container receives only the selected provider key and scan settings. It needs
outbound networking for the provider; `bridge` networking is not a provider-only
egress allowlist and may reach other addresses. Generated tools can bypass the
in-container HTTP proxy. Do not supply production credentials or data. The
wrapper removes its owned container after success, failure or deadline expiry.

A successful live evaluation must contain an evidence-backed SQL-injection finding
from agent-selected probes. The offline known payload is not injected before a
live run and the agent is not told the canary value. Manually compare findings with
the documented fixture defect and parameterized fix before claiming detection.
The current live fixture runner scans the vulnerable variant only; the control
is verified offline. Container execution needs separate validation on a running
Docker daemon; unit tests of launch options do not establish runtime isolation.

### Provider credentials for a live run

Choose `REWIND_AGENT_PROVIDER` from `openai-responses` (default),
`openai-api-key`, or `anthropic-api-key`. Set `REWIND_AGENT_MODEL` to a model
supported by that provider and your account. Supply `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY` through environment variables or CI secrets, never committed
files. This uses API billing, not a personal Codex subscription.

Only after approving synthetic request/response sharing with the chosen provider,
set `REWIND_AGENT_DATA_SHARING=approved` and run:

```sh
npm run security:agentic:run
```

The scanner receives a disposable authenticated HTTP request through stdin.
The runner uses `--input -`: Vigolium 0.5.1 skips automatic stdin detection when
`--target` is present, which would lose the supplied POST body and authorization.
The request also declares its same-origin HTTP `Origin`; otherwise Vigolium
assumes HTTPS on the fixture's nonstandard loopback port.
The proxy accepts both origin-form and the JS SDK's absolute-form request lines,
but an absolute URL must name this proxy's exact origin and endpoint. Foreign
origins, other paths and query strings remain blocked.
No `--source`, personal OAuth credentials, or repository source context is
provided. Requests and responses, including the disposable bearer token, may be
sent to the model. This is a data-sharing approval switch, not a complete
technical guarantee against source access: Vigolium agents can use tools.

Run live scans on an ephemeral dedicated worker with only the needed application
runtime and dependencies, no personal files or production credentials. The
runner uses a temporary working directory, temporary configuration and a limited
child environment. These reduce accidental exposure but do not isolate the host
filesystem or all outbound traffic. The proxy enforces scope only for traffic
through its seed URL; generated agent tools can potentially bypass it.

The initial target is one group's chat GET/POST endpoint. The proxy denies other
paths and methods, caps bodies at 64 KiB, caps admitted requests at 120, spaces
forwards by 550 ms and times out upstream requests after five seconds. The agent
has a five-minute budget with a six-minute process deadline. Broad discovery,
source audit and discovery phases are disabled. AI planning and extension generation
remain enabled. AI triage is disabled for this focused trial because its rescan path
expanded to all modules despite the requested rescan exclusion.
The trial selects the error-based SQL injection module and asks the AI to generate
a small custom extension using paired controls. Broad native boolean SQL injection
testing exhausted the 120-request gate in the trial, so it is excluded.
The agent can choose modules and generate extensions; prompt instructions are
guidance, not an execution sandbox.

On successful execution with an observed accepted authenticated POST, the report says
`scanner-completed` and exports HTML/JSONL findings with known credentials redacted.
The runner requests `--omit-response`, but Vigolium 0.5.1 can still include response
bodies in JSONL finding evidence. Treat exports as synthetic data, not as guaranteed
body-free reports. AI conclusions require reviewing evidence.
A failure is `incomplete`, never a clean result. Raw agent logs and the raw scan
database are not published. Exports can still contain synthetic request data;
review before sharing. This trial does not yet compare owner/member/outsider
identities, cover every route, or establish that AI finds issues the native scan
misses. The native scan retains its separate role checks.
The summary separates informational observations from vulnerability findings and
explicitly states whether SQL injection was reported. `scanner-completed` describes
execution; it does not mean the detection trial passed. `requestLimitReached`
flags exhaustion of the request allowance.
For the synthetic live trial, `generated-artifacts.json` retains up to ten redacted
plan/extension files (256 KiB each); raw session conversations are discarded.
`fixtureProbes` records bounded synthetic body values, authentication booleans,
statuses and canary exposure without credential headers. Treat generated scripts
as untrusted code and keep them in the disposable container.

`independentVerification` replays up to eight observed changed body values against
fresh vulnerable and parameterized twins. It establishes SQL predicate manipulation
only when a changed value returns rows from the vulnerable query while the bound
parameter returns none, with valid authenticated baselines. Syntax errors alone
do not pass. `detectionTrialPassed` requires both a scanner SQL injection finding
and this independent confirmation. The SDK context contract in the prompt tells
the extension to parse `ctx.request.raw`; `ctx.request.body` is unavailable.
The synthetic live runner exits nonzero when this detection gate fails, even if
the scanner process itself completed successfully.
After swarm generation, the fixture runner explicitly ingests the authenticated
seed and runs Vigolium's dedicated `run extension` phase using the generated
files. The installed swarm bridge did not execute their probes in the trial.
The dedicated phase uses its own scan database and removes the native-only module
allowlist, which otherwise excludes generated extension IDs.
Unmodified generated files are copied into the temporary home's default extension
directory and explicitly selected with `--ext`; starter presets are removed only
from that owned temporary directory. Both explicit and isolated default
configuration point to those files. Native extension execution, ingestion and export
receive no provider key. This is an orchestration workaround, not a patch to
Vigolium's binary or a hand-written exploit substituted for AI generation.
Generation instructions require stable true-versus-false response differences,
without assuming a false OR predicate removes existing baseline matches. Generated
detectors can still be wrong, so successful process exit alone never passes the
independent detection gate.

To repeat execution without another provider call, run
`node scripts/run-vigolium-container.mjs --replay` after a live synthetic run has
retained `generated-artifacts.json`. Replay uses the network-disabled container,
passes no API key, and relocates only the generated script's disposable loopback
fixture URL. It preserves detector logic and overwrites the current report with
the replay result, explicitly marked `providerContacted: false`.

The repaired execution/export path passed with a retained provider-generated
detector: a high-severity SQL injection finding was exported and independently
confirmed. Separate offline execution against the parameterized fixture produced
no SQL injection finding. This is synthetic evidence; a fresh generation can
still fail the detection gate. Next validation is expanding approved endpoint coverage. Do
not make live scanning automatic until scope, isolation, cost and evidence are
validated.

Reference: [Vigolium swarm documentation](https://docs.vigolium.com/agentic-scan/swarm).
