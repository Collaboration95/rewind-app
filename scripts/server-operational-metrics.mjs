import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Deliberately do not import openDatabase: it creates, migrates and seeds stores.
let database;
try {
  const args = process.argv.slice(2);
  const [databasePath, option, filesystemPath] = args;
  if (args.length !== 1 && !(args.length === 3 && option === '--filesystem' && filesystemPath))
    throw new Error();
  // The compiled server is a runtime prerequisite, not a checked-in source
  // dependency. Keep missing-build failures inside the same redaction boundary.
  const { operationalSnapshot } = await import(
    new URL('../server/dist/observability/index.js', import.meta.url).href
  );
  if (process.env.REWIND_DATABASE_URL || process.env.REWIND_TEST_DATABASE_URL) {
    // PostgreSQL: the same read-only, no-migration open the operator CLI uses.
    const { parseConfig } = await import(new URL('../server/dist/config.js', import.meta.url).href);
    const { openOperationalDatabase } = await import(
      new URL('../server/dist/db.js', import.meta.url).href
    );
    const config = parseConfig({ ...process.env, REWIND_DATA_DIR: dirname(databasePath) });
    database = openOperationalDatabase(config, { readOnly: true });
    database.exec('BEGIN');
  } else {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN');
  }
  const snapshot = operationalSnapshot(database);
  database.exec('COMMIT');
  if (filesystemPath !== undefined) {
    const { filesystemCapacity } = await import(
      new URL('../server/dist/observability/filesystem-capacity.js', import.meta.url).href
    );
    const filesystem = await filesystemCapacity(filesystemPath);
    console.log(JSON.stringify({ ...snapshot, filesystem }));
    if (filesystem.state === 'unavailable') process.exitCode = 1;
  } else {
    console.log(JSON.stringify(snapshot));
  }
} catch {
  console.error(JSON.stringify({ event: 'operational.snapshot_unavailable' }));
  process.exitCode = 1;
} finally {
  database?.close();
}
