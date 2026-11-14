// A normalised description of a SQLite schema, used to prove the squashed
// baseline (server/migrations/sqlite-baseline.sql) builds exactly the schema
// the retired migration chain 1-31 built. See migration-baseline.test.mjs.

const normalise = (sql) => (sql === null ? null : sql.replace(/\s+/g, ' ').trim());

export function schemaSnapshot(database) {
  const objects = database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all()
    .map((row) => ({ ...row, sql: normalise(row.sql) }));
  const tables = {};
  for (const { name } of objects.filter((object) => object.type === 'table')) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    tables[name] = {
      columns: database.prepare(`PRAGMA table_xinfo(${quoted})`).all(),
      foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quoted})`).all(),
      indexes: database
        .prepare(`PRAGMA index_list(${quoted})`)
        .all()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((index) => ({
          ...index,
          seq: undefined,
          columns: database
            .prepare(`PRAGMA index_xinfo("${index.name.replaceAll('"', '""')}")`)
            .all(),
        })),
      // Fresh databases carry no seed rows except migration receipts.
      rows: ['schema_migrations', 'schema_migration_markers'].includes(name)
        ? database.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count
        : database.prepare(`SELECT * FROM ${quoted}`).all(),
    };
  }
  return JSON.parse(JSON.stringify({ objects, tables }));
}
