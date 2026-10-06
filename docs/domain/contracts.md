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
  avatarLabel: non-empty accessible string
}
```

Profiles belong to real accounts; the synthetic Sprint 0 profiles were removed
with the Demo on 6 October 2026.

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

A new cycle starts with `status = collecting`, `lockState = locked`, and zero
used contributions for each member. `contributionUsage` is scoped to the acting member
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

The HTTP adapter implements the same group contract asynchronously.

`MembershipDenied` is a distinct negative result. `NotFound` and
`RecoverableFailure` support honest empty and retry states in later UI work.
No contract returns media URIs, thumbnails, or player data while a cycle is
locked.

The account session boundary is defined in
[`session-contract.md`](./session-contract.md), and safe operational events
are defined in [`audit-contract.md`](./audit-contract.md).
