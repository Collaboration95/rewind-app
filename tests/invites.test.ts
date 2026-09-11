import { isValidInviteCode, normalizeInviteCode } from '../src/domain/invites';

describe('invite code client validation', () => {
  it('normalizes casing and whitespace before validation', () => {
    expect(normalizeInviteCode(' ab12 cd34 ')).toBe('AB12CD34');
    expect(isValidInviteCode(' ab12 cd34 ')).toBe(true);
  });

  it('rejects codes that do not contain exactly eight letters or digits', () => {
    expect(isValidInviteCode('short')).toBe(false);
    expect(isValidInviteCode('AB12-CD34')).toBe(false);
    expect(isValidInviteCode('AB12CD3!')).toBe(false);
    expect(isValidInviteCode('AB12CD345')).toBe(false);
  });
});
