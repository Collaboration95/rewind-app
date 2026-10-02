import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  sign,
  verify,
  webcrypto,
} from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor/node-forge');
const provenance = JSON.parse(readFileSync(join(vendor, 'provenance.json'), 'utf8'));
const installed = dirname(require.resolve('node-forge/package.json'));
const patched = require('node-forge');
const work = mkdtempSync(join(tmpdir(), 'rewind-forge-security-'));
after(() => rmSync(work, { recursive: true, force: true }));

// Recover the exact vulnerable source in isolation for the negative control.
// Every recovered byte is checked against the original npm package hashes.
const baseline = join(work, 'original');
cpSync(installed, baseline, { recursive: true });
execFileSync('patch', ['-R', '-p1', '--input', join(vendor, 'rsa.patch')], { cwd: baseline });
for (const [file, change] of Object.entries(provenance.patch.browserBundles)) {
  const source = readFileSync(join(baseline, file), 'utf8');
  assert.equal(source.split(change.after).length, 2);
  writeFileSync(join(baseline, file), source.replace(change.after, change.before));
}
const originalMetadata = JSON.parse(readFileSync(join(baseline, 'package.json'), 'utf8'));
originalMetadata.name = provenance.upstream.name;
originalMetadata.version = provenance.upstream.version;
originalMetadata.description = originalMetadata.description.replace(
  ' Rewind local security backport; not an upstream release.',
  '',
);
delete originalMetadata.rewindSecurityBackport;
writeFileSync(join(baseline, 'package.json'), `${JSON.stringify(originalMetadata, null, 2)}\n`);
const original = require(join(baseline, 'lib/index.js'));

function filesIn(directory, prefix = '') {
  return readdirSync(directory).flatMap((file) => {
    const path = join(directory, file);
    return lstatSync(path).isDirectory()
      ? filesIn(path, `${prefix}${file}/`)
      : [`${prefix}${file}`];
  });
}

function browserForge(directory, file) {
  // The all-features bundle captures the host's jQuery for its optional form
  // and XHR APIs. Those APIs are unused here; no cryptographic API is mocked.
  const context = { window: { crypto: webcrypto }, jQuery: {}, setTimeout, clearTimeout };
  context.self = context.window;
  runInNewContext(readFileSync(join(directory, file), 'utf8'), context);
  return context.window.forge;
}

const implementations = [
  { name: 'CommonJS', before: original, after: patched },
  ...Object.keys(provenance.patch.browserBundles).map((file) => ({
    name: file,
    before: browserForge(baseline, file),
    after: browserForge(installed, file),
  })),
];

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const { publicKey: lowExponentPublicKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicExponent: 3,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function cubeRootCeil(value) {
  let lower = 0n;
  let upper = 1n << 1024n;
  while (lower < upper) {
    const middle = (lower + upper) >> 1n;
    if (middle ** 3n < value) lower = middle + 1n;
    else upper = middle;
  }
  return lower;
}

function publicKeyOnlyForgery() {
  // The cube root of an odd integer modulo 2^k exists uniquely. Choose a
  // message with an odd SHA-256 digest, then lift that root one bit at a time.
  // No private key is passed to or consulted by this forgery construction.
  let message;
  let digest;
  for (let index = 0; ; index += 1) {
    message = `Rewind manifest security regression ${index}`;
    digest = createHash('sha256').update(message).digest();
    if (digest[31] & 1) break;
  }
  const suffix = Buffer.concat([Buffer.from('0420', 'hex'), digest]);
  const bits = BigInt(suffix.length * 8);
  const step = 1n << bits;
  const target = BigInt(`0x${suffix.toString('hex')}`);
  let residue = 1n;
  for (let bit = 1n; bit < bits; bit += 1n) {
    if ((((residue ** 3n) >> bit) & 1n) !== ((target >> bit) & 1n)) residue += 1n << bit;
  }

  // 3072-bit EM: strict 00 01 FF padding; exactly two outer DigestInfo
  // children; SHA-256 OID, NULL and a third 314-byte OCTET STRING inside
  // DigestAlgorithm; finally the actual 32-byte digest. Only the nested
  // OCTET STRING contents are unconstrained.
  const prefix = Buffer.from(
    '0001ffffffffffffffff00308201713082014b060960864801650304020105000482013a',
    'hex',
  );
  const lower = BigInt(`0x${prefix.toString('hex')}`) << BigInt((384 - prefix.length) * 8);
  const minimum = cubeRootCeil(lower);
  const signatureInteger = minimum + ((((residue - minimum) % step) + step) % step);
  const encodedInteger = signatureInteger ** 3n;
  const encoded = Buffer.from(encodedInteger.toString(16).padStart(768, '0'), 'hex');
  assert.deepEqual(encoded.subarray(0, prefix.length), prefix);
  assert.deepEqual(encoded.subarray(-suffix.length), suffix);
  const publicRSA = original.pki.publicKeyFromPem(lowExponentPublicKey);
  assert.equal(publicRSA.e.toString(), '3');
  assert.ok(encodedInteger < BigInt(`0x${publicRSA.n.toString(16)}`));
  const digestInfo = original.asn1.fromDer(encoded.subarray(11).toString('binary'));
  assert.equal(digestInfo.value.length, 2);
  assert.equal(digestInfo.value[0].value.length, 3);
  return {
    digest: digest.toString('binary'),
    signature: Buffer.from(signatureInteger.toString(16).padStart(768, '0'), 'hex').toString(
      'binary',
    ),
  };
}

test('fork preserves the full upstream package and its BSD/GPL attribution', () => {
  assert.deepEqual(filesIn(baseline).sort(), Object.keys(provenance.upstream.filesSha256).sort());
  for (const [file, hash] of Object.entries(provenance.upstream.filesSha256)) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(baseline, file)))
        .digest('hex'),
      hash,
      file,
    );
  }
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(vendor, 'rsa.patch')))
      .digest('hex'),
    provenance.patch.sha256,
  );
  assert.deepEqual(
    readFileSync(join(installed, 'LICENSE')),
    readFileSync(join(baseline, 'LICENSE')),
  );
  const metadata = require('node-forge/package.json');
  assert.equal(metadata.name, '@rewind/node-forge');
  assert.equal(metadata.version, '1.4.0-rewind.1');
  assert.equal(metadata.license, '(BSD-3-Clause OR GPL-2.0)');
  assert.deepEqual(metadata.author, originalMetadata.author);
  assert.deepEqual(metadata.contributors, originalMetadata.contributors);
  assert.equal(metadata.rewindSecurityBackport.upstreamPatchCommit, provenance.patch.commit);
});

test('root, Expo CLI and Expo certificates resolve the identical pinned fork', () => {
  const expoRequire = createRequire(require.resolve('expo/package.json'));
  const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
  const certificatesRequire = createRequire(require.resolve('@expo/code-signing-certificates'));
  const expected = realpathSync(require.resolve('node-forge'));
  assert.equal(lstatSync(installed).isSymbolicLink(), false);
  for (const consumer of [require, cliRequire, certificatesRequire]) {
    assert.equal(realpathSync(consumer.resolve('node-forge')), expected);
    assert.equal(consumer('node-forge'), patched);
  }
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const forgeEntries = Object.entries(lock.packages).filter(([path]) =>
    path.endsWith('/node-forge'),
  );
  assert.equal(forgeEntries.length, 1);
  const [, pinned] = forgeEntries[0];
  assert.equal(pinned.name, provenance.fork.name);
  assert.equal(pinned.version, provenance.fork.version);
  assert.equal(pinned.resolved, `file:vendor/node-forge/${provenance.fork.archive}`);
  const bytes = readFileSync(join(vendor, provenance.fork.archive));
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pinned.integrity);
  assert.equal(pinned.integrity, provenance.fork.integrity);
});

for (const implementation of implementations) {
  test(`${implementation.name}: original accepts public-key-only nested forgery; fork rejects it`, () => {
    const { digest, signature } = publicKeyOnlyForgery();
    const before = implementation.before.pki.publicKeyFromPem(lowExponentPublicKey);
    const after = implementation.after.pki.publicKeyFromPem(lowExponentPublicKey);
    assert.equal(before.verify(digest, signature), true);
    assert.throws(() => after.verify(digest, signature), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
  });

  test(`${implementation.name}: valid PKCS#1 v1.5 hashes still verify; wrong messages fail`, () => {
    const key = implementation.after.pki.publicKeyFromPem(publicKey);
    const message = Buffer.from('Rewind valid Expo-compatible manifest');
    for (const algorithm of ['sha1', 'sha256', 'sha384', 'sha512']) {
      const signature = sign(algorithm, message, privateKey).toString('binary');
      const digest = createHash(algorithm).update(message).digest().toString('binary');
      assert.equal(key.verify(digest, signature), true, algorithm);
      const wrong = createHash(algorithm).update('modified manifest').digest().toString('binary');
      assert.equal(key.verify(wrong, signature), false, algorithm);
    }
  });
}

function digestInfoSignature(algorithmChildren, outerExtras = []) {
  const { asn1 } = patched;
  const digest = createHash('sha256').update('structured manifest').digest().toString('binary');
  const object = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, algorithmChildren),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
    ...outerExtras,
  ]);
  const der = Buffer.from(asn1.toDer(object).getBytes(), 'binary');
  const encoded = Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.alloc(256 - der.length - 3, 0xff),
    Buffer.from([0]),
    der,
  ]);
  const signature = privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encoded);
  return { digest, signature: signature.toString('binary') };
}

test('SHA-256 with optional NULL remains valid; extra children are rejected at both nesting levels', () => {
  const { asn1 } = patched;
  const oid = asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.OID,
    false,
    asn1.oidToDer(patched.oids.sha256).getBytes(),
  );
  const nullParameter = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, '');
  const garbage = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, 'nested garbage');
  for (const implementation of implementations) {
    const key = implementation.after.pki.publicKeyFromPem(publicKey);
    for (const children of [[oid], [oid, nullParameter]]) {
      const { digest, signature } = digestInfoSignature(children);
      assert.equal(key.verify(digest, signature), true);
    }
    for (const children of [
      [oid, garbage],
      [oid, nullParameter, garbage],
      [oid, nullParameter, nullParameter],
    ]) {
      const { digest, signature } = digestInfoSignature(children);
      assert.throws(() => key.verify(digest, signature), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
    }
    const outer = digestInfoSignature([oid, nullParameter], [garbage]);
    assert.throws(
      () => key.verify(outer.digest, outer.signature),
      /valid RSASSA-PKCS1-v1_5 DigestInfo/,
    );
  }
});

test('Expo certificate generation, PEM round trips, CSR and manifest signing remain compatible', () => {
  const certificates = require('@expo/code-signing-certificates');
  const pair = certificates.generateKeyPair();
  const roundTrip = certificates.convertKeyPairPEMToKeyPair(certificates.convertKeyPairToPEM(pair));
  const now = Date.now();
  const generated = certificates.generateSelfSignedCodeSigningCertificate({
    keyPair: roundTrip,
    validityNotBefore: new Date(now - 60_000),
    validityNotAfter: new Date(now + 60_000),
    commonName: 'Rewind security regression',
  });
  const certificate = certificates.convertCertificatePEMToCertificate(
    certificates.convertCertificateToCertificatePEM(generated),
  );
  certificates.validateSelfSignedCertificate(certificate, roundTrip);
  assert.equal(certificate.verify(certificate), true);
  const csr = certificates.convertCSRPEMToCSR(
    certificates.convertCSRToCSRPEM(certificates.generateCSR(roundTrip, 'Rewind development CSR')),
  );
  assert.equal(csr.verify(), true);
  const message = Buffer.from('{"runtimeVersion":"security-regression"}');
  const signature = certificates.signBufferRSASHA256AndVerify(
    roundTrip.privateKey,
    certificate,
    message,
  );
  const publicPEM = certificates.convertKeyPairToPEM(roundTrip).publicKeyPEM;
  assert.equal(verify('sha256', message, publicPEM, Buffer.from(signature, 'base64')), true);
  assert.equal(
    verify('sha256', Buffer.from('tampered manifest'), publicPEM, Buffer.from(signature, 'base64')),
    false,
  );
});
