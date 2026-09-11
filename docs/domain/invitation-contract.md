# Local invitation contract

Invitation codes are local-runtime values, not account credentials. An owner
generates an eight-character uppercase code for their current group. Each code
has a five-minute minimum and seven-day maximum expiry (24 hours by default)
and can be consumed once.

Acceptance requires an active Demo session. The runtime validates the code,
expiry, use state, and requested group before atomically inserting a member
row and marking the invite used. Invalid, expired, used, duplicate-member, and
cross-group attempts do not create membership. The code is never written to
audit output.
