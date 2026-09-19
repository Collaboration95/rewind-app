# Local Demo Session contract

This contract names the acting identity used by the local demo. It is not
authentication and must never be presented as an account, credential, or
security boundary.

## Session shape

```text
DemoSession = {
  id: string,
  accessKind: "demo",
  actor: {
    memberId: MemberId,
    displayName: non-empty string,
    isSynthetic: true
  },
  groupId: GroupId,
  startedAt: ISO-8601 instant,
  expiresAt: ISO-8601 instant,
  invalidatedAt: ISO-8601 instant | null
}
```

The actor's `memberId` is stable and comes from the five seeded synthetic
profiles. New local demo sessions expire after eight hours. The server stores
the session in SQLite, updates `last_seen_at` only after a valid check, and
never extends `expiresAt` implicitly.

## Lifecycle results

```text
validateDemoSession(sessionId) ->
  { status: "valid", session: DemoSession }
  | { status: "invalid", reason: "missing" | "not_demo", sessionId }
  | { status: "expired", reason: "expired", session: DemoSession }
  | { status: "invalidated", reason: "invalidated", session: DemoSession }
```

Missing, non-demo, expired, and invalidated sessions are all non-authorised
outcomes. They do not fall back to the profile picker and do not create a
secure authentication claim. `invalidateDemoSession` is terminal for that
session; a new local Demo access session must be created explicitly.

## Hosted request boundary

Every hosted protected route resolves its actor through the persisted
`sessionId`. The server ignores `memberId`-like query, body, and header values;
the request's `groupId` is only a resource selector and must match the session
group before membership or owner policy runs. Missing, unknown, expired, and
invalidated sessions return the same session-required response. A valid
session aimed at another group returns the shared safe denial without probing
that group's resources.

The web client keeps member ids at the Demo entry/session-creation boundary and
does not serialize them as authority on hosted group or cycle requests.

The contract deliberately excludes OIDC, passwords, secure tokens, claims,
external identity providers, and account recovery.
