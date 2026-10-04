# Local operational signals — #166

Operator: **not configured; named operator and approved alarm recipients remain an acceptance gate**.
Issue: [#166](https://github.com/Collaboration95/rewind-app/issues/166).

From the checkout root, build with `npm run server:build`, then run:

```sh
node scripts/server-operational-metrics.mjs /path/to/existing/rewind.sqlite
```

Use an operator account with local filesystem access. The command opens the
existing SQLite database read-only, takes a consistent read transaction, and
prints fixed aggregate fields. It does not migrate, seed, repair, send reminders,
or inspect media files. Missing/unsupported stores exit 1 with
`operational.snapshot_unavailable`; raw errors and paths are omitted.
Do not publish this cross-group output through a public HTTP endpoint.

To explicitly observe the filesystem containing an existing operator-selected
path, add the optional probe:

```sh
node scripts/server-operational-metrics.mjs /path/to/existing/rewind.sqlite --filesystem /path/on/filesystem
```

The CLI adds `filesystem` with `state: "available"`, `totalBytes` and
`availableBytes`. It calls read-only `statfs` metadata once for that path; it
does not enumerate directories or open media. Per the
[Node filesystem API](https://nodejs.org/docs/latest-v24.x/api/fs.html#statfsbavail),
total bytes use `bsize * blocks` and available bytes use `bsize * bavail`, the
blocks available to unprivileged users rather than all free blocks. Bigint
arithmetic precedes conversion to safe integer JSON numbers. No raw metadata,
path, mount identity or exception detail is printed.

A failed probe, invalid metadata or unsafe numeric conversion returns
`state: "unavailable"` with both byte values `null`, preserves the database
snapshot, and exits 1. Unknown capacity is not zero available space. Invalid CLI
arguments retain the redacted `operational.snapshot_unavailable` failure. The
one-argument database command is unchanged and performs no filesystem probe.
The database and filesystem observations are separate in time; capacity may
change immediately, and filesystem availability does not prove an account
quota, inode availability, storage-provider health or a successful deployment.

HTTP 5xx responses and uncaught failures emit one JSON `api.failure` record with
`requestId`, `statusCode`, and bounded `durationMs`. `X-Request-Id` is generated
by the server; caller correlation headers are ignored. Capture runtime stderr
with existing operator tooling. No URL, method, headers, body, exception message,
stack, or identity is included. Streaming failures log 500 even if a response
was already started. API records are process logs, not persisted SQLite counters.
The existing `/health` endpoint reports runtime/schema readiness; the snapshot
alone does not prove the server, storage provider, or scheduler is running.

| Signal                                                      | Operator action                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API failure or unhealthy `/health`                          | Correlate by generated request ID and inspect runtime readiness; follow existing deployment recovery procedures.                                                                                                                                               |
| Pending/processing count and oldest active age              | Check whether the existing worker is running and making progress; age alone has no configured paging threshold.                                                                                                                                                |
| Failed jobs/exhausted films                                 | Inspect the existing authorized group queue view; exhausted films need operator intervention. Do not silently restart loops.                                                                                                                                   |
| Recorded completed/failed attempt duration                  | Compare with worker lease limits; milliseconds match each terminal audit event to its latest preceding start within that job. Terminal events cover the last 24 hours. Missing audit pairs yield zero; this is recorded wall-clock elapsed time, not CPU time. |
| Storage integrity/quarantine/repair failures                | Inspect existing consistency tooling and approved recovery procedures. Counts are recorded audit events over 24 hours, not live storage probes.                                                                                                                |
| Explicit filesystem total/available bytes                   | Compare available capacity with the space needed by the approved staging/recovery operation; no paging threshold is configured. An unavailable observation requires operator investigation and does not authorize deletion or a deployment retry.              |
| Failed/retry/overdue reminders or expired sending leases    | Inspect existing reminder worker/provider status; never paste destinations or credentials into logs. Accepted provider state is not confirmed device delivery.                                                                                                 |
| Overdue real collecting cycles/unpublished revealing cycles | Check the existing scheduler and associated compilation queue. Receipt count is durable transitions over 24 hours, not a scheduler heartbeat.                                                                                                                  |

Queue/reminder/current cycle counts describe retained state across the local
store, including Demo jobs where applicable. Only real groups enter overdue
scheduler counts. Scheduler candidates can be temporarily due during a healthy
scan; thresholds and escalation policy require operator agreement. SQL returns
fixed numeric projections, with no identities or private row payloads. Query
work scales with retained tables; busy locks wait at most one second, and no
large-store latency acceptance has been performed.

Remaining acceptance gates: human privacy/infra review and consolidated batch
integration; a named operator; agreed thresholds and approved recipients/cost;
reviewed non-production delivery for critical API/job/storage/deploy/runtime,
queue/compile and budget alarms. No cloud alarms, deploy or budget sensors,
provider delivery, scheduled sender, or hosted failure injection are configured
or exercised by this slice. The optional filesystem observation prepares a local
capacity signal following the recorded staging `ENOSPC` failures; it does not
recover the host, activate an alarm or establish live delivery. Local fixtures
exercise an actual SQLite HTTP failure, invalid job metadata, and tampered owned
bytes. Reminder/scheduler
snapshot fixtures prove persisted-state visibility only. Keep #166 open until
applicable live alarm delivery is accepted.
