import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value);
export function buildEnvironment(apiUrl, inviteUrl) {
  const parse = (value, originOnly) => {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (originOnly && url.pathname !== '/')
    )
      throw new Error('Build requires explicit credential-free HTTPS API URL and invite origin.');
    return originOnly ? url.origin : url.href.replace(/\/$/, '');
  };
  return {
    EXPO_PUBLIC_LOCAL_BASE_URL: parse(apiUrl, false),
    EXPO_PUBLIC_INVITE_WEB_ORIGIN: parse(inviteUrl, true),
    EXPO_PUBLIC_DEMO_ACCESS: 'disabled',
  };
}
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function safeInput(path) {
  if (
    !path ||
    isAbsolute(path) ||
    path.split('/').includes('..') ||
    /(^|\/)(\.env(?:\..*)?|credentials\.json|.*\.(?:keystore|jks|p12|mobileprovision))$/.test(path)
  )
    throw new Error('Unsafe or credential-bearing native build input.');
}
async function snapshot(root, paths) {
  const hash = createHash('sha256');
  for (const path of paths) {
    safeInput(path);
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Native source inputs must be regular files.');
    hash.update(path + '\0');
    hash.update(await readFile(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
export function validateProfiles(app, eas) {
  if (
    app.expo.scheme !== 'rewind' ||
    !app.expo.android?.package ||
    !app.expo.ios?.bundleIdentifier ||
    !Number.isInteger(app.expo.android.versionCode) ||
    !/^\d+$/.test(app.expo.ios.buildNumber) ||
    app.expo.updates?.enabled !== false ||
    eas.cli?.appVersionSource !== 'local' ||
    !eas.cli.requireCommit
  )
    throw new Error('Native identity/version/update contract is incomplete.');
  const android = eas.build?.['preview-apk'],
    simulator = eas.build?.['preview-ios-simulator'];
  if (
    android?.android?.buildType !== 'apk' ||
    android.android.credentialsSource !== 'local' ||
    simulator?.ios?.simulator !== true ||
    simulator.ios.buildConfiguration !== 'Release' ||
    !simulator.ios.withoutCredentials ||
    [android, simulator].some(
      (p) =>
        p.autoIncrement !== false ||
        p.environment !== 'preview' ||
        p.env?.EXPO_PUBLIC_DEMO_ACCESS !== 'disabled' ||
        p.developmentClient,
    )
  )
    throw new Error('Preview profiles must isolate APK and credential-free iOS simulator builds.');
  return {
    scheme: app.expo.scheme,
    androidPackage: app.expo.android.package,
    iosBundleIdentifier: app.expo.ios.bundleIdentifier,
    version: app.expo.version,
    androidVersionCode: app.expo.android.versionCode,
    iosBuildNumber: app.expo.ios.buildNumber,
    updates: 'embedded-only',
  };
}
/** Stage a precise source snapshot, never invoke remote EAS or install a device
 * app. Explicit overlay files allow an unmerged config rehearsal; acceptance
 * still requires a clean reviewed commit and subsequent native smoke. */
export async function prepareNativeBuild({
  projectRoot,
  outputRoot,
  acceptedBase,
  overlays = [],
  apiUrl,
  inviteUrl,
  platform = 'android',
}) {
  const root = resolve(projectRoot),
    output = resolve(outputRoot);
  if (
    !['android', 'ios'].includes(platform) ||
    !isAbsolute(outputRoot) ||
    output === root ||
    !relative(root, output).startsWith('..') ||
    !/^[a-f0-9]{40}$/.test(acceptedBase)
  )
    throw new Error('Use an external disposable output directory and exact accepted base SHA.');
  git(root, 'merge-base', '--is-ancestor', acceptedBase, 'HEAD');
  const publicEnvironment = buildEnvironment(apiUrl, inviteUrl);
  const head = git(root, 'rev-parse', 'HEAD');
  const dirty = git(root, 'status', '--porcelain', '--untracked-files=all');
  const paths = git(root, 'ls-files', '-z')
    .split('\0')
    .filter(Boolean)
    .filter(
      (path) =>
        !path.startsWith('.claude/') &&
        !path.startsWith('.codex/') &&
        !path.startsWith('.opencode/'),
    );
  for (const overlay of overlays) {
    safeInput(overlay);
    if (!['app.json', 'eas.json', 'package.json', 'scripts/native-build.mjs'].includes(overlay))
      throw new Error('Only #351 config/build-script overlays are permitted.');
    if (!paths.includes(overlay)) paths.push(overlay);
  }
  if (overlays.includes('package.json')) {
    const before = JSON.parse(git(root, 'show', 'HEAD:package.json'));
    const after = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    delete before.scripts;
    delete after.scripts;
    if (canonical(before) !== canonical(after))
      throw new Error('Package overlays may change build/test scripts only.');
  }
  paths.sort();
  // Every dirty tracked file must be an explicitly allowed preview overlay.
  const dirtyTracked = git(root, 'diff', 'HEAD', '--name-only').split('\n').filter(Boolean);
  if (dirtyTracked.some((path) => !overlays.includes(path)))
    throw new Error('Unreviewed changes outside explicit preview overlays.');
  const sourceDigest = await snapshot(root, paths);
  const app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8'));
  const eas = JSON.parse(await readFile(join(root, 'eas.json'), 'utf8'));
  const identity = validateProfiles(app, eas);
  const configDigest = sha256(canonical({ app, eas }));
  const originDigest = sha256(canonical(publicEnvironment));
  await mkdir(output, { recursive: false, mode: 0o700 });
  const source = join(output, 'source');
  await mkdir(source, { mode: 0o700 });
  for (const path of paths) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await copyFile(join(root, path), join(source, path), constants.COPYFILE_EXCL);
  }
  if (
    (await snapshot(source, paths)) !== sourceDigest ||
    (await snapshot(root, paths)) !== sourceDigest ||
    git(root, 'rev-parse', 'HEAD') !== head ||
    git(root, 'status', '--porcelain', '--untracked-files=all') !== dirty
  )
    throw new Error('Native build inputs changed during staging.');
  const expoPackage = JSON.parse(
    await readFile(join(root, 'node_modules/expo/package.json'), 'utf8'),
  );
  const rnPackage = JSON.parse(
    await readFile(join(root, 'node_modules/react-native/package.json'), 'utf8'),
  );
  await symlink(join(root, 'node_modules'), join(source, 'node_modules'));
  const provenance = {
    schema: 1,
    issue: 351,
    acceptedBase,
    sourceCommit: head,
    sourceDigest,
    sourcePaths: paths,
    configDigest,
    originDigest,
    publicEnvironment,
    platform,
    profile: platform === 'android' ? 'preview-apk' : 'preview-ios-simulator',
    identity,
    sourceStatus:
      dirty || overlays.length || head !== acceptedBase ? 'unmerged-preview' : 'accepted-base',
    overlays,
    toolchain: {
      node: process.versions.node,
      expo: expoPackage.version,
      reactNative: rnPackage.version,
      dependencies:
        'shared-installed-tree; run npm ci from locked source for an independent reproduction',
    },
    outputStatus: 'prepared-not-built',
    acceptance: 'pending-review-install-and-native-smoke',
    rebuildFor: [
      'Sprint 3 OIDC',
      'remote push',
      'client-retro',
      'native/config/API-origin changes',
    ],
  };
  await writeFile(join(output, 'provenance.json'), canonical(provenance) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  // Only explicitly approved public values reach Metro; no copied .env files.
  await writeFile(join(output, 'public-env.json'), canonical(publicEnvironment) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return { outputRoot: output, source, provenance };
}
/** Attach bytes only after a successful compile; checksum and source/config
 * provenance must travel together. This does not claim install/signing smoke. */
export async function recordNativeArtifact(outputRoot, artifactPath) {
  const provenance = JSON.parse(await readFile(join(outputRoot, 'provenance.json'), 'utf8'));
  if (provenance.schema !== 1 || provenance.outputStatus !== 'prepared-not-built')
    throw new Error('Invalid prepared native provenance.');
  if (
    (await snapshot(join(outputRoot, 'source'), provenance.sourcePaths)) !==
      provenance.sourceDigest ||
    sha256(canonical(JSON.parse(await readFile(join(outputRoot, 'public-env.json'), 'utf8')))) !==
      provenance.originDigest
  )
    throw new Error('Native source/origin inputs changed after preparation.');
  const app = JSON.parse(await readFile(join(outputRoot, 'source/app.json'), 'utf8'));
  const eas = JSON.parse(await readFile(join(outputRoot, 'source/eas.json'), 'utf8'));
  if (sha256(canonical({ app, eas })) !== provenance.configDigest)
    throw new Error('Native configuration changed after preparation.');
  const handle = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !before.size) throw new Error('Native artifact is missing or empty.');
    const hash = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Native artifact changed while hashing.');
    const value = {
      ...provenance,
      outputStatus: 'compiled-unverified-preview',
      artifact: { path: resolve(artifactPath), byteLength: after.size, sha256: hash.digest('hex') },
    };
    await writeFile(join(outputRoot, 'artifact.json'), canonical(value) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return value;
  } finally {
    await handle.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'prepare') {
      const [outputRoot, acceptedBase, platform, apiUrl, inviteUrl, ...overlays] = args;
      const result = await prepareNativeBuild({
        projectRoot: process.cwd(),
        outputRoot,
        acceptedBase,
        platform,
        apiUrl,
        inviteUrl,
        overlays,
      });
      console.log(
        `Prepared ${result.provenance.sourceStatus} ${result.provenance.profile}: ${result.outputRoot}`,
      );
    } else if (command === 'record' && args.length === 2) {
      const result = await recordNativeArtifact(...args);
      console.log(`Recorded unverified preview artifact: ${result.artifact.sha256}`);
    } else
      throw new Error(
        'Usage: native-build.mjs prepare OUTPUT BASE_SHA android|ios HTTPS_API HTTPS_INVITE [OVERLAY...] | record OUTPUT ARTIFACT',
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
