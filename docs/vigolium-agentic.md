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
source audit and rescan phases are disabled. AI planning and triage remain enabled.
The agent can choose modules and generate extensions; prompt instructions are
guidance, not an execution sandbox.

On successful execution with observed scanner traffic, the report says
`scanner-completed` and exports HTML/JSONL findings with response bodies omitted
and known credentials redacted. AI conclusions require reviewing evidence.
A failure is `incomplete`, never a clean result. Raw agent logs and the raw scan
database are not published. Exports can still contain synthetic request data;
review before sharing. This trial does not yet compare owner/member/outsider
identities, cover every route, or establish that AI finds issues the native scan
misses. The native scan retains its separate role checks.

Next validation is a deliberately vulnerable fixture to demonstrate a real
provider-backed finding, followed by expanding approved endpoint coverage. Do
not make live scanning automatic until scope, isolation, cost and evidence are
validated.

Reference: [Vigolium swarm documentation](https://docs.vigolium.com/agentic-scan/swarm).
