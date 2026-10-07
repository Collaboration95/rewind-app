// Worker thread behind PostgresDatabase. The main thread blocks on a shared
// flag while this thread runs one request against its own pg client, so the
// server's synchronous persistence code runs unchanged on PostgreSQL.
import { type MessagePort, workerData } from 'node:worker_threads';

import pg, { type Client as PgClient } from 'pg';

import type { BridgeRequest, BridgeResponse, BridgeError } from './protocol';

const { Client, types } = pg;

// Match node:sqlite's value shapes: integers and aggregates as numbers,
// booleans as 0/1. Values beyond Number.MAX_SAFE_INTEGER do not occur in
// Rewind (ids are text, times are epoch milliseconds).
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));
types.setTypeParser(types.builtins.BOOL, (value) => (value === 't' ? 1 : 0));

interface WorkerData {
  connectionString: string;
  schema: string | null;
  createSchema: boolean;
  readOnly: boolean;
  flag: SharedArrayBuffer;
  port: MessagePort;
  applicationName: string;
  ssl: { rejectUnauthorized: boolean; ca?: string } | null;
}

const data = workerData as WorkerData;
const flag = new Int32Array(data.flag);
const port = data.port;

// SQLite serialises every write across connections and processes. One
// advisory lock key does the same here. Like SQLite's busy_timeout = 5000, a
// writer waits up to five seconds and then fails with "database is locked",
// which the server's existing busy-retry loops already handle.
// A schema (test runs give each database file its own) gets its own lock, so
// unrelated test databases sharing one server never block each other.
const WRITE_LOCK_KEY = data.schema
  ? [...data.schema].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) | 0, 7)
  : 5006261;
// PRAGMA busy_timeout sets this per connection, as on SQLite.
let busyTimeoutMs = 5000;

/** A usage error raised here; the connection itself is still healthy. */
class BridgeUsageError extends Error {}

class BusyError extends BridgeUsageError {
  readonly code = 'SQLITE_BUSY';
  constructor() {
    super('database is locked');
  }
}

function lockTimeout(): string {
  // lock_timeout 0 would mean "wait forever"; SQLite's 0 means "fail now".
  return `SET LOCAL lock_timeout = '${Math.max(1, Math.floor(busyTimeoutMs))}ms'`;
}

/** Opens a write transaction: BEGIN, the busy timeout and the writer lock. */
function beginSql(): string {
  return `BEGIN; ${lockTimeout()}; SELECT pg_advisory_xact_lock(${WRITE_LOCK_KEY})`;
}

/** 55P03: a lock (the writer lock, or a row lock) was not granted in time. */
function busyOr(error: unknown): unknown {
  return (error as { code?: unknown }).code === '55P03' ? new BusyError() : error;
}

async function beginWrite(connection: PgClient): Promise<void> {
  try {
    await connection.query(beginSql());
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw busyOr(error);
  }
}

let client: PgClient | null = null;
let inTransaction = false;
// SQLite lets SAVEPOINT open a transaction; RELEASE of that outermost
// savepoint then commits it.
let implicitSavepoints = 0;
let poisoned: Error | null = null;
// Server round trips for the request being handled (reported to the caller).
let roundTrips = 0;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function connect(): Promise<PgClient> {
  if (client) return client;
  const next = new Client({
    connectionString: data.connectionString,
    application_name: data.applicationName,
    ssl: data.ssl ?? undefined,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });
  // A dropped connection (failover, restart, network) must not crash the
  // process; the next request reconnects instead.
  next.on('error', (error) => {
    poisoned = error;
  });
  await next.connect();
  if (data.schema) {
    if (data.createSchema) {
      await next.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(data.schema)}`);
    }
    await next.query(`SET search_path TO ${quoteIdentifier(data.schema)}`);
  }
  // Inline literals rely on standard string quoting ('' escapes, no \\).
  await next.query('SET standard_conforming_strings = on');
  if (data.readOnly) await next.query('SET default_transaction_read_only = on');
  const query = next.query.bind(next) as PgClient['query'];
  next.query = ((...args: Parameters<PgClient['query']>) => {
    roundTrips += 1;
    return (query as (...a: unknown[]) => unknown)(...args);
  }) as PgClient['query'];
  client = next;
  poisoned = null;
  return next;
}

async function dropConnection(): Promise<void> {
  const current = client;
  client = null;
  inTransaction = false;
  implicitSavepoints = 0;
  if (current) await current.end().catch(() => undefined);
}

function toParameter(value: unknown): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function normaliseValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  return value;
}

async function runStatement(
  connection: PgClient,
  sql: string,
  params: unknown[],
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const results = await connection.query({ text: sql, values: params.map(toParameter) });
  // A multi-statement script (no parameters) answers with one result each.
  const result = Array.isArray(results) ? results[results.length - 1] : results;
  const rows = ((result?.rows ?? []) as Record<string, unknown>[]).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = normaliseValue(value);
    return out;
  });
  return { rows, rowCount: result?.rowCount ?? 0 };
}

/** Run a batch of statements in one round trip and keep result `index`. */
async function runBatch(
  connection: PgClient,
  statements: string[],
  index: number,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const results = await connection.query(statements.join(';\n'));
  const list = Array.isArray(results) ? results : [results];
  const result = list[index];
  const rows = ((result?.rows ?? []) as Record<string, unknown>[]).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = normaliseValue(value);
    return out;
  });
  return { rows, rowCount: result?.rowCount ?? 0 };
}

/**
 * One round trip per statement: values arrive as literals, so the writer
 * lock and the savepoint travel with the statement.
 */
async function runInline(
  connection: PgClient,
  kind: string,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  if (inTransaction) {
    try {
      return await runBatch(
        connection,
        ['SAVEPOINT rewind_statement', sql, 'RELEASE SAVEPOINT rewind_statement'],
        1,
      );
    } catch (error) {
      // As on SQLite, the failed statement leaves the transaction usable.
      await connection.query(
        'ROLLBACK TO SAVEPOINT rewind_statement; RELEASE SAVEPOINT rewind_statement',
      );
      throw busyOr(error);
    }
  }
  if (kind === 'write') {
    // Autocommit writes queue behind open write transactions, as on SQLite.
    try {
      return await runBatch(connection, [beginSql(), sql, 'COMMIT'], 3);
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw busyOr(error);
    }
  }
  return runBatch(connection, [sql], 0);
}

function describeError(error: unknown): BridgeError {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    return {
      message: typeof e.message === 'string' ? e.message : String(error),
      code: typeof e.code === 'string' ? e.code : undefined,
      table: typeof e.table === 'string' ? e.table : undefined,
      column: typeof e.column === 'string' ? e.column : undefined,
      constraint: typeof e.constraint === 'string' ? e.constraint : undefined,
      detail: typeof e.detail === 'string' ? e.detail : undefined,
    };
  }
  return { message: String(error) };
}

// node:sqlite keeps a transaction usable after a failed statement; PostgreSQL
// aborts it. A savepoint around each statement restores SQLite's behaviour.
async function runInsideTransaction(connection: PgClient, sql: string, params: unknown[]) {
  await connection.query('SAVEPOINT rewind_statement');
  try {
    const result = await runStatement(connection, sql, params);
    await connection.query('RELEASE SAVEPOINT rewind_statement');
    return result;
  } catch (error) {
    await connection.query('ROLLBACK TO SAVEPOINT rewind_statement');
    await connection.query('RELEASE SAVEPOINT rewind_statement');
    throw error;
  }
}

async function handle(request: BridgeRequest): Promise<BridgeResponse> {
  if (request.type === 'busy-timeout') {
    busyTimeoutMs = request.milliseconds;
    return { ok: true, rows: [], rowCount: 0 };
  }
  if (request.type === 'close') {
    await dropConnection();
    return { ok: true, rows: [], rowCount: 0 };
  }
  if (poisoned && !inTransaction) await dropConnection();
  if (poisoned && inTransaction) {
    // The transaction died with its connection. Report it once; the caller's
    // ROLLBACK then resets state and the next request reconnects.
    const error = poisoned;
    await dropConnection();
    throw error;
  }
  const kind = request.kind;
  if (kind === 'rollback' && !client) {
    inTransaction = false;
    return { ok: true, rows: [], rowCount: 0 };
  }
  const connection = await connect();
  try {
    switch (kind) {
      case 'begin': {
        if (inTransaction)
          throw new BridgeUsageError('cannot start a transaction within a transaction');
        await beginWrite(connection);
        inTransaction = true;
        return { ok: true, rows: [], rowCount: 0 };
      }
      case 'commit':
      case 'rollback': {
        if (!inTransaction) {
          // A COMMIT that failed (deferred constraint) already ended the
          // transaction; SQLite callers still ROLLBACK, which is then a no-op.
          if (kind === 'rollback') return { ok: true, rows: [], rowCount: 0 };
          throw new BridgeUsageError('cannot commit - no transaction is active');
        }
        inTransaction = false;
        implicitSavepoints = 0;
        await connection.query(kind === 'commit' ? 'COMMIT' : 'ROLLBACK');
        return { ok: true, rows: [], rowCount: 0 };
      }
      case 'noop':
        return { ok: true, rows: [], rowCount: 0 };
      case 'savepoint': {
        if (!inTransaction) {
          await beginWrite(connection);
          inTransaction = true;
          implicitSavepoints = 1;
        } else if (implicitSavepoints > 0) implicitSavepoints += 1;
        const result = await runStatement(connection, request.sql, request.params);
        return { ok: true, ...result };
      }
      case 'release': {
        const result = await runStatement(connection, request.sql, request.params);
        if (implicitSavepoints > 0) {
          implicitSavepoints -= 1;
          if (implicitSavepoints === 0) {
            inTransaction = false;
            await connection.query('COMMIT');
          }
        }
        return { ok: true, ...result };
      }
      case 'rollback-to': {
        const result = await runStatement(connection, request.sql, request.params);
        return { ok: true, ...result };
      }
      default: {
        if (request.inline)
          return { ok: true, ...(await runInline(connection, kind, request.sql)) };
        if (inTransaction) {
          return {
            ok: true,
            ...(await runInsideTransaction(connection, request.sql, request.params)),
          };
        }
        if (kind === 'write') {
          // Autocommit writes also queue behind open write transactions,
          // as they do on SQLite.
          await beginWrite(connection);
          try {
            const result = await runStatement(connection, request.sql, request.params);
            await connection.query('COMMIT');
            return { ok: true, ...result };
          } catch (error) {
            await connection.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        }
        return { ok: true, ...(await runStatement(connection, request.sql, request.params)) };
      }
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
    // Connection-level failures (socket errors, admin shutdown, failover)
    // leave the client unusable; SQL errors do not.
    if (!(error instanceof BridgeUsageError) && (!sqlState || /^(08|57P0)/.test(code as string))) {
      await dropConnection();
    }
    throw error;
  }
}

port.on('message', (request: BridgeRequest) => {
  roundTrips = 0;
  void handle(request)
    .then(
      (response) => response,
      (error: unknown): BridgeResponse => ({ ok: false, error: describeError(error) }),
    )
    .then((response) => {
      port.postMessage({ ...response, roundTrips });
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });
});
