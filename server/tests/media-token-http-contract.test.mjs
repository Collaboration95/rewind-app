import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { MEDIA_CAPABILITY_TTL_MS } from '../dist/archive/capabilities.js';
import { withBoundaryRuntime } from './helpers/boundary-runtime.mjs';

async function withReleasedClip(run) {
  await withBoundaryRuntime(async (c) => {
    const owner = await c.account('token-http-owner');
    const group = await c.group(owner);
    const bytes = await readFile(new URL('../fixtures/sample-clip.mp4', import.meta.url));
    const outputPath = resolve(c.dataDir, 'media/processed/token-clip.mp4');
    await mkdir(resolve(c.dataDir, 'media/processed'), { recursive: true });
    await writeFile(outputPath, bytes);
    c.database
      .prepare(
        'INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at) VALUES (?, ?, ?, 3, ?)',
      )
      .run('token-contribution', group.cycle.id, group.memberId, c.now().toISOString());
    c.database
      .prepare(
        `INSERT INTO media_jobs (id, group_id, contribution_id, kind, status, output_path, created_at, output_sha256, output_bytes, output_verified_at)
      VALUES (?, ?, ?, 'clip', 'ready', ?, ?, ?, ?, ?)`,
      )
      .run(
        'token-clip',
        group.group.id,
        'token-contribution',
        outputPath,
        c.now().toISOString(),
        createHash('sha256').update(bytes).digest('hex'),
        bytes.length,
        c.now().toISOString(),
      );
    const archivePath = `/archive?groupId=${group.group.id}`;
    const sealed = await c.request(archivePath, { actor: owner });
    assert.equal(sealed.status, 200);
    assert.deepEqual((await sealed.json()).archive.clips, []);
    c.database
      .prepare(
        "UPDATE cycles SET status = 'revealing', release_status = 'published', release_published_at = ? WHERE id = ?",
      )
      .run(c.now().toISOString(), group.cycle.id);
    const archive = await c.request(archivePath, { actor: owner });
    assert.equal(archive.status, 200);
    const clip = (await archive.json()).archive.clips[0];
    assert.equal(clip.id, 'token-clip');
    assert.match(clip.downloadPath, /^\/media\/access\/[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(JSON.stringify(clip), new RegExp(`${owner.token}|${outputPath}`));
    await run({ ...c, createGroup: c.group, owner, group, bytes, clip });
  });
}

test('token downloads support suffix, open-ended and clamped ranges with exact bytes and empty HEAD bodies', async () => {
  await withReleasedClip(async (c) => {
    const head = await c.request(c.clip.downloadPath, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(c.bytes.length));
    assert.match(head.headers.get('content-disposition'), /^attachment;/);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const [range, start, end] of [
      ['bytes=-17', c.bytes.length - 17, c.bytes.length - 1],
      [`bytes=${c.bytes.length - 9}-`, c.bytes.length - 9, c.bytes.length - 1],
      [
        `bytes=${c.bytes.length - 5}-${c.bytes.length + 100}`,
        c.bytes.length - 5,
        c.bytes.length - 1,
      ],
    ]) {
      const response = await c.request(c.clip.downloadPath, { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(
        response.headers.get('content-range'),
        `bytes ${start}-${end}/${c.bytes.length}`,
      );
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), c.bytes.subarray(start, end + 1));
    }
    for (const range of [
      'items=0-1',
      'bytes=-',
      'bytes=-0',
      'bytes=20-10',
      'bytes=0-1,3-4',
      'bytes=9007199254740992-',
    ]) {
      const response = await c.request(c.clip.downloadPath, { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('content-range'), `bytes */${c.bytes.length}`);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
    const whole = await c.request(c.clip.downloadPath);
    assert.equal(whole.status, 200);
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), c.bytes);
  });
});

test('captured media tokens recheck selected group, session revocation and their exact expiry', async () => {
  await withReleasedClip(async (c) => {
    const outsider = await c.account('token-http-outsider');
    const denied = await c.request(c.clip.downloadPath, { actor: outsider });
    assert.equal(denied.status, 404);
    assert.doesNotMatch(await denied.text(), /token-contribution|token-clip|processed/);
    await c.createGroup(c.owner, { name: 'Another selected group' });
    assert.equal((await c.request(c.clip.downloadPath)).status, 404);
    assert.equal(
      (await c.post('/real/groups/current', c.owner, { groupId: c.group.group.id })).status,
      200,
    );
    const restored = await c.request(c.clip.downloadPath, { method: 'HEAD' });
    assert.equal(restored.status, 200);
    c.setNow(new Date(c.now().getTime() + MEDIA_CAPABILITY_TTL_MS));
    assert.equal((await c.request(c.clip.downloadPath, { method: 'HEAD' })).status, 404);
    const archive = await c.request(`/archive?groupId=${c.group.group.id}`, { actor: c.owner });
    assert.equal(archive.status, 200);
    const renewed = (await archive.json()).archive.clips[0].downloadPath;
    assert.notEqual(renewed, c.clip.downloadPath);
    assert.equal((await c.request(renewed, { method: 'HEAD' })).status, 200);
    assert.equal((await c.post('/auth/logout', c.owner)).status, 200);
    assert.equal((await c.request(renewed)).status, 404);
  });
});
