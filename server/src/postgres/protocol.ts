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
  | {
      type: 'query';
      kind: StatementKind;
      sql: string;
      params: unknown[];
      /** sql holds its values as literals: send it in one batched round trip. */
      inline?: boolean;
    }
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
  | { ok: true; rows: Record<string, unknown>[]; rowCount: number; roundTrips?: number }
  | { ok: false; error: BridgeError; roundTrips?: number };
