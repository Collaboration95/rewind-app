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

The contract deliberately excludes OIDC, passwords, secure tokens, claims,
external identity providers, and account recovery.
