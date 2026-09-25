-- Consistency quarantine, repair, and cleanup-failure events are added by the
-- ordered audit-table migration in server/src/db.ts, preserving existing rows.
SELECT 1;
