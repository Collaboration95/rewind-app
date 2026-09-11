import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { findArchitectureViolations } = await import('../scripts/check-architecture.mjs');

test('repository architecture boundaries are platform-safe', () => {
  assert.deepEqual(findArchitectureViolations(process.cwd()), []);
});

test('architecture guard rejects framework imports in domain and device imports in routes', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rewind-architecture-'));
  try {
    await mkdir(join(projectRoot, 'src/domain'), { recursive: true });
    await mkdir(join(projectRoot, 'src/routes'), { recursive: true });
    await writeFile(join(projectRoot, 'src/domain/bad.ts'), "import React from 'react';\n");
    await writeFile(
      join(projectRoot, 'src/routes/bad.ts'),
      "import { Camera } from 'expo-camera';\n",
    );
    const violations = findArchitectureViolations(projectRoot);
    assert.equal(violations.length, 2);
    assert.match(violations[0].message, /framework-free/);
    assert.match(violations[1].message, /Expo\/device/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
