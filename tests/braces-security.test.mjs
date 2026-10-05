import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor/braces');
const provenance = JSON.parse(readFileSync(join(vendor, 'provenance.json'), 'utf8'));
const installed = dirname(require.resolve('braces/package.json'));
const braces = require('braces');
const work = mkdtempSync(join(tmpdir(), 'rewind-braces-security-'));
after(() => rmSync(work, { recursive: true, force: true }));
// Copy the baseline's dependency closure outside the byte-verified source tree.
for (const name of ['fill-range', 'to-regex-range', 'is-number']) {
  cpSync(dirname(require.resolve(`${name}/package.json`)), join(work, 'node_modules', name), {
    recursive: true,
  });
}
const baseline = join(work, 'original');
cpSync(installed, baseline, { recursive: true });
execFileSync('patch', ['-R', '-V', 'never', '-p1', '--input', join(vendor, 'depth.patch')], {
  cwd: baseline,
});
// BSD patch leaves backups even with -V never. Remove only its known outputs;
// the reconstructed source bytes and installed file inventory remain asserted.
for (const file of Object.keys(provenance.upstream.filesSha256)) {
  rmSync(join(baseline, `${file}.orig`), { force: true });
}
const originalMetadata = JSON.parse(readFileSync(join(baseline, 'package.json'), 'utf8'));
originalMetadata.name = 'braces';
originalMetadata.version = '3.0.3';
originalMetadata.description = originalMetadata.description.replace(
  ' Rewind local security backport; not an upstream release.',
  '',
);
delete originalMetadata.rewindSecurityBackport;
writeFileSync(join(baseline, 'package.json'), `${JSON.stringify(originalMetadata, null, 2)}\n`);
const original = require(join(baseline, 'index.js'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

function filesIn(directory, prefix = '') {
  return readdirSync(directory).flatMap((file) => {
    const path = join(directory, file);
    return lstatSync(path).isDirectory()
      ? filesIn(path, `${prefix}${file}/`)
      : [`${prefix}${file}`];
  });
}

// Fix the stack budget so V8 optimization cannot make the negative control
// depend on the host Node version; guarded and benign inputs use this same budget.
function child(source) {
  return spawnSync(
    process.execPath,
    ['--max-old-space-size=128', '--stack-size=512', '-e', source],
    {
      timeout: 10000,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: join(root, 'node_modules') },
    },
  );
}

test('fork retains every upstream file, MIT license, authors and pinned provenance', () => {
  assert.deepEqual(filesIn(installed).sort(), Object.keys(provenance.upstream.filesSha256).sort());
  assert.deepEqual(filesIn(baseline).sort(), Object.keys(provenance.upstream.filesSha256).sort());
  for (const [file, hash] of Object.entries(provenance.upstream.filesSha256)) {
    assert.equal(sha256(readFileSync(join(baseline, file))), hash, file);
  }
  assert.equal(sha256(readFileSync(join(vendor, 'depth.patch'))), provenance.patch.sha256);
  assert.deepEqual(
    readFileSync(join(installed, 'LICENSE')),
    readFileSync(join(baseline, 'LICENSE')),
  );
  const metadata = require('braces/package.json');
  assert.equal(metadata.name, '@rewind/braces');
  assert.equal(metadata.version, '3.0.3-rewind.1');
  assert.equal(metadata.license, 'MIT');
  assert.deepEqual(metadata.author, originalMetadata.author);
  assert.deepEqual(metadata.contributors, originalMetadata.contributors);
  assert.equal(metadata.rewindSecurityBackport.upstreamPatchCommit, provenance.patch.commit);
});

test('all micromatch consumers install one physical integrity-pinned fork', () => {
  assert.equal(lstatSync(installed).isSymbolicLink(), false);
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith('/braces'));
  assert.equal(entries.length, 1);
  const [, pinned] = entries[0];
  assert.equal(pinned.name, provenance.fork.name);
  assert.equal(pinned.version, provenance.fork.version);
  assert.equal(pinned.resolved, `file:vendor/braces/${provenance.fork.archive}`);
  assert.equal(pinned.integrity, provenance.fork.integrity);
  assert.equal(integrity(readFileSync(join(vendor, provenance.fork.archive))), pinned.integrity);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (entry.dependencies?.braces) {
      const consumer = createRequire(join(root, path, 'package.json'));
      assert.equal(consumer.resolve('braces'), require.resolve('braces'), path);
    }
  }
});

for (const api of ['compile', 'expand']) {
  test(`negative control: original ${api} exhausts the stack under the character cap`, () => {
    const result = child(
      `require(${JSON.stringify(join(baseline, 'index.js'))}).${api}('{'.repeat(4800)+'a,b'+'}'.repeat(4800))`,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Maximum call stack size exceeded/);
  });
}

test('every public string entry point rejects deep braces, parentheses and malformed nesting in bounded children', () => {
  const result = child(`
    const assert = require('node:assert/strict');
    const b = require(${JSON.stringify(join(installed, 'index.js'))});
    const methods = [p => b(p), p => b([p]), p => b.create(p), p => b(p, {expand: true}),
      p => b.create(p, {expand: true}), p => b.parse(p), p => b.compile(p), p => b.expand(p), p => b.stringify(p)];
    for (const depth of [101, 500, 4800]) {
      const patterns = ['{'.repeat(depth)+'a,b'+'}'.repeat(depth), '('.repeat(depth)+'a'+')'.repeat(depth),
        '{'.repeat(depth)+'a', '('.repeat(depth)+'a', '{'.repeat(depth)+'a' + ')'.repeat(depth)];
      for (const pattern of patterns) for (const method of methods) {
        assert.throws(() => method(pattern), e => e instanceof SyntaxError && /exceeds max depth/.test(e.message));
      }
    }
    for (const option of [1e9, Infinity, NaN, 'unlimited']) {
      assert.throws(() => b.compile('{'.repeat(101)+'a,b'+'}'.repeat(101), {maxDepth: option}), /exceeds max depth/);
    }
    assert.throws(() => b.parse('{('.repeat(51)+'a'+')}'.repeat(51)), /exceeds max depth/);
    console.log('guarded');
  `);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /guarded/);
});

test('caller-supplied and cyclic ASTs cannot bypass compile, expand or stringify depth guards', () => {
  const result = child(`
    const assert = require('node:assert/strict');
    const b = require(${JSON.stringify(join(installed, 'index.js'))});
    const original = require(${JSON.stringify(join(baseline, 'index.js'))});
    for (const method of ['compile', 'expand', 'stringify']) {
      for (const depth of [101, 500, 4800]) {
        for (const open of ['{', '(']) {
          const ast = original.parse(open.repeat(depth)+'a,b'+(open === '{' ? '}' : ')').repeat(depth));
          assert.throws(() => b[method](ast), /exceeds max depth/);
          assert.throws(() => b[method](ast, {maxDepth: 1e9}), /exceeds max depth/);
        }
      }
      const cycle = {type: 'root', nodes: []}; cycle.nodes.push(cycle);
      assert.throws(() => b[method](cycle), /exceeds max depth/);
      const ast = original.parse('{{a,b},c}');
      assert.throws(() => b[method](ast, {maxDepth: 1}), /exceeds max depth/);
      assert.throws(() => b[method](ast.nodes[1], {maxDepth: 1}), /exceeds max depth/);
    }
    console.log('AST guarded');
  `);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AST guarded/);
});

test('allowed depth boundary, literal syntax and real glob patterns preserve upstream behavior', () => {
  const patterns = [
    'src/**/*.{ts,tsx}',
    '*.{js,{ts,tsx}}',
    'a/{b,c}/d',
    '{01..05}',
    '{a..z..3}',
    '*(a|{b|c,d})',
    '${a,b}',
    '\\{a,b\\}',
    '[{()}]',
    '"{{literal}}"',
    '{unclosed',
    'foo)bar',
    '{'.repeat(100) + 'a,b' + '}'.repeat(100),
    '('.repeat(100) + 'a' + ')'.repeat(100),
    '\\{'.repeat(200),
    '"' + '{('.repeat(200) + '"',
    '[' + '{('.repeat(200) + ']',
  ];
  for (const pattern of patterns) {
    for (const options of [
      {},
      { escapeInvalid: true },
      { keepEscaping: true },
      { keepQuotes: true },
      { nodupes: true, noempty: true },
    ]) {
      for (const method of ['compile', 'expand', 'stringify']) {
        assert.deepEqual(
          braces[method](pattern, options),
          original[method](pattern, options),
          `${method}: ${pattern}`,
        );
      }
    }
  }
  assert.doesNotThrow(() => braces.compile('{{a,b},c}', { maxDepth: 2 }));
  assert.throws(() => braces.parse('{a,b}', { maxDepth: 0 }), /exceeds max depth/);
  assert.deepEqual(braces(['*.{js,ts}', '*.js'], { expand: true, nodupes: true }), [
    '*.js',
    '*.ts',
  ]);
  const micromatch = require('micromatch');
  assert.deepEqual(micromatch(['src/a.ts', 'src/b.tsx', 'src/c.txt'], 'src/**/*.{ts,tsx}'), [
    'src/a.ts',
    'src/b.tsx',
  ]);
  assert.deepEqual(micromatch.braces('*.{js,{ts,tsx}}'), ['*.(js|(ts|tsx))']);
});
