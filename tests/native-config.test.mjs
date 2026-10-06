import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

test('generated iOS configuration declares capture purposes and export compliance only', () => {
  // Introspection exercises the installed plugins without writing a native
  // project. This is not proof of a compiled plist or App Store upload.
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      ['node_modules/expo/bin/cli', 'config', '--type', 'introspect', '--json'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          CI: '1',
          EXPO_NO_DOTENV: '1',
          EXPO_OFFLINE: '1',
        },
      },
    ),
  );
  const plist = config._internal?.modResults?.ios?.infoPlist;
  assert.ok(plist, 'Expo must generate iOS Info.plist configuration');
  assert.equal(
    plist.NSCameraUsageDescription,
    'Rewind uses the camera to take the photos and videos you share with your group.',
  );
  assert.equal(
    plist.NSMicrophoneUsageDescription,
    'Rewind records sound with the videos you share with your group.',
  );
  assert.equal(plist.ITSAppUsesNonExemptEncryption, false);
  assert.deepEqual(
    Object.keys(plist)
      .filter((key) => key.endsWith('UsageDescription'))
      .sort(),
    ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'],
  );
});
