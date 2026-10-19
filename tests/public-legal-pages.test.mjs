import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createProductionWebServer } from '../scripts/production-web-proxy.mjs';

// Exercise the real public documents with no session and an unavailable API.
// A legal route must never fall back to an app shell that requires sign-in.
test('signed-out visitors can read and follow the public legal pages without the API', async () => {
  const web = createProductionWebServer({
    staticDir: new URL('../public/', import.meta.url).pathname,
    runtimeOrigin: 'http://127.0.0.1:9',
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    for (const page of ['privacy', 'support']) {
      const document = await readFile(new URL(`../public/${page}.html`, import.meta.url), 'utf8');
      for (const path of [`/${page}`, `/${page}.html`]) {
        const response = await fetch(base + path);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(await response.text(), document);
      }
      const navigation = document.match(
        /<nav aria-label="Rewind legal pages">([\s\S]*?)<\/nav>/,
      )?.[1];
      assert.ok(navigation, `${page} has labelled legal navigation`);
      const paths = [...navigation.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
      assert.deepEqual(paths, ['/privacy', '/terms', '/support']);
      for (const path of paths) {
        const response = await fetch(base + path);
        assert.equal(response.status, 200);
        assert.match(
          await response.text(),
          /<h1>Rewind (privacy policy|support|terms of use)<\/h1>/i,
        );
      }
    }
  } finally {
    await new Promise((resolve) => web.close(resolve));
  }
});

test('privacy explains data, storage, retention exceptions and account deletion', async () => {
  const html = (await readFile(new URL('../public/privacy.html', import.meta.url), 'utf8')).replace(
    /\s+/g,
    ' ',
  );
  for (const disclosure of [
    'username, display name',
    'photos and videos',
    'sound in videos',
    'push subscription',
    'group membership',
    'AWS) S3 storage',
    'hosted database',
    'while your account exists',
    'Recovery backups',
    'storage expiration rules',
    'Settings → Delete account',
    'group film that was already made',
    'href="/support"',
  ])
    assert.ok(html.includes(disclosure), `Missing disclosure: ${disclosure}`);
  assert.doesNotMatch(html, /removed from storage within two days/);
});

test('support identifies its public contact channel and warns against sharing private data', async () => {
  const html = (await readFile(new URL('../public/support.html', import.meta.url), 'utf8')).replace(
    /\s+/g,
    ' ',
  );
  assert.match(html, /href="https:\/\/github\.com\/Collaboration95\/rewind-app\/issues"/);
  assert.match(html, /GitHub issues are public and require a GitHub account/);
  assert.match(html, /password, sign-in tokens, private photos or videos/);
  assert.match(html, /Settings → Delete account/);
});
