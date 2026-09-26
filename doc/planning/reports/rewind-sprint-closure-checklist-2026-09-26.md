# Current Demo sprint closure checklist

**Decision:** synthetic Demo acceptance only. Real accounts and remote/PWA reminders are next sprint. **Current status: implementation ready for review; sprint not closed.**

| Step                                          | Owner / dependency                           | Evidence required                                                     | Status at handoff                                             |
| --------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| Review release #205 then CI #204              | Non-author reviewer                          | Final-head green checks, focused review, no bypass                    | Open PRs; both final heads green                              |
| Review correctness #206 then performance #207 | Non-author reviewer                          | Final-head green checks, native evidence, focused review              | Open PRs; both final heads green                              |
| Confirm long archive scrolling                | Any genuine device reviewer                  | Older entries reachable; navigation remains usable                    | ScrollView implemented; full gate passes; manual swipe open   |
| Reconcile infrastructure drift                | Andrew reviews; Guruprasath applies          | Fresh exact plan; separate Lambda/scheduler drift from permitted wake | Blocked; 5 creates / 3 updates / 0 deletes snapshot; no apply |
| Build reviewed release                        | Clean green main after merges                | Verified artifact digest, exact image IDs and config/schema metadata  | Tooling implemented; final main release not built             |
| Verify real origin/distribution #200          | Hosted operator                              | Actual distribution reaches configured host port 80 → web 8080        | Code already main; hosted proof missing                       |
| Verify lifecycle #190                         | Hosted operator                              | Restore/recreate, failure recovery, correct release pointers          | Local/cloud-free tests pass; hosted proof missing             |
| Complete hosted acceptance #145               | Andrew/non-author + operator                 | Two HTTPS journeys, restart, denial and rollback/fallback evidence    | Not run                                                       |
| Physical-device acceptance                    | Android APK / installed iPhone PWA reviewers | Honest camera/media/download status                                   | Not run; simulator is not substitute                          |
| Update board and report                       | Sprint coordinator                           | Accepted evidence linked; unresolved gates stay visible               | Report prepared; do not mark all Done                         |

## Four-week continuation proposal

- **Week 5, 27 Sep–3 Oct:** close reviewed Demo delivery gates; stabilize main release; establish identity and reminder interface contracts and owners.
- **Week 6, 4–10 Oct:** parallel real-account/OIDC flow, reminder service and client integration; review or remove expiring IaC exceptions by 10 Oct.
- **Week 7, 11–17 Oct:** integrate vertical journeys, physical-device testing, reliability and security regressions; avoid unrelated feature expansion.
- **Week 8, 18–24 Oct:** release rehearsal, defect burn-down, independent acceptance and final evidence/documentation.

This is a planning proposal, not a commitment backed by measured team capacity. Confirm ownership and availability before assigning sprint points. Track PR cycle time, review wait, accepted completion and failure/rework rate. Use short feature branches into protected main plus tested release artifacts; staging/production are release environments, and a long-lived dev branch is unnecessary unless the team adopts a clear promotion contract.

See `rewind-audit-handoff-2026-09-26.md` for exact branches, commands, limitations and continuation steps. Use Sol Medium for routine follow-through and Luna High only where complex review requires it; do not repeat the completed audit.
