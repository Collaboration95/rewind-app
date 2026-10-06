# Rewind Sprint 0 glossary

These definitions are normative for the local-first contracts. They describe
the product model, not authentication or a cloud schema.

| Term               | Definition                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member             | A participant in a group, represented by a real account with a stable identifier and display label.                                                                                     |
| Group              | A private-product concept containing a bounded set of members and one current cycle.                                                                                                    |
| Cycle              | A bounded collection period for one group. It has a prompt, start/end instants, a lifecycle status, and contribution quota.                                                             |
| Contribution quota | The maximum number of contributions and total duration available to a member in the current cycle. Sprint 0 uses five contributions and 30 seconds as seeded limits.                    |
| Locked state       | The pre-reveal state in which contribution metadata may be shown but unrevealed media and media actions are not available.                                                              |
| Repository port    | A framework-independent interface that supplies domain data or performs a domain-scoped operation. UI and platform adapters depend on the port; the contract does not depend on either. |
