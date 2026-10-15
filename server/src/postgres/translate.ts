// Rewrites Rewind's SQLite-dialect statements for PostgreSQL. The server's
// SQL is portable except for a small, inventoried set of SQLite idioms that
// are rewritten here so both engines run the same source text.
import type { StatementKind } from './protocol';

type Token =
  | { type: 'word'; text: string; upper: string }
  | { type: 'param'; text: string }
  | { type: 'string'; text: string }
  | { type: 'quoted'; text: string }
  | { type: 'space'; text: string }
  | { type: 'punct'; text: string };

export interface TranslatedStatement {
  /** SQL text around each parameter: parts.length === parameterCount + 1. */
  parts: string[];
  /** Per parameter: used only as `? IS [NOT] NULL`, so it needs a type. */
  nullChecks: boolean[];
  kind: StatementKind;
  /** Count of positional parameters the statement expects. */
  parameterCount: number;
  /** PostgreSQL folds unquoted names to lower case; maps them back. */
  columnNames: Map<string, string>;
}

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;
const NUMBER = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /\s/.test(sql[j])) j += 1;
      tokens.push({ type: 'space', text: sql.slice(i, j) });
      i = j;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const j = end === -1 ? sql.length : end;
      tokens.push({ type: 'space', text: ' ' });
      i = j;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const j = end === -1 ? sql.length : end + 2;
      tokens.push({ type: 'space', text: ' ' });
      i = j;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j += 1;
      }
      const text = sql.slice(i, j + 1);
      if (c === "'") tokens.push({ type: 'string', text });
      else tokens.push({ type: 'quoted', text: `"${text.slice(1, -1).replaceAll('""', '"')}"` });
      i = j + 1;
    } else if (c === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      // PostgreSQL dollar-quoted body (functions in test fixtures).
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      const j = end === -1 ? sql.length : end + tag.length;
      tokens.push({ type: 'string', text: sql.slice(i, j) });
      i = j;
    } else if (c === '?') {
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j])) j += 1;
      if (j > i + 1) throw new Error('Numbered ?NNN parameters are not supported on PostgreSQL.');
      tokens.push({ type: 'param', text: '?' });
      i = j;
    } else {
      WORD.lastIndex = i;
      NUMBER.lastIndex = i;
      const word = WORD.exec(sql);
      if (word) {
        tokens.push({ type: 'word', text: word[0], upper: word[0].toUpperCase() });
        i += word[0].length;
        continue;
      }
      const number = NUMBER.exec(sql);
      if (number) {
        tokens.push({ type: 'punct', text: number[0] });
        i += number[0].length;
        continue;
      }
      if ((c === ':' || c === '@' || c === '$') && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
        throw new Error('Named parameters are not supported on PostgreSQL.');
      }
      const two = sql.slice(i, i + 2);
      if (['||', '<=', '>=', '<>', '!=', '=='].includes(two)) {
        tokens.push({ type: 'punct', text: two === '==' ? '=' : two });
        i += 2;
      } else {
        tokens.push({ type: 'punct', text: c });
        i += 1;
      }
    }
  }
  return tokens;
}

/** Split a script into statements on top-level semicolons. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let blockDepth = 0;
  for (const token of tokenize(sql)) {
    if (token.type === 'word' && token.upper === 'CASE') blockDepth += 1;
    if (token.type === 'word' && token.upper === 'END' && blockDepth > 0) blockDepth -= 1;
    if (token.type === 'punct' && token.text === '(') depth += 1;
    if (token.type === 'punct' && token.text === ')') depth -= 1;
    if (token.type === 'punct' && token.text === ';' && depth === 0 && blockDepth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += token.text;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function significant(tokens: Token[], from: number, step: 1 | -1): number {
  let i = from;
  while (i >= 0 && i < tokens.length && tokens[i].type === 'space') i += step;
  return i;
}

function isWord(token: Token | undefined, ...words: string[]): boolean {
  return token?.type === 'word' && words.includes(token.upper);
}

function classify(tokens: Token[]): StatementKind {
  const words = tokens.filter((t): t is Extract<Token, { type: 'word' }> => t.type === 'word');
  const first = words[0]?.upper;
  switch (first) {
    case 'BEGIN':
      return 'begin';
    case 'COMMIT':
    case 'END':
      return 'commit';
    case 'ROLLBACK':
      return words.some((w) => w.upper === 'TO') ? 'rollback-to' : 'rollback';
    case 'SAVEPOINT':
      return 'savepoint';
    case 'RELEASE':
      return 'release';
    case 'PRAGMA':
    case 'VACUUM':
    case 'ANALYZE':
      return 'noop';
    case 'SELECT':
    case 'VALUES':
    case 'EXPLAIN':
    case 'SHOW':
      return 'read';
    case 'WITH':
      return words.some((w) => ['INSERT', 'UPDATE', 'DELETE'].includes(w.upper)) ? 'write' : 'read';
    case 'INSERT':
    case 'UPDATE':
    case 'DELETE':
    case 'REPLACE':
      return 'write';
    default:
      return 'ddl';
  }
}

/** Index of the matching close parenthesis for the open one at `open`. */
function closing(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'punct' && t.text === '(') depth += 1;
    if (t.type === 'punct' && t.text === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hasTopLevelComma(tokens: Token[], open: number, close: number): boolean {
  let depth = 0;
  for (let i = open + 1; i < close; i += 1) {
    const t = tokens[i];
    if (t.type === 'punct' && t.text === '(') depth += 1;
    if (t.type === 'punct' && t.text === ')') depth -= 1;
    if (depth === 0 && t.type === 'punct' && t.text === ',') return true;
  }
  return false;
}

const ORDER_END = new Set(['LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'RETURNING']);

/** SQLite sorts NULL first ascending; PostgreSQL sorts it last. */
function addNullOrdering(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    out.push(t);
    i += 1;
    if (!(isWord(t, 'BY') && isWord(tokens[significant(tokens, i - 2, -1)], 'ORDER'))) continue;
    // Walk the ORDER BY list at this depth, closing each item.
    let depth = 0;
    let direction: 'ASC' | 'DESC' = 'ASC';
    let explicitNulls = false;
    const finishItem = () => {
      if (!explicitNulls) {
        out.push({ type: 'space', text: ' ' });
        out.push({
          type: 'word',
          text: direction === 'ASC' ? 'NULLS FIRST' : 'NULLS LAST',
          upper: 'NULLS',
        });
      }
      direction = 'ASC';
      explicitNulls = false;
    };
    while (i < tokens.length) {
      const u = tokens[i];
      if (u.type === 'punct' && u.text === '(') depth += 1;
      if (u.type === 'punct' && u.text === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      if (depth === 0 && ((u.type === 'punct' && u.text === ';') || isWord(u, ...ORDER_END))) break;
      if (depth === 0 && u.type === 'punct' && u.text === ',') {
        // Keep trailing whitespace before the comma on the item.
        finishItem();
        out.push(u);
        i += 1;
        continue;
      }
      if (depth === 0 && isWord(u, 'DESC')) direction = 'DESC';
      if (depth === 0 && isWord(u, 'ASC')) direction = 'ASC';
      if (depth === 0 && isWord(u, 'NULLS')) explicitNulls = true;
      out.push(u);
      i += 1;
    }
    // Trailing whitespace belongs after the NULLS clause.
    const trailing: Token[] = [];
    while (out.length && out[out.length - 1].type === 'space') trailing.unshift(out.pop()!);
    finishItem();
    out.push(...trailing);
  }
  return out;
}

const cache = new Map<string, TranslatedStatement>();

export function translate(sql: string): TranslatedStatement {
  const cached = cache.get(sql);
  if (cached) return cached;
  let tokens = tokenize(sql);
  const kind = classify(tokens);
  const columnNames = new Map<string, string>();
  for (const t of tokens) {
    if (t.type === 'word' && t.text !== t.text.toLowerCase() && t.text !== t.upper) {
      columnNames.set(t.text.toLowerCase(), t.text);
    }
  }

  const out: Token[] = [];
  let insertOrIgnore = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'word') {
      const next = significant(tokens, i + 1, 1);
      // INSERT OR IGNORE INTO → INSERT INTO … ON CONFLICT DO NOTHING
      if (t.upper === 'INSERT' && isWord(tokens[next], 'OR')) {
        const action = significant(tokens, next + 1, 1);
        if (isWord(tokens[action], 'IGNORE')) {
          insertOrIgnore = true;
          out.push(t);
          i = action;
          continue;
        }
        throw new Error('INSERT OR REPLACE/ABORT is not portable; use ON CONFLICT … DO UPDATE.');
      }
      if (t.upper === 'IFNULL') {
        out.push({ type: 'word', text: 'COALESCE', upper: 'COALESCE' });
        continue;
      }
      if (
        (t.upper === 'MAX' || t.upper === 'MIN') &&
        tokens[next]?.type === 'punct' &&
        tokens[next].text === '('
      ) {
        const close = closing(tokens, next);
        if (close > 0 && hasTopLevelComma(tokens, next, close)) {
          const name = t.upper === 'MAX' ? 'GREATEST' : 'LEAST';
          out.push({ type: 'word', text: name, upper: name });
          continue;
        }
      }
      if (t.upper === 'LIKE') {
        out.push({ type: 'word', text: 'ILIKE', upper: 'ILIKE' });
        continue;
      }
      if (t.upper === 'GLOB') {
        throw new Error('GLOB is not portable to PostgreSQL.');
      }
      // CAST(x AS INTEGER) would overflow on epoch milliseconds.
      if (
        t.upper === 'INTEGER' &&
        isWord(tokens[significant(tokens, i - 1, -1)], 'AS') &&
        kind !== 'ddl'
      ) {
        out.push({ type: 'word', text: 'BIGINT', upper: 'BIGINT' });
        continue;
      }
      // LIMIT -1 means no limit in SQLite.
      if (t.upper === 'LIMIT') {
        const minus = tokens[next];
        const one = tokens[significant(tokens, next + 1, 1)];
        if (minus?.type === 'punct' && minus.text === '-' && one?.text === '1') {
          out.push({ type: 'word', text: 'LIMIT ALL', upper: 'LIMIT' });
          i = significant(tokens, next + 1, 1);
          continue;
        }
      }
      // SQLite's IS / IS NOT compare any values null-safely.
      if (t.upper === 'IS') {
        let operand = next;
        let negated = false;
        if (isWord(tokens[operand], 'NOT')) {
          negated = true;
          operand = significant(tokens, operand + 1, 1);
        }
        if (tokens[operand]?.type === 'param') {
          out.push({
            type: 'word',
            text: negated ? 'IS DISTINCT FROM ' : 'IS NOT DISTINCT FROM ',
            upper: 'IS',
          });
          i = operand - 1;
          continue;
        }
      }
    }
    out.push(t);
  }
  tokens = kind === 'read' || kind === 'write' ? addNullOrdering(out) : out;

  let parameterCount = 0;
  let text = '';
  const parts: string[] = [];
  const nullChecks: boolean[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'param') {
      parameterCount += 1;
      // A bare `? IS [NOT] NULL` gives PostgreSQL no type to infer.
      const after = significant(tokens, i + 1, 1);
      let operand = significant(tokens, after + 1, 1);
      if (isWord(tokens[operand], 'NOT')) operand = significant(tokens, operand + 1, 1);
      const bare = isWord(tokens[after], 'IS') && isWord(tokens[operand], 'NULL');
      parts.push(text);
      nullChecks.push(bare);
      text = '';
      continue;
    }
    text += t.text;
  }
  if (insertOrIgnore) {
    if (/\bRETURNING\b/i.test(text))
      throw new Error('INSERT OR IGNORE … RETURNING is not supported.');
    text = text.replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }
  parts.push(text);
  const translated = { parts, nullChecks, kind, parameterCount, columnNames };
  if (cache.size > 5000) cache.clear();
  cache.set(sql, translated);
  return translated;
}
