// The version flags are read once at bundle time (#491).
const load = (env: Record<string, string | undefined>) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let version!: typeof import('../src/runtime/version');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    version = require('../src/runtime/version');
  });
  process.env = saved;
  return version;
};

it('shows the branch and short hash only when the build turns the flag on', () => {
  expect(
    load({
      EXPO_PUBLIC_DISPLAY_CURRENT_VERSION: 'true',
      EXPO_PUBLIC_CURRENT_VERSION: 'dev-1a2b3c4',
    }),
  ).toEqual({ DISPLAY_CURRENT_VERSION: true, CURRENT_VERSION: 'dev-1a2b3c4' });
  expect(
    load({ EXPO_PUBLIC_DISPLAY_CURRENT_VERSION: 'false', EXPO_PUBLIC_CURRENT_VERSION: undefined }),
  ).toEqual({ DISPLAY_CURRENT_VERSION: false, CURRENT_VERSION: 'local' });
});
