-- Finalized clip and film outputs carry a SHA-256 digest and byte length
-- recorded inside the same fenced finalization that publishes them. The
-- repairable column set is applied in server/src/db.ts so an interrupted
-- upgrade can be resumed; this receipt keeps fresh installs and upgrades on
-- one ordered contract.
SELECT 1;
