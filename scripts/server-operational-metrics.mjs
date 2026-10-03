import { DatabaseSync } from 'node:sqlite';
import { operationalSnapshot } from '../server/dist/observability/index.js';

// Deliberately do not import openDatabase: it creates, migrates and seeds stores.
let database;
try {
  if (process.argv.length !== 3) throw new Error();
  database = new DatabaseSync(process.argv[2], { readOnly: true });
  database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN');
  const snapshot = operationalSnapshot(database);
  database.exec('COMMIT');
  console.log(JSON.stringify(snapshot));
} catch {
  console.error(JSON.stringify({ event: 'operational.snapshot_unavailable' }));
  process.exitCode = 1;
} finally {
  database?.close();
}
