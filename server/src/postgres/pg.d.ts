// The small part of node-postgres (pg) the sync bridge and its test runner
// use. A local declaration avoids @types/pg, whose @types/node dependency
// would change the app's DOM timer typings.
declare module 'pg' {
  interface QueryResult {
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }
  interface ClientConfig {
    connectionString?: string;
    application_name?: string;
    ssl?: { rejectUnauthorized: boolean; ca?: string };
    connectionTimeoutMillis?: number;
    keepAlive?: boolean;
  }
  class Client {
    constructor(config?: ClientConfig);
    connect(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    // A parameterless multi-statement script answers with one result each.
    query(config: { text: string; values?: unknown[] }): Promise<QueryResult | QueryResult[]>;
    end(): Promise<void>;
    on(event: 'error', listener: (error: Error) => void): this;
  }
  const pg: {
    Client: typeof Client;
    types: {
      builtins: { INT8: number; NUMERIC: number; BOOL: number };
      setTypeParser(oid: number, parse: (value: string) => unknown): void;
    };
  };
  export default pg;
  export type { Client };
}
