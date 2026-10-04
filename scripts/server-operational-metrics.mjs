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
  database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN');
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
