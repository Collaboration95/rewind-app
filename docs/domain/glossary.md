# Rewind domain glossary

These definitions describe the current real-account product. Persisted tables,
keys and compatibility records are documented in the
[database design](database-design.md).

| Term               | Definition                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account            | A sign-in identity in `real_accounts`. Cognito uses its immutable pool subject; local/dev also support developer password sign-in.                                                                   |
| Member             | An account participating in a group through `real_group_memberships`, with an owner/member role and a real profile ID used as the public member ID.                                                  |
| Profile bridge     | Triggers mirror `real_profiles` into shared media/chat `profiles` under the same ID. The bridge satisfies media ownership references; group authority still comes from real memberships.             |
| Group              | A private set of members with one application-selected current collecting cycle and potentially earlier revealing or archived cycles.                                                                |
| Cycle              | A bounded collection period with prompt, start/end instants, lifecycle and release state. Product default is 28 days; configured local runs can be shorter.                                          |
| Contribution       | An accepted photo or video represented by metadata and a processing job. Photos consume three seconds; videos consume their validated accepted duration. Bytes live outside the relational database. |
| Contribution quota | A member's allowance in a cycle-start-anchored seven-day window: at most five contributions and 30 seconds, with at most 15 seconds per contribution. Smaller configured limits can apply.           |
| Upload reservation | An unexpired open/pinned upload intent holding count and seconds alongside consumed quota. Completion atomically converts the hold into accepted contribution usage.                                 |
| Correction         | One eligible author deletion per current collecting quota window, returning that contribution's allowance and retaining a tombstone. Owner removal is separate and does not refund quota.            |
| Sealed / locked    | Before release, metadata may be visible while unrevealed media/actions are denied. The stored `lock_state` alone is not authorization; lifecycle, publication and ownership policy also apply.       |
| Premiere           | The 24-hour period after verified film publication. The next collecting cycle already exists; the previous cycle archives after the premiere and verification.                                       |
| Repository port    | A framework-independent interface supplying domain data or a domain operation. UI/platform adapters depend on the port rather than defining its contract.                                            |
