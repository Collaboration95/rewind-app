import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import test from 'node:test';

import { runtimeRoots } from '../scripts/runtime-dependencies.mjs';

// The runtime image copies only these packages (and their locked closure), so
// an import in server/src that is not listed crashes the hosted server on start.
test('every external package the server imports is a packaged runtime root', () => {
  const imported = new Set();
  for (const file of globSync('server/src/**/*.ts')) {
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(
      /^(?:import|export)\b[^;'"]*?\bfrom\s+['"]([A-Za-z0-9@._/-]+)['"]/gm,
    )) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      if (builtinModules.includes(specifier)) continue;
      const parts = specifier.split('/');
      imported.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }
  assert.ok(imported.size > 0);
  for (const name of imported) {
    assert.ok(runtimeRoots.includes(name), `${name} is imported by server/src but not packaged`);
  }
});
