import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderSecurityHeaders } from '../deploy/render-security-headers.mjs';

const template = new URL('../deploy/security-headers.conf', import.meta.url);

test('CSP authorises exact inline bytes from every HTML page and excludes external scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rewind-csp-'));
  const body = '\n window.fixture = true;\n';
  try {
    await mkdir(join(root, 'legal'));
    await writeFile(
      join(root, 'index.html'),
      `<script>${body}</script><script src="/bundle.js"></script>`,
    );
    await writeFile(
      join(root, 'legal', 'page.html'),
      `<script>${body}</script><script>other()</script>`,
    );
    const output = join(root, 'headers.conf');
    await renderSecurityHeaders(root, template, output);
    const headers = await readFile(output, 'utf8');
    const hash = createHash('sha256').update(body).digest('base64');
    assert.ok(headers.includes(`'sha256-${hash}'`));
    assert.equal((headers.match(/'sha256-/g) ?? []).length, 2);
    assert.doesNotMatch(headers, /__SCRIPT_HASHES__|script-src[^;]*unsafe-inline|unsafe-eval/);
    assert.match(headers, /style-src 'self' 'unsafe-inline'/);
    assert.match(headers, /connect-src 'self' blob: __UPLOAD_ORIGIN__/);
    await writeFile(join(root, 'index.html'), `<script>${body}attacker()</script>`);
    await writeFile(join(root, 'legal', 'page.html'), 'no script');
    await renderSecurityHeaders(root, template, output);
    assert.ok(!(await readFile(output, 'utf8')).includes(`'sha256-${hash}'`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'web startup permits only the configured exact S3 endpoint and refuses header injection',
  { skip: !process.env.REWIND_NGINX_TEST_IMAGE },
  () => {
    const probe = (environment) =>
      spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--pull=never',
          '--read-only',
          '--tmpfs',
          '/tmp:rw,mode=1777',
          ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
          '--entrypoint',
          '/bin/sh',
          process.env.REWIND_NGINX_TEST_IMAGE,
          '-c',
          '/docker-entrypoint.d/40-security-headers.sh && cat /tmp/security-headers.conf',
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
    const disk = probe({ REWIND_MEDIA_BACKEND: 'disk' });
    assert.equal(disk.status, 0, disk.stderr);
    assert.match(disk.stdout, /connect-src 'self' blob: ;/);
    assert.doesNotMatch(disk.stdout, /__SCRIPT_HASHES__|__UPLOAD_ORIGIN__|https:\/\//);
    const s3 = probe({
      REWIND_MEDIA_BACKEND: 's3',
      REWIND_MEDIA_S3_BUCKET: 'rewind-fixture-media',
      REWIND_MEDIA_S3_REGION: 'ap-southeast-1',
    });
    assert.equal(s3.status, 0, s3.stderr);
    assert.match(
      s3.stdout,
      /connect-src 'self' blob: https:\/\/rewind-fixture-media\.s3\.ap-southeast-1\.amazonaws\.com;/,
    );
    assert.doesNotMatch(s3.stdout, /\*/);
    for (const bucket of ['*', 'bucket; script-src *', 'bucket\nadd_header X-Evil yes;']) {
      const invalid = probe({
        REWIND_MEDIA_BACKEND: 's3',
        REWIND_MEDIA_S3_BUCKET: bucket,
        REWIND_MEDIA_S3_REGION: 'ap-southeast-1',
      });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Invalid CSP media bucket/);
    }
    assert.notEqual(
      probe({ REWIND_MEDIA_BACKEND: 's3', REWIND_MEDIA_S3_BUCKET: 'rewind-fixture-media' }).status,
      0,
    );
  },
);
