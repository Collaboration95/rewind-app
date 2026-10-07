import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { RuntimeConfig } from './config';
import { isPostgres, type RewindDatabase } from './db';

// Read-only table browser for the team (#261 follow-up). One shared login
// (user "admin", password REWIND_ADMIN_PASSWORD) via the browser's Basic auth
// prompt. Only fixed SELECTs run, so it cannot change data.
const PAGE_SIZE = 50;
const MAX_CELL = 200;
// Credentials and anything that would let a viewer act as a user stay hidden.
const SECRET_COLUMN = /hash|salt|token|secret|password|destination_json|device_key/i;

export function handleAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  database: RewindDatabase,
  url: URL,
  transportIsSecure: boolean,
): void {
  if (!config.adminPassword || request.method !== 'GET') return send(response, 404, 'Not found.');
  if (!transportIsSecure) return send(response, 403, 'Use the HTTPS address.');
  if (!credentialsMatch(request.headers.authorization, config.adminPassword)) {
    response.setHeader('WWW-Authenticate', 'Basic realm="Rewind admin", charset="UTF-8"');
    return send(response, 401, 'Sign in required.');
  }
  // Relative links below assume the index ends in "/", so the same page works
  // at /admin/ locally and /api/admin/ behind nginx.
  if (url.pathname === '/admin') {
    response.writeHead(302, { Location: 'admin/', 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  const tables = (
    database
      .prepare(
        isPostgres(database)
          ? `SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY name`
          : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  if (url.pathname === '/admin/') return send(response, 200, indexPage(database, tables));
  const match = /^\/admin\/t\/([^/]+)$/.exec(url.pathname);
  const table = match ? decodeURIComponent(match[1]) : null;
  // The name is only used after it matches a real table, then quoted.
  if (!table || !tables.includes(table)) return send(response, 404, 'Not found.');
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  send(response, 200, tablePage(database, table, page));
}

function credentialsMatch(header: string | undefined, password: string): boolean {
  const encoded = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '')?.[1];
  if (!encoded) return false;
  // Same comparison as the origin secret check in http.ts.
  const expected = Buffer.from(`admin:${password}`);
  const received = Buffer.from(encoded, 'base64');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function indexPage(database: RewindDatabase, tables: string[]): string {
  const rows = tables
    .map((name) => {
      const { count } = database.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get() as {
        count: number;
      };
      return `<tr><td><a href="t/${encodeURIComponent(name)}">${escape(name)}</a></td><td>${count}</td></tr>`;
    })
    .join('');
  return layout('Tables', `<table><tr><th>Table</th><th>Rows</th></tr>${rows}</table>`);
}

function tablePage(database: RewindDatabase, table: string, page: number): string {
  const { count } = database.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as {
    count: number;
  };
  const postgres = isPostgres(database);
  const columns = (
    database
      .prepare(
        postgres
          ? `SELECT column_name AS name FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`
          : `SELECT name FROM pragma_table_info(?)`,
      )
      .all(table) as { name: string }[]
  ).map((column) => column.name);
  // Newest first: SQLite's rowid, or PostgreSQL's physical row order.
  const rows = database
    .prepare(
      `SELECT * FROM ${quote(table)} ORDER BY ${postgres ? 'ctid' : 'rowid'} DESC LIMIT ? OFFSET ?`,
    )
    .all(PAGE_SIZE, (page - 1) * PAGE_SIZE) as Record<string, unknown>[];
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const head = columns.map((column) => `<th>${escape(column)}</th>`).join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${columns.map((column) => `<td>${cell(table, column, row[column])}</td>`).join('')}</tr>`,
    )
    .join('');
  const nav = [
    page > 1 ? `<a href="?page=${page - 1}">← Newer</a>` : '',
    `Page ${page} of ${pages} · ${count} rows, newest first`,
    page < pages ? `<a href="?page=${page + 1}">Older →</a>` : '',
  ].join(' ');
  return layout(
    table,
    `<p><a href="../">← All tables</a></p><p>${nav}</p><div class="scroll"><table><tr>${head}</tr>${body}</table></div>`,
  );
}

function cell(table: string, column: string, value: unknown): string {
  if (value === null || value === undefined) return '<i>null</i>';
  // Demo session ids are bearer credentials in the Demo API.
  if (SECRET_COLUMN.test(column) || (table === 'sessions' && column === 'id'))
    return '<i>hidden</i>';
  if (value instanceof Uint8Array) return `<i>${value.byteLength} bytes</i>`;
  const text = String(value);
  return escape(text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text);
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function escape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Rewind admin</title><style>body{font:14px system-ui,sans-serif;margin:16px;color:#111;background:#fff}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top;white-space:nowrap}th{background:#f4f4f4;position:sticky;top:0}.scroll{overflow-x:auto}i{color:#888}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}th{background:#222}th,td{border-color:#333}a{color:#8ab4f8}}</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

function send(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(status === 200 ? html : layout('Rewind admin', `<p>${escape(html)}</p>`));
}
