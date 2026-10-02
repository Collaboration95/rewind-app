import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from '@playwright/test';
import ts from 'typescript';
import { createRuntimeServer } from '../server/dist/http.js';
import { withIntentFixture } from '../server/tests/helpers/upload-intents.mjs';

// Execute the actual client, protocol and adapter in Chromium without mounting
// another worker's capture UI. Only unused native platform services are facades;
// browser fetch, Web Crypto, cookies, Blob and localStorage are real.
function browserBundle(now) {
  const modules = {};
  function compile(path) {
    if (modules[path]) return;
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    modules[path] = code;
    for (const [, dependency] of code.matchAll(/require\("([^"]+)"\)/g))
      if (dependency.startsWith('.')) compile(resolve(dirname(path), dependency + '.ts'));
  }
  const auth = resolve('src/auth/real-account-client.ts');
  const adapter = resolve('src/capture/real-account-video-runtime.ts');
  compile(auth);
  compile(adapter);
  return `(() => {
    const sources = ${JSON.stringify(modules)}, cache = {};
    function load(path) {
      if (cache[path]) return cache[path].exports;
      const module = cache[path] = { exports: {} };
      const require = (name) => {
        if (name === 'react-native') return { Platform: { OS: 'web' } };
        if (name === 'expo-secure-store') return {};
        if (!name.startsWith('.')) throw new Error('Unexpected native module: ' + name);
        return load(new URL(name + '.ts', 'file://' + path).pathname);
      };
      new Function('require', 'module', 'exports', sources[path])(require, module, module.exports);
      return module.exports;
    }
    const auth = new (load(${JSON.stringify(auth)}).RealAccountClient)(location.origin);
    const store = {
      getItem: async key => localStorage.getItem(key),
      setItem: async (key, value) => localStorage.setItem(key, value)
    };
    window.auth = auth;
    window.makeTransfer = () => load(${JSON.stringify(adapter)}).createRealAccountVideoRuntimeClient(
      (path, init) => auth.request(path, init || {}),
      { transferMode: 'direct', checkpointStore: store, now: () => new Date(${JSON.stringify(now.toISOString())}) }
    );
    window.transfer = window.makeTransfer();
  })();`;
}

async function listen(server, port) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
}

test('Chromium cookie client → intent HTTP → cross-origin binary PUT → pinned completion and processing', async () => {
  await withIntentFixture(async (c) => {
    const origin = 'https://127.0.0.1:5421';
    const storageOrigin = 'https://127.0.0.1:5422';
    const secret = 'synthetic-direct-transfer-proxy';
    const key = c.root + '/fixture-key.pem';
    const cert = c.root + '/fixture-cert.pem';
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    const tls = { key: readFileSync(key), cert: readFileSync(cert) };
    // Intent timestamps are deterministic; Web Crypto capability expiry uses
    // the same clock in the browser, rather than relying on the host's date.
    const browserCode = browserBundle(c.now);
    const apiRequests = [];
    const storageRequests = [];
    const photoBytes = readFileSync('public/icons/rewind-icon-192.png');
    let hideVersion = false;
    let rejectPut = false;
    const runtime = createRuntimeServer(
      {
        ...c.config,
        allowOrigin: origin,
        originAuthSecret: secret,
      },
      c.database,
      {
        now: () => c.now,
        mediaStore: c.deps.store,
        mediaEnvironment: 'test',
        uploadIntents: c.deps,
      },
    );
    const app = createServer(tls, (request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end(
          '<!doctype html><title>Direct transfer fixture</title><script>' +
            browserCode +
            '</script>',
        );
        return;
      }
      const entry = {
        path: request.url,
        method: request.method,
        headers: { ...request.headers },
        chunks: [],
      };
      apiRequests.push(entry);
      request.on('data', (chunk) => entry.chunks.push(chunk));
      request.headers['x-rewind-origin-auth'] = secret;
      request.headers['x-forwarded-proto'] = 'https';
      runtime.emit('request', request, response);
    });
    c.deps.transport.signPut = async (scope, target) => {
      const url = `${storageOrigin}/objects/${randomBytes(16).toString('hex')}`;
      c.capabilities.set(url, { scope, target });
      return {
        method: 'PUT',
        url,
        expiresAt: target.expiresAt,
        headers: {
          'content-type': target.contentType,
          'x-amz-checksum-sha256': Buffer.from(target.sha256, 'hex').toString('base64'),
          'x-amz-expected-bucket-owner': '123456789012',
          'x-amz-server-side-encryption': 'AES256',
        },
      };
    };
    const storage = createServer(tls, async (request, response) => {
      const headers = {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'PUT',
        'Access-Control-Allow-Headers':
          'content-type,x-amz-checksum-sha256,x-amz-expected-bucket-owner,x-amz-server-side-encryption',
        'Access-Control-Expose-Headers': hideVersion ? '' : 'x-amz-version-id',
        'Cache-Control': 'no-store',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(204, headers);
        response.end();
        return;
      }
      try {
        assert.equal(request.method, 'PUT');
        assert.equal(request.headers.origin, origin);
        assert.equal(request.headers.cookie, undefined);
        assert.equal(request.headers.authorization, undefined);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        storageRequests.push({ headers: { ...request.headers }, bytes });
        assert.deepEqual(
          bytes,
          request.headers['content-type'] === 'image/png' ? photoBytes : c.bytes,
        );
        assert.equal(
          request.headers['x-amz-checksum-sha256'],
          createHash('sha256').update(bytes).digest('base64'),
        );
        if (rejectPut) {
          response.writeHead(403, { ...headers, 'Content-Type': 'application/xml' });
          response.end('<Error><Code>AccessDenied</Code></Error>');
          return;
        }
        const version = await c.put({ url: storageOrigin + request.url }, bytes);
        response.writeHead(200, { ...headers, 'x-amz-version-id': version });
        response.end();
      } catch (error) {
        response.writeHead(500, headers);
        response.end(String(error));
      }
    });
    let browser;
    try {
      await listen(app, 5421);
      await listen(storage, 5422);
      browser = await chromium.launch();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      // A real, DB-backed HttpOnly secure session. Same-host storage on another
      // port would receive this cookie if the protocol failed to omit credentials.
      await context.addCookies([
        {
          name: '__Host-rewind_session',
          value: c.actor.sessionToken,
          url: origin,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);
      const page = await context.newPage();
      const scriptErrors = [];
      page.on('pageerror', (error) => scriptErrors.push(error.message));
      await page.goto(origin);
      assert.deepEqual(scriptErrors, []);
      assert.equal(
        await page.evaluate(async () => (await window.auth.restore()).account.id),
        'intent-owner',
      );
      const input = {
        sourceUri: 'blob:fixture',
        mimeType: 'video/mp4',
        byteLength: c.bytes.length,
        durationSeconds: 0.5,
        trimStartSeconds: 0,
        trimEndSeconds: 0.5,
        width: 720,
        height: 1280,
        hasAudio: true,
      };
      async function transfer(key, emptySource = false, photo = false) {
        return page.evaluate(
          async ({ groupId, input, bytes, emptySource }) => {
            const source = {
              kind: 'blob',
              blob: new Blob([Uint8Array.from(emptySource ? [] : bytes)], { type: input.mimeType }),
              dispose: () => {
                window.disposals = (window.disposals || 0) + 1;
              },
            };
            try {
              return { intent: await window.transfer.transferContribution(groupId, input, source) };
            } catch (error) {
              return { error: error.code, message: error.message };
            }
          },
          {
            groupId: c.actor.groupId,
            input: {
              ...input,
              ...(photo
                ? {
                    mediaType: 'photo',
                    mimeType: 'image/png',
                    byteLength: photoBytes.length,
                    durationSeconds: 3,
                    trimEndSeconds: 3,
                    width: 192,
                    height: 192,
                    hasAudio: false,
                  }
                : {}),
              idempotencyKey: key,
            },
            bytes: [...(photo ? photoBytes : c.bytes)],
            emptySource,
          },
        );
      }
      // Drop a response after the real handler has atomically registered it.
      await page.route(
        '**/upload-intents/*/complete',
        async (route) => {
          const result = await route.fetch();
          assert.equal(result.status(), 200);
          await route.abort('failed');
        },
        { times: 1 },
      );
      const first = await transfer('browser-http-key-1');
      assert.equal(first.intent.state, 'completed', JSON.stringify(first));
      assert.equal(first.intent.cycleId, c.group.cycle.id);
      assert.equal(storageRequests.length, 1);
      assert.equal(await page.evaluate(() => window.disposals), 1);
      await page.reload();
      const replay = await transfer('browser-http-key-1', true);
      assert.deepEqual(replay.intent, first.intent);
      assert.equal(storageRequests.length, 1);
      const processed = await page.evaluate(
        async ({ groupId, jobId }) => {
          const response = await window.auth.request(
            `/contributions/jobs/${jobId}/process?groupId=${groupId}`,
            { method: 'POST' },
          );
          return response.status;
        },
        { groupId: c.actor.groupId, jobId: first.intent.jobId },
      );
      assert.equal(processed, 200);
      assert.equal(
        c.database.prepare('SELECT status FROM media_jobs WHERE id=?').get(first.intent.jobId)
          .status,
        'ready',
      );
      assert.equal(
        c.database
          .prepare('SELECT count_used FROM contribution_quota_windows WHERE member_id=?')
          .get(first.intent.profileId).count_used,
        1,
      );

      const photo = await transfer('browser-http-photo-1', false, true);
      assert.equal(photo.intent.state, 'completed', JSON.stringify(photo));
      assert.equal(await page.evaluate(() => window.disposals), 2);
      assert.equal(storageRequests.length, 2);
      assert.equal(
        await page.evaluate(
          async ({ groupId, jobId }) => {
            const response = await window.auth.request(
              `/contributions/jobs/${jobId}/process?groupId=${groupId}`,
              { method: 'POST' },
            );
            return response.status;
          },
          { groupId: c.actor.groupId, jobId: photo.intent.jobId },
        ),
        200,
      );
      assert.equal(
        c.database.prepare('SELECT status FROM media_jobs WHERE id=?').get(photo.intent.jobId)
          .status,
        'ready',
      );
      assert.equal(
        c.database
          .prepare('SELECT count_used FROM contribution_quota_windows WHERE member_id=?')
          .get(photo.intent.profileId).count_used,
        2,
      );

      // Actual CORS omission leaves a version unknown. Reload must reconcile,
      // never PUT another version or fabricate registration/source disposal.
      hideVersion = true;
      const hidden = await transfer('browser-http-key-2');
      assert.equal(hidden.error, 'version_unknown');
      await page.reload();
      assert.equal((await transfer('browser-http-key-2')).error, 'version_unknown');
      assert.equal(storageRequests.length, 3);
      assert.equal(
        c.database
          .prepare('SELECT count(*) AS n FROM contributions WHERE cycle_id=?')
          .get(c.group.cycle.id).n,
        2,
      );
      assert.equal(await page.evaluate(() => window.disposals || 0), 0);

      hideVersion = false;
      rejectPut = true;
      const rejected = await transfer('browser-http-key-3');
      assert.equal(rejected.error, 'storage_expired');
      assert.equal(rejected.message.includes('<Error>'), false);
      assert.equal(storageRequests.length, 4);
      c.database.prepare("UPDATE cycles SET status='revealing' WHERE id=?").run(c.group.cycle.id);
      const closed = await transfer('browser-http-key-4');
      assert.equal(closed.error, 'upload_intent_closed_cycle');
      assert.equal(storageRequests.length, 4);
      c.database
        .prepare('DELETE FROM real_account_sessions WHERE account_id=?')
        .run('intent-owner');
      assert.equal((await transfer('browser-http-key-1', true)).error, 'authorization');
      assert.equal(storageRequests.length, 4);

      for (const entry of apiRequests) {
        assert.equal(entry.headers.authorization, undefined);
        assert.match(entry.headers.cookie || '', /__Host-rewind_session=/);
        const body = Buffer.concat(entry.chunks);
        assert.ok(body.length < 1024, 'API receives only bounded JSON metadata');
        if (body.length) assert.doesNotThrow(() => JSON.parse(body.toString()));
      }
      const journal = await page.evaluate(() => JSON.stringify({ ...localStorage }));
      assert.equal(journal.includes(c.actor.sessionToken), false);
      assert.equal(journal.includes(storageOrigin), false);
      assert.equal(journal.includes('blob:fixture'), false);
      assert.deepEqual(scriptErrors, []);
    } finally {
      await browser?.close();
      for (const server of [app, storage]) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      runtime.close();
    }
  });
});
