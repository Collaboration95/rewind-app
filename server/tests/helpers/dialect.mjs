// The server suite runs on SQLite by default and on PostgreSQL when
// REWIND_TEST_DATABASE_URL is set (npm run server:test:postgres).

export const onPostgres = Boolean(process.env.REWIND_TEST_DATABASE_URL);

/**
 * Skip reason for tests of SQLite internals: legacy migration repair, file
 * and WAL handling, PRAGMA-level contention. PostgreSQL starts from its
 * reviewed baseline (server/migrations/postgres) and has its own tests.
 */
export const sqliteOnly = onPostgres ? 'exercises SQLite internals' : false;

export function dropTestTrigger(database, name, table) {
  database.exec(onPostgres ? `DROP TRIGGER ${name} ON ${table}` : `DROP TRIGGER ${name}`);
}

/**
 * Create a fault-injection trigger in the active dialect.
 *  - timing: 'BEFORE' | 'AFTER'
 *  - event:  'INSERT' | 'UPDATE' | 'UPDATE OF column'
 *  - when:   optional condition using NEW./OLD.
 *  - action: { abort: message } | 'ignore' (BEFORE only) | { sql: statement }
 */
export function createTestTrigger(database, { name, timing, event, table, when, action }) {
  if (!onPostgres) {
    const body =
      action === 'ignore'
        ? 'SELECT RAISE(IGNORE);'
        : action.abort !== undefined
          ? `SELECT RAISE(ABORT, '${action.abort.replaceAll("'", "''")}');`
          : `${action.sql};`;
    database.exec(
      `CREATE TRIGGER ${name} ${timing} ${event} ON ${table}
       ${when ? `WHEN ${when}` : ''} BEGIN ${body} END;`,
    );
    return;
  }
  const passThrough = timing === 'BEFORE' ? 'RETURN NEW;' : 'RETURN NULL;';
  const body =
    action === 'ignore'
      ? 'RETURN NULL;'
      : action.abort !== undefined
        ? `RAISE EXCEPTION '%', '${action.abort.replaceAll("'", "''")}';`
        : `${action.sql}; ${passThrough}`;
  database.exec(`CREATE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN ${body} END; $$`);
  database.exec(
    `CREATE TRIGGER ${name} ${timing} ${event} ON ${table} FOR EACH ROW
     ${when ? `WHEN (${when})` : ''} EXECUTE FUNCTION ${name}_fn()`,
  );
}
