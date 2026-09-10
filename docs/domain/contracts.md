# Sprint 0 domain contracts

The contracts below are deliberately framework-independent. They are a small
boundary for later local fixtures and do not prescribe persistence, transport,
authentication, or a database schema.

## Value types

```text
MemberId = string
GroupId = string
CycleId = string

ContributionQuota = {
  maxCount: positive integer,
  maxSeconds: positive integer
}

ContributionUsage = {
  countUsed: non-negative integer,
  secondsUsed: non-negative integer
}

CycleStatus = collecting | revealing | archived
LockState = locked | unlocked
```

## Profile contract

```text
MemberProfile = {
  id: MemberId,
  displayName: non-empty string,
  avatarLabel: non-empty accessible string,
  isSynthetic: true
}
```

`isSynthetic` is explicit so a local fixture cannot be mistaken for a real
identity. Sprint 0 seeds exactly five profiles.

## Group contract

```text
Group = {
  id: GroupId,
  name: non-empty string,
  memberIds: non-empty list of MemberId,
  currentCycleId: CycleId
}
```

A group-scoped read requires the acting `MemberId` to be present in
`memberIds`. An adapter must refuse the request when membership is absent; it
must not return an empty success that could conceal an authorisation defect.

## Cycle contract

```text
Cycle = {
  id: CycleId,
  groupId: GroupId,
  prompt: non-empty string,
  startsAt: ISO-8601 instant,
  endsAt: ISO-8601 instant,
  status: CycleStatus,
  lockState: LockState,
  quota: ContributionQuota,
  contributionUsage: ContributionUsage
}
```

The Sprint 0 seed uses `status = collecting`, `lockState = locked`,
`quota.maxCount = 5`, `quota.maxSeconds = 30`, and zero used contributions for
the selected demo member. `contributionUsage` is scoped to the acting member
passed to the repository read. Countdown presentation is a view concern
derived from the cycle instants; the UI must not own a second set of quota
values.

## Repository ports

```text
ProfileRepository.listProfiles() -> list of MemberProfile

GroupRepository.getGroupForMember(
  actingMemberId: MemberId
) -> Group | MembershipDenied

CycleRepository.getCurrentCycle(
  groupId: GroupId,
  actingMemberId: MemberId
) -> Cycle | MembershipDenied | NotFound | RecoverableFailure
```

The local HTTP adapter implements the same group contract asynchronously; the
UI boundary awaits either the synchronous offline fixture or the async adapter.

`MembershipDenied` is a distinct negative result. `NotFound` and
`RecoverableFailure` support honest empty and retry states in later UI work.
No contract returns media URIs, thumbnails, or player data while a cycle is
locked.
