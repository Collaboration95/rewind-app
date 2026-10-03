import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, request, Agent } from 'node:https';
import { once } from 'node:events';
import * as commands from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const accessKeyId = 'LOCALONLYACCESSKEY';
const secretAccessKey = 'local-only-synthetic-secret';
const bucket = 'private-protocol-bucket';
const owner = '123456789012';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const escape = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const xml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );

/** Deliberately narrow protocol fixture, NOT AWS encryption/CORS/lifecycle emulation.
 * Every accepted operation verifies real SigV4 independently of SDK internals.
 * Bytes are immutable copies, and reads/deletes require an exact version.
 */
export async function s3ProtocolFixture(root, now) {
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
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      root + '/key.pem',
      '-out',
      root + '/cert.pem',
    ],
    { stdio: 'ignore' },
  );
  const versions = new Map();
  const calls = [];
  let next = 0;
  let afterHead;
  function authenticate(req, url, body) {
    const presigned = url.searchParams.has('X-Amz-Signature');
    const auth = req.headers.authorization ?? '';
    const credential = presigned
      ? url.searchParams.get('X-Amz-Credential')
      : /Credential=([^, ]+)/.exec(auth)?.[1];
    const signed = presigned
      ? url.searchParams.get('X-Amz-SignedHeaders')
      : /SignedHeaders=([^, ]+)/.exec(auth)?.[1];
    const signature = presigned
      ? url.searchParams.get('X-Amz-Signature')
      : /Signature=([a-f0-9]+)/.exec(auth)?.[1];
    assert.ok(credential && signed && /^[a-f0-9]{64}$/.test(signature));
    if (!presigned) assert.ok(auth.startsWith('AWS4-HMAC-SHA256 '));
    else assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    const [key, date, region, service, end] = credential.split('/');
    assert.deepEqual([key, region, service, end], [accessKeyId, 'us-east-1', 's3', 'aws4_request']);
    const at = presigned ? url.searchParams.get('X-Amz-Date') : req.headers['x-amz-date'];
    assert.equal(at.slice(0, 8), date);
    if (presigned) {
      const issued = Date.parse(
        at.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
      );
      const ttl = Number(url.searchParams.get('X-Amz-Expires'));
      assert.ok(
        ttl > 0 && ttl <= 900 && now().getTime() >= issued && now().getTime() < issued + ttl * 1000,
      );
    }
    const names = signed.split(';');
    assert.ok(names.includes('host'));
    const headers = names
      .map((name) => {
        assert.equal(typeof req.headers[name], 'string');
        return name + ':' + req.headers[name].trim().replace(/\s+/g, ' ') + '\n';
      })
      .join('');
    const query = [...url.searchParams]
      .filter(([key]) => key !== 'X-Amz-Signature')
      .map(([key, value]) => [escape(key), escape(value)])
      .sort(([a, b], [c, d]) => (a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0))
      .map(([key, value]) => key + '=' + value)
      .join('&');
    const payload = presigned ? 'UNSIGNED-PAYLOAD' : req.headers['x-amz-content-sha256'];
    assert.ok(
      payload === hash(body) ||
        payload === 'UNSIGNED-PAYLOAD' ||
        (!presigned && payload === 'STREAMING-UNSIGNED-PAYLOAD-TRAILER'),
    );
    const canonical = [req.method, url.pathname, query, headers, signed, payload].join('\n');
    const scope = [date, region, service, end].join('/');
    let signing = hmac('AWS4' + secretAccessKey, date);
    for (const piece of [region, service, end]) signing = hmac(signing, piece);
    const expected = hmac(signing, ['AWS4-HMAC-SHA256', at, scope, hash(canonical)].join('\n'));
    assert.ok(timingSafeEqual(expected, Buffer.from(signature, 'hex')));
    assert.equal(req.headers['x-amz-expected-bucket-owner'], owner);
    return presigned;
  }
  const certificate = await readFile(root + '/cert.pem');
  const server = createServer(
    { key: await readFile(root + '/key.pem'), cert: certificate },
    async (req, res) => {
      const url = new URL(req.url, 'https://' + req.headers.host);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = Buffer.concat(chunks);
      try {
        const presigned = authenticate(req, url, body);
        assert.ok(url.pathname.startsWith('/' + bucket));
        const key = decodeURIComponent(url.pathname.slice(bucket.length + 2));
        const version = url.searchParams.get('versionId');
        calls.push({ method: req.method, key, version, presigned });
        if (req.method === 'GET' && url.searchParams.has('versions')) {
          assert.equal(key, '');
          const prefix = url.searchParams.get('prefix');
          const limit = Number(url.searchParams.get('max-keys'));
          assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 100);
          const all = [...versions.values()].filter((v) => v.key.startsWith(prefix));
          const marker = url.searchParams.get('version-id-marker');
          const start = marker ? all.findIndex((v) => v.version === marker) + 1 : 0;
          const page = all.slice(start, start + limit);
          const truncated = start + page.length < all.length;
          res.setHeader('content-type', 'application/xml');
          res.end(
            `<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextKeyMarker>${xml(page.at(-1).key)}</NextKeyMarker><NextVersionIdMarker>${page.at(-1).version}</NextVersionIdMarker>` : ''}${page.map((v) => `<Version><Key>${xml(v.key)}</Key><VersionId>${v.version}</VersionId><IsLatest>false</IsLatest><Size>${v.bytes.length}</Size></Version>`).join('')}</ListVersionsResult>`,
          );
        } else if (req.method === 'PUT') {
          if (req.headers['content-encoding'] === 'aws-chunked') {
            assert.equal(req.headers['x-amz-content-sha256'], 'STREAMING-UNSIGNED-PAYLOAD-TRAILER');
            assert.equal(req.headers['x-amz-trailer'], 'x-amz-checksum-sha256');
            const decoded = [];
            let offset = 0;
            for (;;) {
              const end = body.indexOf('\r\n', offset);
              assert.ok(end >= offset);
              const size = body.subarray(offset, end).toString();
              assert.match(size, /^[a-f0-9]+$/);
              const length = parseInt(size, 16);
              offset = end + 2;
              if (!length) break;
              assert.ok(offset + length + 2 <= body.length);
              decoded.push(body.subarray(offset, offset + length));
              assert.equal(body.subarray(offset + length, offset + length + 2).toString(), '\r\n');
              offset += length + 2;
            }
            const trailer = body.subarray(offset).toString();
            body = Buffer.concat(decoded);
            assert.equal(
              trailer,
              'x-amz-checksum-sha256:' +
                createHash('sha256').update(body).digest('base64') +
                '\r\n\r\n',
            );
          }

          assert.equal(version, null);
          assert.ok(key);
          assert.equal(
            Number(req.headers['x-amz-decoded-content-length'] ?? req.headers['content-length']),
            body.length,
          );
          assert.equal(
            req.headers['x-amz-checksum-sha256'],
            createHash('sha256').update(body).digest('base64'),
          );
          assert.equal(req.headers['x-amz-server-side-encryption'], 'AES256');
          assert.equal(req.headers['cache-control'], 'private, no-store');
          const metadata = JSON.parse(req.headers['x-amz-meta-media-ref']);
          assert.equal(req.headers['x-amz-tagging'], `rewind-media-class=${metadata.prefix}`);
          assert.equal(metadata.key, key);
          assert.equal(metadata.byteLength, body.length);
          assert.equal(metadata.sha256, hash(body));
          const id = 'local-v-' + ++next;
          const value = {
            key,
            version: id,
            bytes: Buffer.from(body),
            headers: {
              'content-length': String(body.length),
              'content-type': req.headers['content-type'],
              'x-amz-meta-media-ref': req.headers['x-amz-meta-media-ref'],
              'x-amz-checksum-sha256': req.headers['x-amz-checksum-sha256'],
              'x-amz-server-side-encryption': 'AES256',
              'cache-control': 'private, no-store',
              'x-amz-version-id': id,
            },
          };
          versions.set(key + ':' + id, value);
          res.setHeader('x-amz-version-id', id);
          res.end();
        } else {
          assert.ok(version && version !== 'null');
          const value = versions.get(key + ':' + version);
          if (!value) {
            res.writeHead(404, { 'content-type': 'application/xml' });
            res.end('<Error><Code>NoSuchVersion</Code></Error>');
          } else if (req.method === 'DELETE') {
            versions.delete(key + ':' + version);
            res.writeHead(204).end();
          } else {
            assert.ok(['HEAD', 'GET'].includes(req.method));
            assert.equal(req.headers['x-amz-checksum-mode'], 'ENABLED');
            if (req.method === 'HEAD' && afterHead) {
              const hook = afterHead;
              afterHead = undefined;
              await hook(value);
            }
            res.writeHead(200, value.headers);
            res.end(req.method === 'GET' ? value.bytes : undefined);
          }
        }
      } catch {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end('<Error><Code>AccessDenied</Code></Error>');
      }
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const endpoint = 'https://127.0.0.1:' + port;
  // Trust only this disposable fixture certificate; keep chain and SAN checks enabled.
  const agent = new Agent({ ca: certificate, rejectUnauthorized: true });
  const client = new commands.S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: new NodeHttpHandler({ httpsAgent: agent }),
  });
  return {
    versions,
    calls,
    client,
    port,
    certificate,
    config: {
      backend: 's3',
      bucket,
      expectedBucketOwner: owner,
      region: 'us-east-1',
      environment: 'test',
    },
    sdk: { ...commands, client, getSignedUrl },
    afterNextHead(hook) {
      afterHead = hook;
    },
    async put(capability, bytes) {
      const url = new URL(capability.url);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.username, '');
      assert.equal(url.password, '');
      assert.equal(url.hash, '');
      assert.equal(url.origin, endpoint); // Never send a fixture capability elsewhere.
      const path = url.pathname + url.search;
      return new Promise((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method: 'PUT',
            headers: { ...capability.headers, 'content-length': bytes.length },
            agent,
          },
          (res) => {
            res.resume();
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                version: res.headers['x-amz-version-id'],
                tlsAuthorized: res.socket.authorized,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(bytes);
      });
    },
    async close() {
      client.destroy();
      agent.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
