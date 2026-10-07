// A synchronous PostgreSQL connection with the node:sqlite DatabaseSync
// surface Rewind uses (prepare → run/get/all/iterate, exec, close). Each call
// blocks the calling thread until a dedicated worker thread has run it, which
// keeps SQLite's single-connection, serialised-writer semantics.
import { resolve } from 'node:path';
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
  type MessagePort,
} from 'node:worker_threads';

import type { BridgeError, BridgeRequest, BridgeResponse } from './protocol';
import { splitStatements, translate } from './translate';

export interface PostgresConnectionOptions {
  connectionString: string;
  /** Optional schema; every statement then runs with this search_path. */
  schema?: string | null;
  createSchema?: boolean;
  applicationName?: string;
  /** null disables TLS (local development only). */
  ssl?: { rejectUnauthorized: boolean; ca?: string } | null;
  /** Every transaction is read-only (operator reports). */
  readOnly?: boolean;
  /** Test runs only: the SQLite file path this schema stands in for. */
  testDatabasePath?: string;
  /** Upper bound for one statement, including reconnecting. */
  statementTimeoutMs?: number;
}

type Row = Record<string, unknown>;
type Params = unknown[];

const SQLITE_CONSTRAINT_CODES: Record<string, { errcode: number; label: string }> = {
  '23505': { errcode: 2067, label: 'UNIQUE' },
  '23503': { errcode: 787, label: 'FOREIGN KEY' },
  '23514': { errcode: 275, label: 'CHECK' },
  '23502': { errcode: 1299, label: 'NOT NULL' },
};

/** An Error shaped like node:sqlite's so callers' checks keep working. */
export class PostgresDatabaseError extends Error {
  readonly code: string;
  readonly errcode: number;
  readonly errstr: string;
  readonly sqlState: string | undefined;
  readonly constraint: string | undefined;

  constructor(error: BridgeError) {
    const mapped = error.code ? SQLITE_CONSTRAINT_CODES[error.code] : undefined;
    let message = error.message;
    if (mapped) {
      const columns = /^Key \(([^)]*)\)/.exec(error.detail ?? '')?.[1];
      const target =
        mapped.label === 'UNIQUE' && error.table && columns
          ? `: ${columns
              .split(',')
              .map((column) => `${error.table}.${column.trim()}`)
              .join(', ')}`
          : mapped.label === 'NOT NULL' && error.table && error.column
            ? `: ${error.table}.${error.column}`
            : mapped.label === 'CHECK' && error.constraint
              ? `: ${error.constraint}`
              : '';
      message = `${mapped.label} constraint failed${target} (${error.message})`;
    }
    super(message);
    this.name = 'Error';
    const busy = error.code === 'SQLITE_BUSY';
    this.code = busy ? 'SQLITE_BUSY' : 'ERR_SQLITE_ERROR';
    this.errcode = busy ? 5 : (mapped?.errcode ?? 1);
    this.errstr = busy ? 'database is locked' : mapped ? 'constraint failed' : 'SQL logic error';
    this.sqlState = error.code;
    this.constraint = error.constraint;
  }
}

function nullPrototypeRow(row: Row, names: Map<string, string>): Row {
  const out = Object.create(null) as Row;
  for (const [key, value] of Object.entries(row)) out[names.get(key) ?? key] = value;
  return out;
}

export class PostgresStatement {
  private readonly database_: PostgresDatabase;
  private readonly source_: string;

  constructor(database: PostgresDatabase, source: string) {
    this.database_ = database;
    this.source_ = source;
    // Fail at prepare time, as node:sqlite does, on unsupported syntax.
    translate(source);
  }

  get sourceSQL(): string {
    return this.source_;
  }

  run(...params: Params): { changes: number; lastInsertRowid: number } {
    const result = this.database_.query(this.source_, params);
    return { changes: result.rowCount, lastInsertRowid: 0 };
  }

  get(...params: Params): Row | undefined {
    return this.database_.query(this.source_, params).rows[0];
  }

  all(...params: Params): Row[] {
    return this.database_.query(this.source_, params).rows;
  }

  *iterate(...params: Params): IterableIterator<Row> {
    yield* this.all(...params);
  }
}

export class PostgresDatabase {
  readonly dialect = 'postgres' as const;
  readonly schema: string | null;
  readonly testDatabasePath: string | null;
  private worker_: Worker | null;
  private port_: MessagePort;
  private flag_: Int32Array;
  private timeoutMs_: number;

  constructor(options: PostgresConnectionOptions) {
    const shared = new SharedArrayBuffer(4);
    this.flag_ = new Int32Array(shared);
    const { port1, port2 } = new MessageChannel();
    this.port_ = port1;
    this.schema = options.schema ?? null;
    this.testDatabasePath = options.testDatabasePath ?? null;
    this.timeoutMs_ = options.statementTimeoutMs ?? 60_000;
    this.worker_ = new Worker(resolve(__dirname, 'sync-worker.js'), {
      workerData: {
        connectionString: options.connectionString,
        schema: this.schema,
        createSchema: options.createSchema ?? false,
        readOnly: options.readOnly ?? false,
        applicationName: options.applicationName ?? 'rewind',
        ssl: options.ssl ?? null,
        flag: shared,
        port: port2,
      },
      transferList: [port2],
    });
    // An idle bridge must not keep a finished CLI command alive.
    this.worker_.unref();
    port1.unref();
  }

  get isOpen(): boolean {
    return this.worker_ !== null;
  }

  private call_(request: BridgeRequest): { rows: Row[]; rowCount: number } {
    if (!this.worker_) throw new Error('database is not open');
    Atomics.store(this.flag_, 0, 0);
    this.port_.postMessage(request);
    const waited = Atomics.wait(this.flag_, 0, 0, this.timeoutMs_);
    if (waited === 'timed-out') {
      // The worker may still finish; the connection state is unknown, so
      // retire this bridge rather than reuse it.
      void this.worker_.terminate();
      this.worker_ = null;
      throw new Error(`PostgreSQL did not answer within ${this.timeoutMs_} ms`);
    }
    let message = receiveMessageOnPort(this.port_);
    while (!message) {
      // postMessage happens before the flag flips; this is a defensive spin.
      Atomics.wait(this.flag_, 0, 2, 1);
      message = receiveMessageOnPort(this.port_);
    }
    const response = message.message as BridgeResponse;
    if (!response.ok) throw new PostgresDatabaseError(response.error);
    return response;
  }

  query(source: string, params: Params): { rows: Row[]; rowCount: number } {
    const busy = /^\s*PRAGMA\s+busy_timeout\s*=\s*(\d+)\s*;?\s*$/i.exec(source);
    if (busy) {
      this.call_({ type: 'busy-timeout', milliseconds: Number(busy[1]) });
      return { rows: [], rowCount: 0 };
    }
    const translated = translate(source);
    if (params.length !== translated.parameterCount) {
      throw new RangeError(
        `Expected ${translated.parameterCount} parameters but received ${params.length}`,
      );
    }
    // SQLite values carry their own type; give PostgreSQL the same by
    // binding numbers as typed parameters instead of untyped text.
    let sql = translated.parts[0];
    params.forEach((value, index) => {
      let cast = '';
      if (typeof value === 'number') {
        cast = Number.isInteger(value) ? '::bigint' : '::double precision';
      } else if (typeof value === 'bigint') {
        cast = '::bigint';
      } else if (value instanceof Uint8Array) {
        cast = '::bytea';
      } else if (value === null || typeof value === 'string') {
        if (translated.nullChecks[index]) cast = '::text';
      } else {
        throw new TypeError(`Provided value cannot be bound to SQLite parameter: ${String(value)}`);
      }
      sql += `$${index + 1}${cast}${translated.parts[index + 1]}`;
    });
    const result = this.call_({ type: 'query', kind: translated.kind, sql, params });
    return {
      rows: result.rows.map((row) => nullPrototypeRow(row, translated.columnNames)),
      rowCount: result.rowCount,
    };
  }

  prepare(sql: string): PostgresStatement {
    return new PostgresStatement(this, sql);
  }

  exec(sql: string): void {
    for (const statement of splitStatements(sql)) this.query(statement, []);
  }

  /** Run PostgreSQL-native SQL (for example a migration file) untranslated. */
  execNative(sql: string): void {
    this.call_({ type: 'query', kind: 'ddl', sql, params: [] });
  }

  /** Run a PostgreSQL-native query with $n parameters, untranslated. */
  queryNative(sql: string, params: Params = []): Row[] {
    return this.call_({ type: 'query', kind: 'read', sql, params }).rows.map((row) =>
      nullPrototypeRow(row, new Map()),
    );
  }

  close(): void {
    if (!this.worker_) throw new Error('database is not open');
    try {
      this.call_({ type: 'close' });
    } finally {
      void this.worker_?.terminate();
      this.worker_ = null;
      this.port_.close();
    }
  }
}
