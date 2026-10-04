import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { PrivateS3MediaStore } from '../../dist/media/s3-store.js';
const now = new Date('2026-10-02T12:00:00Z');
/** Versioned protocol double: HEAD/GET never resolve a mutable latest key. */
export function s3Double() {
  const versions = new Map();
  const calls = [];
  let next = 0;
  const transport = {
    async putObject(request) {
      calls.push(['put', request]);
      const chunks = [];
      for await (const chunk of request.Body) chunks.push(chunk);
      const version = String(++next);
      versions.set(`${request.Key}:${version}`, {
        VersionId: version,
        ContentLength: request.ContentLength,
        ContentType: request.ContentType,
        ChecksumSHA256: request.ChecksumSHA256,
        Metadata: request.Metadata,
        ServerSideEncryption: request.ServerSideEncryption,
        SSEKMSKeyId: request.SSEKMSKeyId,
        bytes: Buffer.concat(chunks),
      });
      return { VersionId: version };
    },
    async headObject(request) {
      calls.push(['head', request]);
      const value = versions.get(`${request.Key}:${request.VersionId}`);
      if (!value) throw Object.assign(new Error('private details'), { name: 'NoSuchVersion' });
      return { ...value };
    },
    async getObject(request) {
      calls.push(['get', request]);
      const value = await transport.headObject(request);
      return { ...value, Body: Readable.from([value.bytes]) };
    },
    async deleteObject(request) {
      calls.push(['delete', request]);
      versions.delete(`${request.Key}:${request.VersionId}`);
    },
  };
  return { transport, calls, versions };
}
export function s3Store(double, options = {}) {
  return new PrivateS3MediaStore(double.transport, {
    bucket: 'private-test-bucket',
    environment: 'test',
    expectedBucketOwner: '123456789012',
    now: () => now,
    ...options,
  });
}
