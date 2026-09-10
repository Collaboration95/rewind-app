# Safe local audit contract

The local diagnostics stream is an allowlisted operational trace, not remote
telemetry. Each event contains only:

```text
AuditEvent = {
  id: string,
  eventType: session.* | job.*,
  actorMemberId: synthetic member ID | null,
  resourceId: namespaced local ID | null,
  timestamp: ISO-8601 instant,
  result: success | failure | denied
}
```

Resource IDs must use a known namespace such as `session:` or `job:`. The
writer drops arbitrary values, paths, invite codes, message content, and
secrets to `null`; it has no free-form details field. Job failures therefore
remain correlated by their safe job ID without storing the thrown error.

Use `npm run server:diagnostics` for a human-readable view or append
`-- --json --limit 100` for machine-readable local inspection. Events stay in
the ignored local SQLite database and are never sent to a remote service.
