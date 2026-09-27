import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONTRIBUTION_STATUS_COPY } from '../src/capture/contribution-status';
import {
  DEBUG_SCENARIO_HINTS,
  DEBUG_SCENARIO_LABELS,
  DEBUG_SCREEN_LABELS,
} from '../src/debug/scenarios';
import { BUILT_IN_PROMPTS } from '../src/domain/groups';
import {
  getRevealEducationCopy,
  type RevealEducationState,
  type RevealEducationSurface,
} from '../src/domain/reveal-education';
import { hasTranslation, translate } from '../src/i18n/translate';
import { ROUTES } from '../src/shell/AppChrome';

const root = join(__dirname, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** String literals inside the first argument of every `t(...)` call. */
function translatedLiterals(source: string): string[] {
  const found: string[] = [];
  const call = /(?<![\w.$])t\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source))) {
    let depth = 1;
    let index = match.index + match[0].length;
    let quote: string | null = null;
    let comparison = false;
    let current = '';
    for (; index < source.length && depth > 0; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') {
          current += source[index + 1];
          index += 1;
        } else if (char === quote) {
          // `state === 'released' ? … : …` compares a value; it is not copy.
          if (!comparison) found.push(current);
          quote = null;
          current = '';
        } else current += char;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        comparison = /[=!]==\s*$/.test(source.slice(Math.max(0, index - 6), index));
      } else if (char === '`') break;
      else if (char === '(' || char === '{' || char === '[') depth += 1;
      else if (char === ')' || char === '}' || char === ']') depth -= 1;
      else if (char === ',' && depth === 1) break;
    }
  }
  return found;
}

/** Quoted literals in an expression, skipping `x === 'value'` comparisons. */
function literalsIn(expression: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < expression.length; index += 1) {
    const quote = expression[index];
    if (quote !== "'" && quote !== '"') continue;
    const comparison = /[=!]==\s*$/.test(expression.slice(Math.max(0, index - 6), index));
    let value = '';
    index += 1;
    for (; index < expression.length && expression[index] !== quote; index += 1) {
      if (expression[index] === '\\') index += 1;
      value += expression[index];
    }
    if (!comparison) found.push(value);
  }
  return found;
}

/** Literal copy handed to components that translate their own props. */
function propLiterals(source: string): string[] {
  const found: string[] = [];
  const props = /\b(?:title|body|actionLabel|retryLabel|deleteLabel)=(?:"([^"]*)"|\{)/g;
  let match: RegExpExecArray | null;
  while ((match = props.exec(source))) {
    if (match[1] !== undefined) {
      found.push(match[1]);
      continue;
    }
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    for (; index < source.length && depth > 0; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
    }
    const expression = source.slice(start, index - 1);
    if (/^\s*t\(/.test(expression) || expression.includes('t(')) continue;
    found.push(...literalsIn(expression));
  }
  for (const call of source.matchAll(
    /set(?:Feedback|CodeError|DebugNotice|DownloadNotice)\(\s*'([^']+)'/g,
  )) {
    found.push(call[1]);
  }
  return found;
}

describe('Chinese copy coverage', () => {
  it('translates every literal passed to t()', () => {
    const files = [join(root, 'App.tsx'), ...sourceFiles(join(root, 'src'))];
    const missing = files.flatMap((file) =>
      [
        ...translatedLiterals(readFileSync(file, 'utf8')),
        ...propLiterals(readFileSync(file, 'utf8')),
      ]
        .filter((text) => !hasTranslation(text))
        .map((text) => `${file.replace(root, '')}: ${text}`),
    );
    expect(missing).toEqual([]);
  });

  it('translates copy tables that screens pass through t()', () => {
    const surfaces: RevealEducationSurface[] = ['home', 'capture', 'archive'];
    const states: RevealEducationState[] = ['locked', 'processing', 'delayed', 'released'];
    const tableCopy = [
      ...surfaces.flatMap((surface) =>
        states.flatMap((state) => Object.values(getRevealEducationCopy(surface, state))),
      ),
      ...Object.values(DEBUG_SCREEN_LABELS),
      ...Object.values(DEBUG_SCENARIO_LABELS),
      ...Object.values(DEBUG_SCENARIO_HINTS).flatMap((hints) => Object.values(hints ?? {})),
      ...ROUTES.map((route) => route.label),
      ...BUILT_IN_PROMPTS,
      ...CONTRIBUTION_STATUS_COPY,
    ].filter((text): text is string => typeof text === 'string');
    expect(tableCopy.filter((text) => !hasTranslation(text))).toEqual([]);
  });

  it('keeps English as the source and interpolates both languages', () => {
    expect(translate('en', '{count} contributions', { count: 3 })).toBe('3 contributions');
    expect(translate('zh', '{count} contributions', { count: 3 })).toBe('剩余 3 次贡献');
    expect(translate('zh', 'An unlisted server message.')).toBe('An unlisted server message.');
  });
});
