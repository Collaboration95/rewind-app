import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { hashFileSync } = await import('../dist/media/integrity.js');

test('hashFileSync hashes regular files and refuses symlink paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rewind-integrity-race-'));
  try {
    const target = join(directory, 'target.bin');
    const link = join(directory, 'link.bin');
    const contents = Buffer.from('stable-integrity-payload');
    await writeFile(target, contents);
    await symlink(target, link);

    assert.deepEqual(hashFileSync(target), {
      sha256: createHash('sha256').update(contents).digest('hex'),
      byteLength: contents.length,
    });
    assert.equal(hashFileSync(link), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
