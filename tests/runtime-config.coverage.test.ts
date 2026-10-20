import { getConfiguredInviteWebOrigin, getLocalRuntimeBaseUrl } from '../src/runtime/config';

const INVITE = 'EXPO_PUBLIC_INVITE_WEB_ORIGIN';
const BASE = 'EXPO_PUBLIC_LOCAL_BASE_URL';
const saved = { [INVITE]: process.env[INVITE], [BASE]: process.env[BASE] };

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore(INVITE, saved[INVITE]);
  restore(BASE, saved[BASE]);
});

describe('getConfiguredInviteWebOrigin', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('returns null when the variable is %s', (_label, value) => {
    restore(INVITE, value);

    expect(getConfiguredInviteWebOrigin()).toBeNull();
  });

  it('normalizes a clean HTTPS origin, with or without a trailing slash or padding', () => {
    process.env[INVITE] = '  https://rewind.example.com/  ';
    expect(getConfiguredInviteWebOrigin()).toBe('https://rewind.example.com');

    process.env[INVITE] = 'https://rewind.example.com:8443';
    expect(getConfiguredInviteWebOrigin()).toBe('https://rewind.example.com:8443');
  });

  it.each([
    ['plain HTTP', 'http://rewind.example.com'],
    ['a non-web scheme', 'rewind://invite'],
    ['a path', 'https://rewind.example.com/app'],
    ['a query string', 'https://rewind.example.com/?a=1'],
    ['a fragment', 'https://rewind.example.com/#frag'],
    ['embedded credentials', 'https://user:pass@rewind.example.com'],
    ['a username only', 'https://user@rewind.example.com'],
    ['an unparseable value', 'not a url'],
  ])('rejects %s so share links can never point somewhere unsafe', (_label, value) => {
    process.env[INVITE] = value;

    expect(getConfiguredInviteWebOrigin()).toBeNull();
  });
});

describe('getLocalRuntimeBaseUrl', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '  \t '],
  ])('returns null when the variable is %s', (_label, value) => {
    restore(BASE, value);

    expect(getLocalRuntimeBaseUrl()).toBeNull();
  });

  it('trims whitespace and strips exactly one trailing slash', () => {
    process.env[BASE] = ' http://192.168.1.20:8080/ ';
    expect(getLocalRuntimeBaseUrl()).toBe('http://192.168.1.20:8080');

    process.env[BASE] = 'https://api.example.com/v1';
    expect(getLocalRuntimeBaseUrl()).toBe('https://api.example.com/v1');
  });
});

describe('when process is unavailable', () => {
  it('falls back to null instead of throwing', () => {
    const original = globalThis.process;
    // Bundled web/native runtimes may not define `process` at all.
    Object.defineProperty(globalThis, 'process', { configurable: true, value: undefined });
    try {
      expect(getConfiguredInviteWebOrigin()).toBeNull();
      expect(getLocalRuntimeBaseUrl()).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'process', { configurable: true, value: original });
    }
  });
});
