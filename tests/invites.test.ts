import { isValidInviteCode, normalizeInviteCode } from '../src/domain/invites';

describe('invite code client validation', () => {
  it('normalizes casing and whitespace before validation', () => {
    expect(normalizeInviteCode(' ab12 cd34 ')).toBe('AB12CD34');
    expect(isValidInviteCode(' ab12 cd34 ')).toBe(true);
    expect(normalizeInviteCode('abc-def')).toBe('ABCDEF');
    expect(isValidInviteCode('abc-def')).toBe(true);
  });

  it('rejects codes outside six letters or legacy eight letters/digits', () => {
    expect(isValidInviteCode('short')).toBe(false);
    expect(isValidInviteCode('AB12-CD34')).toBe(true);
    expect(isValidInviteCode('AB1-DEF')).toBe(false);
    expect(isValidInviteCode('AB12CD3!')).toBe(false);
    expect(isValidInviteCode('AB12CD345')).toBe(false);
  });
});
