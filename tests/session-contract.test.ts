import {
  classifyDemoSession,
  DEMO_SESSION_LIFETIME_MS,
  demoSessionExpiry,
} from '../src/domain/session';

describe('local Demo session contract', () => {
  it('uses a finite default lifetime and deterministic expiry', () => {
    expect(DEMO_SESSION_LIFETIME_MS).toBe(8 * 60 * 60 * 1000);
    expect(demoSessionExpiry('2026-09-10T12:00:00.000Z')).toBe('2026-09-10T20:00:00.000Z');
  });

  it('defines invalidation before expiry and expiry at the boundary', () => {
    const expiresAt = '2026-09-10T20:00:00.000Z';
    expect(classifyDemoSession(expiresAt, null, new Date('2026-09-10T19:59:59.999Z'))).toBe(
      'valid',
    );
    expect(classifyDemoSession(expiresAt, null, new Date(expiresAt))).toBe('expired');
    expect(
      classifyDemoSession(
        expiresAt,
        '2026-09-10T12:01:00.000Z',
        new Date('2026-09-10T19:00:00.000Z'),
      ),
    ).toBe('invalidated');
  });

  it('rejects malformed dates and non-positive lifetimes', () => {
    expect(() => demoSessionExpiry('not-a-date')).toThrow(/ISO-8601/);
    expect(() => demoSessionExpiry('2026-09-10T12:00:00.000Z', 0)).toThrow(/positive/);
  });
});
