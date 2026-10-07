// Messages between PostgresDatabase (main thread) and its sync worker.

export type StatementKind =
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'rollback-to'
  | 'savepoint'
  | 'release'
  | 'read'
  | 'write'
  | 'ddl'
  | 'noop';

export type BridgeRequest =
  | { type: 'query'; kind: StatementKind; sql: string; params: unknown[] }
  | { type: 'busy-timeout'; milliseconds: number }
  | { type: 'close' };

export interface BridgeError {
  message: string;
  code?: string;
  table?: string;
  column?: string;
  constraint?: string;
  detail?: string;
}

export type BridgeResponse =
  | { ok: true; rows: Record<string, unknown>[]; rowCount: number }
  | { ok: false; error: BridgeError };
