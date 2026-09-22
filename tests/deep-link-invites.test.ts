import {
  createInviteLink,
  isInviteLinkCandidate,
  parseInviteLink,
} from '../src/invites/deep-links';
import type { LocalInvite } from '../src/domain/invites';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const ACTIVE_INVITE: LocalInvite = {
  id: 'invite-ab12cd34',
  code: 'ab12cd34',
  groupId: 'private-group',
  status: 'active',
  createdAt: '2026-09-22T11:00:00.000Z',
  expiresAt: '2026-09-23T12:00:00.000Z',
  usedAt: null,
};

describe('invite deep-link contract', () => {
  it('creates native and web links without serializing private group metadata', () => {
    const nativeLink = createInviteLink(ACTIVE_INVITE, { platform: 'native', now: NOW });
    const webLink = createInviteLink(ACTIVE_INVITE, {
      platform: 'web',
      webOrigin: 'https://rewind.example/app?ignored=true',
      now: NOW,
    });

    expect(nativeLink).toBe('rewind://invite?code=AB12CD34&expiresAt=2026-09-23T12%3A00%3A00.000Z');
    expect(webLink).toBe(
      'https://rewind.example/invite?code=AB12CD34&expiresAt=2026-09-23T12%3A00%3A00.000Z',
    );
    expect(nativeLink).not.toContain('private-group');
    expect(webLink).not.toContain('private-group');
  });

  it('accepts valid native and web links and normalizes the bounded code', () => {
    expect(
      parseInviteLink('rewind://invite?code=ab12cd34&expiresAt=2026-09-23T12%3A00%3A00.000Z', NOW),
    ).toEqual({
      kind: 'valid',
      code: 'AB12CD34',
      expiresAt: '2026-09-23T12:00:00.000Z',
    });
    expect(
      parseInviteLink(
        'https://rewind.example/invite?code=AB12CD34&expiresAt=2026-09-23T12%3A00%3A00.000Z',
        NOW,
      ),
    ).toEqual({
      kind: 'valid',
      code: 'AB12CD34',
      expiresAt: '2026-09-23T12:00:00.000Z',
    });
  });

  it('returns metadata-free malformed and expired denials', () => {
    expect(parseInviteLink('rewind://invite?code=AB12CD34', NOW)).toEqual({
      kind: 'invalid',
      reason: 'malformed',
    });
    expect(
      parseInviteLink(
        'https://rewind.example/invite?code=AB12CD34&expiresAt=2026-09-22T12%3A00%3A00.000Z',
        NOW,
      ),
    ).toEqual({
      kind: 'invalid',
      reason: 'expired',
    });
    expect(
      parseInviteLink('https://rewind.example/groups/private-group?code=AB12CD34', NOW),
    ).toEqual({
      kind: 'invalid',
      reason: 'malformed',
    });
  });

  it('ignores ordinary app URLs while recognizing malformed invite-route URLs', () => {
    expect(isInviteLinkCandidate('https://rewind.example/')).toBe(false);
    expect(isInviteLinkCandidate('https://rewind.example/invite?code=bad')).toBe(true);
    expect(isInviteLinkCandidate('rewind://invite?code=bad')).toBe(true);
  });

  it('does not create links for expired or already-used invites', () => {
    expect(
      createInviteLink(
        { ...ACTIVE_INVITE, expiresAt: '2026-09-22T11:59:59.999Z' },
        { platform: 'native', now: NOW },
      ),
    ).toBeNull();
    expect(
      createInviteLink(
        { ...ACTIVE_INVITE, status: 'used' },
        { platform: 'web', webOrigin: 'https://rewind.example', now: NOW },
      ),
    ).toBeNull();
  });
});
