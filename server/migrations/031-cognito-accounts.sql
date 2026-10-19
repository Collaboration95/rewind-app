-- Accounts created by Cognito sign-in carry the user pool's immutable `sub`.
-- Password columns stay NOT NULL (they hold unusable random values for these
-- accounts), so no table rebuild is needed on SQLite or PostgreSQL.
ALTER TABLE real_accounts ADD COLUMN cognito_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS real_accounts_cognito_sub_idx
  ON real_accounts (cognito_sub) WHERE cognito_sub IS NOT NULL;
