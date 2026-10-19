import { createInviteLink } from '../src/invites/deep-links';
import { formatInviteCode } from '../src/real/GroupFlows';

describe('invite code entry', () => {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it('formats typed codes as ABC-DEF', () => {
    expect(formatInviteCode('abcdef')).toBe('ABC-DEF');
    expect(formatInviteCode('ab')).toBe('AB');
  });

  it('takes the code from a pasted invite link instead of its URL letters', () => {
    const link = createInviteLink(
      { code: 'QWERTY', status: 'active', expiresAt },
      { platform: 'web', webOrigin: 'https://rewind.example', groupId: 'real-group-1' },
    );
    expect(link).toContain('https://rewind.example/');
    expect(formatInviteCode(link!)).toBe('QWE-RTY');
    expect(formatInviteCode(`  ${link}  `)).toBe('QWE-RTY');
  });
});
