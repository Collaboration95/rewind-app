-- The contribution ledger read model is a metadata-only projection over
-- `contributions` joined to its `media_jobs` row. Its additive column and
-- scope index are applied repairably in server/src/contributions/ledger.ts by
-- `ensureContributionLedgerSchema`, which the ordered migration hook in
-- server/src/db.ts calls. This receipt keeps fresh installs and upgrades on
-- one ordered contract without duplicating the column work in SQL.
SELECT 1;
