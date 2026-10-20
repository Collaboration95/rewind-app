import {
  createInviteLink,
  isInviteLinkCandidate,
  parseInviteLink,
} from '../src/invites/deep-links';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const EXPIRES = '2026-09-23T12:00:00.000Z';
const invite = { code: 'AB12CD34', status: 'active' as const, expiresAt: EXPIRES };
const query = `code=AB12CD34&expiresAt=${encodeURIComponent(EXPIRES)}`;

describe('createInviteLink refusals', () => {
  it('returns no link for a web invite without a usable origin', () => {
    expect(createInviteLink(invite, { platform: 'web', now: NOW })).toBeNull();
    expect(
      createInviteLink(invite, { platform: 'web', webOrigin: 'not a url', now: NOW }),
    ).toBeNull();
    expect(
      createInviteLink(invite, { platform: 'web', webOrigin: 'ftp://rewind.example', now: NOW }),
    ).toBeNull();
  });

  it('refuses group links that are not safe to share', () => {
    const base = { platform: 'web' as const, webOrigin: 'https://rewind.example', now: NOW };
    expect(createInviteLink(invite, { ...base, groupId: '../etc' })).toBeNull();
    expect(createInviteLink(invite, { ...base, groupId: '' })).toBeNull();
    expect(createInviteLink(invite, { ...base, groupId: 'g'.repeat(129) })).toBeNull();
    expect(
      createInviteLink(invite, { ...base, webOrigin: 'http://rewind.example', groupId: 'g1' }),
    ).toBeNull();
    expect(createInviteLink(invite, { platform: 'native', groupId: 'g1', now: NOW })).toBeNull();
  });

  it('refuses used, expired or malformed invites', () => {
    const native = { platform: 'native' as const, now: NOW };
    expect(createInviteLink({ ...invite, status: 'used' }, native)).toBeNull();
    expect(createInviteLink({ ...invite, status: 'expired' }, native)).toBeNull();
    expect(
      createInviteLink({ ...invite, expiresAt: '2026-09-22T11:59:59.000Z' }, native),
    ).toBeNull();
    expect(createInviteLink({ ...invite, expiresAt: 'soon' }, native)).toBeNull();
    expect(createInviteLink({ ...invite, code: 'short' }, native)).toBeNull();
  });

  it('allows plain http origins for group-less web links (local runs)', () => {
    expect(
      createInviteLink(invite, { platform: 'web', webOrigin: 'http://localhost:8090/x', now: NOW }),
    ).toBe(`http://localhost:8090/invite?${query}`);
  });

  it('defaults to the current time for expiry checks', () => {
    jest.useFakeTimers({ now: NOW });
    try {
      expect(createInviteLink(invite, { platform: 'native' })).toContain('rewind://invite');
      jest.setSystemTime(Date.parse(EXPIRES) + 1);
      expect(createInviteLink(invite, { platform: 'native' })).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('isInviteLinkCandidate', () => {
  it('recognises the native and web invite routes only', () => {
    expect(isInviteLinkCandidate(`rewind://invite?${query}`)).toBe(true);
    expect(isInviteLinkCandidate(`rewind://invite/?${query}`)).toBe(true);
    expect(isInviteLinkCandidate(`https://rewind.example/invite?${query}`)).toBe(true);
    expect(isInviteLinkCandidate(`https://rewind.example/invite/?${query}`)).toBe(true);
  });

  it('rejects other hosts, paths, schemes and non-URLs', () => {
    expect(isInviteLinkCandidate('rewind://settings')).toBe(false);
    expect(isInviteLinkCandidate('rewind://invite/extra')).toBe(false);
    expect(isInviteLinkCandidate('https://rewind.example/other')).toBe(false);
    expect(isInviteLinkCandidate('ftp://rewind.example/invite')).toBe(false);
    expect(isInviteLinkCandidate('javascript:alert(1)')).toBe(false);
    expect(isInviteLinkCandidate('not a url')).toBe(false);
    expect(isInviteLinkCandidate('')).toBe(false);
  });
});

describe('parseInviteLink', () => {
  const malformed = { kind: 'invalid', reason: 'malformed' };

  it('parses a valid native link and normalizes the code', () => {
    expect(
      parseInviteLink(
        `rewind://invite?code=ab12cd34&expiresAt=${encodeURIComponent(EXPIRES)}`,
        NOW,
      ),
    ).toEqual({ kind: 'valid', code: 'AB12CD34', expiresAt: EXPIRES });
  });

  it('parses a universal https link carrying a group id', () => {
    expect(
      parseInviteLink(`https://rewind.example/invite?groupId=real-group-1&${query}`, NOW),
    ).toEqual({ kind: 'valid', code: 'AB12CD34', expiresAt: EXPIRES, groupId: 'real-group-1' });
  });

  it('refuses a group id on http or native links', () => {
    expect(parseInviteLink(`http://rewind.example/invite?groupId=g1&${query}`, NOW)).toEqual(
      malformed,
    );
    expect(parseInviteLink(`rewind://invite?groupId=g1&${query}`, NOW)).toEqual(malformed);
  });

  it.each([
    ['an unparseable value', 'not a url'],
    ['another route', `https://rewind.example/home?${query}`],
    ['a missing code', `https://rewind.example/invite?expiresAt=${EXPIRES}`],
    ['a missing expiry', 'https://rewind.example/invite?code=AB12CD34'],
    ['a repeated code', `https://rewind.example/invite?${query}&code=ZZ99ZZ99`],
    ['a repeated expiry', `https://rewind.example/invite?${query}&expiresAt=${EXPIRES}`],
    ['a repeated group id', `https://rewind.example/invite?groupId=a&groupId=b&${query}`],
    ['an invalid code', `https://rewind.example/invite?code=nope&expiresAt=${EXPIRES}`],
    ['an unparseable expiry', 'https://rewind.example/invite?code=AB12CD34&expiresAt=soon'],
    ['an unsafe group id', `https://rewind.example/invite?groupId=-bad&${query}`],
  ])('treats %s as malformed', (_name, link) => {
    expect(parseInviteLink(link, NOW)).toEqual(malformed);
  });

  it('reports an expired link without disclosing its payload', () => {
    expect(parseInviteLink(`rewind://invite?${query}`, Date.parse(EXPIRES) + 1)).toEqual({
      kind: 'invalid',
      reason: 'expired',
    });
  });

  it('defaults to the current time', () => {
    jest.useFakeTimers({ now: Date.parse(EXPIRES) + 1000 });
    try {
      expect(parseInviteLink(`rewind://invite?${query}`)).toEqual({
        kind: 'invalid',
        reason: 'expired',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
