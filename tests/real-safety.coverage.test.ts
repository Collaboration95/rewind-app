import { Linking, Platform } from 'react-native';

import {
  blockMember,
  listBlocked,
  openLegalPage,
  reportContent,
  unblockMember,
} from '../src/real/safety';

const originalOS = Platform.OS;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalOrigin = process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN;

function reply(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function setPlatform(os: string) {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os, writable: true });
}

afterEach(() => {
  setPlatform(originalOS);
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
  if (originalOrigin === undefined) delete process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN;
  else process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN = originalOrigin;
  jest.restoreAllMocks();
});

describe('reportContent', () => {
  it('posts the target and reason to the encoded group reports path', async () => {
    const request = jest.fn().mockResolvedValue(reply(201));

    await reportContent(request, 'group/1', { messageId: 'm-1' }, 'spam');

    expect(request).toHaveBeenCalledTimes(1);
    const [path, init] = request.mock.calls[0];
    expect(path).toBe('/real/groups/group%2F1/reports');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ messageId: 'm-1', reason: 'spam' });
  });

  it('supports moment and person targets', async () => {
    const request = jest.fn().mockResolvedValue(reply(201));

    await reportContent(request, 'g', { contributionId: 'c-1' }, 'abuse');
    await reportContent(request, 'g', { memberId: 'p-1' }, 'harassment');

    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      contributionId: 'c-1',
      reason: 'abuse',
    });
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({
      memberId: 'p-1',
      reason: 'harassment',
    });
  });

  it('shows the server rate-limit message on 429', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(reply(429, { message: 'Too many reports. Try again in an hour.' }));

    await expect(reportContent(request, 'g', { messageId: 'm' }, 'spam')).rejects.toThrow(
      'Too many reports. Try again in an hour.',
    );
  });

  it('uses the generic message for other failures even when the body has a message', async () => {
    const request = jest.fn().mockResolvedValue(reply(500, { message: 'internal stack detail' }));

    await expect(reportContent(request, 'g', { messageId: 'm' }, 'spam')).rejects.toThrow(
      'The report could not be sent. Try again.',
    );
  });

  it('falls back to the generic message when a 429 has no usable body', async () => {
    const unreadable = {
      ok: false,
      status: 429,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response;
    const request = jest
      .fn()
      .mockResolvedValueOnce(unreadable)
      .mockResolvedValueOnce(reply(429, { message: '   ' }));

    await expect(reportContent(request, 'g', { messageId: 'm' }, 'spam')).rejects.toThrow(
      'The report could not be sent. Try again.',
    );
    await expect(reportContent(request, 'g', { messageId: 'm' }, 'spam')).rejects.toThrow(
      'The report could not be sent. Try again.',
    );
  });

  it('propagates a transport failure unchanged', async () => {
    const request = jest.fn().mockRejectedValue(new Error('offline'));

    await expect(reportContent(request, 'g', { messageId: 'm' }, 'spam')).rejects.toThrow(
      'offline',
    );
  });
});

describe('blockMember and unblockMember', () => {
  it('blocks by profile id', async () => {
    const request = jest.fn().mockResolvedValue(reply(201));

    await blockMember(request, 'profile-9');

    const [path, init] = request.mock.calls[0];
    expect(path).toBe('/real/blocks');
    expect(JSON.parse(init.body)).toEqual({ profileId: 'profile-9' });
  });

  it('reports a block failure and its rate-limit message', async () => {
    await expect(blockMember(jest.fn().mockResolvedValue(reply(500)), 'p')).rejects.toThrow(
      'That person could not be blocked. Try again.',
    );
    await expect(
      blockMember(jest.fn().mockResolvedValue(reply(429, { message: 'Slow down.' })), 'p'),
    ).rejects.toThrow('Slow down.');
  });

  it('unblocks with DELETE on the encoded profile path', async () => {
    const request = jest.fn().mockResolvedValue(reply(204));

    await unblockMember(request, 'a/b');

    expect(request).toHaveBeenCalledWith('/real/blocks/a%2Fb', { method: 'DELETE' });
  });

  it('reports an unblock failure and its rate-limit message', async () => {
    await expect(unblockMember(jest.fn().mockResolvedValue(reply(403)), 'p')).rejects.toThrow(
      'That person could not be unblocked. Try again.',
    );
    await expect(
      unblockMember(jest.fn().mockResolvedValue(reply(429, { message: 'Wait a minute.' })), 'p'),
    ).rejects.toThrow('Wait a minute.');
  });
});

describe('listBlocked', () => {
  it('returns the set of blocked profile ids', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(reply(200, { blocked: [{ profileId: 'a' }, { profileId: 'b' }] }));

    await expect(listBlocked(request)).resolves.toEqual(new Set(['a', 'b']));
    expect(request).toHaveBeenCalledWith('/real/blocks');
  });

  it('returns an empty set when nobody is blocked or the field is missing', async () => {
    await expect(
      listBlocked(jest.fn().mockResolvedValue(reply(200, { blocked: [] }))),
    ).resolves.toEqual(new Set());
    await expect(listBlocked(jest.fn().mockResolvedValue(reply(200, {})))).resolves.toEqual(
      new Set(),
    );
  });

  it('deduplicates repeated ids', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(reply(200, { blocked: [{ profileId: 'a' }, { profileId: 'a' }] }));

    expect((await listBlocked(request)).size).toBe(1);
  });

  it('throws a readable error when the list cannot be loaded', async () => {
    await expect(listBlocked(jest.fn().mockResolvedValue(reply(503)))).rejects.toThrow(
      'Blocked people could not be loaded.',
    );
  });
});

describe('openLegalPage', () => {
  it('opens the page in a new noopener tab on web', () => {
    setPlatform('web');
    const open = jest.fn();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { open } });
    const openURL = jest.spyOn(Linking, 'openURL');

    openLegalPage('/privacy');

    expect(open).toHaveBeenCalledWith('/privacy', '_blank', 'noopener');
    expect(openURL).not.toHaveBeenCalled();
  });

  it('opens the configured public origin through Linking on native', () => {
    setPlatform('ios');
    process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN = 'https://rewind.example.com/';
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    openLegalPage('/terms');

    expect(openURL).toHaveBeenCalledWith('https://rewind.example.com/terms');
  });

  it('swallows a Linking rejection instead of crashing the screen', async () => {
    setPlatform('android');
    process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN = 'https://rewind.example.com';
    const openURL = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));

    expect(() => openLegalPage('/support')).not.toThrow();
    await Promise.resolve();
    expect(openURL).toHaveBeenCalledWith('https://rewind.example.com/support');
  });

  it('does nothing on native when no valid public origin is configured', () => {
    setPlatform('ios');
    process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN = 'http://insecure.example.com';
    const openURL = jest.spyOn(Linking, 'openURL');

    openLegalPage('/privacy');

    expect(openURL).not.toHaveBeenCalled();
  });
});
