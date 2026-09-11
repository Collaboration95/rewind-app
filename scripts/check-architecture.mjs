import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs']);
const BARE_IMPORT = /(?:from\s*|import\s*\(|require\s*\()(['"])([^'"]+)\1/g;
const PLATFORM_IMPORT = /^(?:expo(?:-|$)|react-native(?:-|$)|@react-native(?:\/|$)|react-native-)/;

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) files.push(path);
  }
  return files;
}

function importsIn(source) {
  return [...source.matchAll(BARE_IMPORT)].map((match) => match[2]);
}

/**
 * Scan the architectural boundaries that must remain platform-independent.
 * `src/routes` is optional today, but the rule applies as soon as route
 * modules are introduced. A `*.route.*` suffix is covered for colocated
 * route modules as well.
 */
export function findArchitectureViolations(projectRoot) {
  const roots = [
    { directory: resolve(projectRoot, 'src/domain'), kind: 'domain' },
    // `engine.ts` is the pure server-side domain module. The sibling
    // `index.ts` is an application service that owns SQLite/event adapters.
    { directory: resolve(projectRoot, 'server/src/cycles/engine.ts'), kind: 'domain' },
    { directory: resolve(projectRoot, 'src/routes'), kind: 'route' },
  ];
  const violations = [];
  for (const { directory, kind } of roots) {
    const files = directory.endsWith('.ts')
      ? existsSync(directory)
        ? [directory]
        : []
      : walk(directory);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importsIn(source)) {
        const isBare = !specifier.startsWith('.') && !specifier.startsWith('/');
        if (kind === 'domain' && isBare) {
          violations.push({
            file: relative(projectRoot, file),
            message: `Domain modules may only import relative framework-free modules (found ${specifier}).`,
          });
        }
        if (kind === 'route' && PLATFORM_IMPORT.test(specifier)) {
          violations.push({
            file: relative(projectRoot, file),
            message: `Route modules may not import Expo/device packages directly (found ${specifier}).`,
          });
        }
      }
    }
  }

  // Also cover route modules colocated outside src/routes without treating
  // ordinary UI components as routes merely because they import React Native.
  for (const file of walk(resolve(projectRoot, 'src')).filter((path) =>
    /\.route\.[cm]?[jt]sx?$/.test(path),
  )) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importsIn(source)) {
      if (PLATFORM_IMPORT.test(specifier)) {
        violations.push({
          file: relative(projectRoot, file),
          message: `Route modules may not import Expo/device packages directly (found ${specifier}).`,
        });
      }
    }
  }
  return violations;
}

export function main(projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')) {
  const violations = findArchitectureViolations(projectRoot);
  if (violations.length > 0) {
    console.error('Architecture checks failed:');
    for (const violation of violations) console.error(`- ${violation.file}: ${violation.message}`);
    return 1;
  }
  console.log('Architecture checks passed: domain and route boundaries are platform-safe.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv[2] ? resolve(process.argv[2]) : resolve('.'));
}
