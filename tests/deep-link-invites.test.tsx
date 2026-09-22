import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import { Linking, Platform, Share } from 'react-native';

import App from '../App';
import type { Cycle } from '../src/domain/cycles';
import type { Group } from '../src/domain/profiles';
import type { RuntimeClient } from '../src/runtime/local-runtime-client';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

const group: Group = {
  id: 'demo-group',
  name: 'Weekend People',
  memberIds: ['demo-1'],
  currentCycleId: 'demo-cycle',
  memberRoles: { 'demo-1': 'owner' },
  actingMemberRole: 'owner',
};

const cycle: Cycle = {
  id: 'demo-cycle',
  groupId: group.id,
  prompt: 'What made you pause and smile?',
  startsAt: '2026-09-22T00:00:00.000Z',
  endsAt: '2026-09-23T00:00:00.000Z',
  status: 'collecting',
  lockState: 'locked',
  quota: { maxCount: 5, maxSeconds: 30 },
  contributionUsage: { countUsed: 0, secondsUsed: 0 },
};

const invite = {
  id: 'invite-ab12cd34',
  code: 'AB12CD34',
  groupId: group.id,
  status: 'active' as const,
  createdAt: '2026-09-22T12:00:00.000Z',
  expiresAt: '2099-09-23T12:00:00.000Z',
  usedAt: null,
};

const originalPlatformOS = Platform.OS;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installWebPlatform(open: jest.Mock) {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: 'web',
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: 'https://rewind.example/',
        origin: 'https://rewind.example',
      },
      open,
    },
    writable: true,
  });
}

function runtime(overrides: Partial<RuntimeClient> = {}): RuntimeClient {
  return {
    baseUrl: 'http://runtime.test',
    getHealth: async () => ({
      ok: true,
      service: 'rewind-local-runtime',
      version: 'test',
      ready: true,
      checks: { sqlite: true, ffmpegConfigured: false },
      addresses: { local: 'http://runtime.test', lan: null },
    }),
    getGroupForMember: async () => group,
    getCurrentCycle: async () => cycle,
    advanceDemoCycle: async () => ({ kind: 'RecoverableFailure' }),
    ...overrides,
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});

afterEach(() => {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: originalPlatformOS,
    writable: true,
  });
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('invite deep-link app flow', () => {
  it('routes a valid native link to Settings and pre-fills the existing join field', async () => {
    jest
      .spyOn(Linking, 'getInitialURL')
      .mockResolvedValue('rewind://invite?code=AB12CD34&expiresAt=2099-09-23T12%3A00%3A00.000Z');

    const result = await render(<App runtimeClient={runtime()} />);
    const input = await result.findByTestId('invite-code-input');

    expect(input.props.value).toBe('AB12CD34');
    expect(
      result.getByText('Invite link ready. Review it below and accept the invitation.'),
    ).toBeTruthy();
    await result.unmount();
  });

  it('keeps malformed and expired links metadata-free while raw code fallback remains visible', async () => {
    jest
      .spyOn(Linking, 'getInitialURL')
      .mockResolvedValue(
        'https://rewind.example/invite?code=AB12CD34&expiresAt=2020-01-01T00%3A00%3A00.000Z',
      );

    const result = await render(<App runtimeClient={runtime()} />);
    const input = await result.findByTestId('invite-code-input');

    expect(input.props.value).toBe('');
    expect(
      result.getByText(
        'This invitation link has expired. Ask the owner for a new link or enter an invite code.',
      ),
    ).toBeTruthy();
    expect(result.queryByText('Other People')).toBeNull();

    await fireEvent.changeText(input, 'AB12CD34');
    expect(input.props.value).toBe('AB12CD34');
    await result.unmount();
  });

  it('uses the native share sheet and preserves explicit used-link denial', async () => {
    const acceptInvite = jest
      .fn()
      .mockRejectedValue(new Error('That invite code has already been used.'));
    const client = runtime({
      createInvite: async () => invite,
      acceptInvite,
    });
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const result = await render(<App runtimeClient={client} />);

    await fireEvent.press(await result.findByRole('tab', { name: 'Settings' }));
    await fireEvent.press(result.getByTestId('generate-invite'));
    await result.findByTestId('share-invite-link');
    await fireEvent.press(result.getByTestId('share-invite-link'));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('rewind://invite?code=AB12CD34'),
          url: 'rewind://invite?code=AB12CD34&expiresAt=2099-09-23T12%3A00%3A00.000Z',
        }),
      ),
    );

    const input = result.getByTestId('invite-code-input');
    await fireEvent.changeText(input, 'AB12CD34');
    await fireEvent.press(result.getByTestId('accept-invite'));
    await waitFor(() =>
      expect(result.getByText('That invite code has already been used.')).toBeTruthy(),
    );
    expect(result.queryByText('Other People')).toBeNull();
    await result.unmount();
  });

  it('treats identical warm links as distinct intents and removes the native listener', async () => {
    let receiveUrl: ((event: { url: string }) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(Linking, 'addEventListener').mockImplementation((_type, listener) => {
      receiveUrl = listener;
      return { remove };
    });
    const result = await render(<App runtimeClient={runtime()} />);
    await result.findByRole('tab', { name: 'Home', selected: true });
    const repeatedLink = 'rewind://invite?code=AB12CD34&expiresAt=2099-09-23T12%3A00%3A00.000Z';

    await act(async () => receiveUrl?.({ url: repeatedLink }));
    const firstInput = await result.findByTestId('invite-code-input');
    expect(firstInput.props.value).toBe('AB12CD34');

    await fireEvent.changeText(firstInput, 'ZZ99YY88');
    await fireEvent.press(result.getByRole('tab', { name: 'Home' }));
    expect(result.getByRole('tab', { name: 'Home', selected: true })).toBeTruthy();

    await act(async () => receiveUrl?.({ url: repeatedLink }));
    await waitFor(() => {
      expect(result.getByRole('tab', { name: 'Settings', selected: true })).toBeTruthy();
      expect(result.getByTestId('invite-code-input').props.value).toBe('AB12CD34');
    });

    await result.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('provides web link copy and open fallbacks for success and failure', async () => {
    const open = jest.fn().mockReturnValueOnce({ closed: false }).mockReturnValueOnce(null);
    installWebPlatform(open);
    const copy = jest
      .spyOn(Clipboard, 'setStringAsync')
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('clipboard unavailable'));
    const client = runtime({ createInvite: async () => invite });
    const result = await render(<App runtimeClient={client} />);

    await fireEvent.press(await result.findByRole('tab', { name: 'Settings' }));
    await fireEvent.press(result.getByTestId('generate-invite'));
    const webLink =
      'https://rewind.example/invite?code=AB12CD34&expiresAt=2099-09-23T12%3A00%3A00.000Z';
    expect((await result.findByTestId('invite-link')).props.children).toBe(webLink);

    await fireEvent.press(result.getByTestId('copy-invite-link'));
    await waitFor(() => expect(result.getByText('Invitation link copied.')).toBeTruthy());
    expect(copy).toHaveBeenLastCalledWith(webLink);

    await fireEvent.press(result.getByTestId('copy-invite-link'));
    await waitFor(() =>
      expect(
        result.getByText('Copy is unavailable here; use Share or select the invite link locally.'),
      ).toBeTruthy(),
    );

    await fireEvent.press(result.getByTestId('open-invite-link'));
    await waitFor(() =>
      expect(result.getByText('Invitation link opened in a new tab.')).toBeTruthy(),
    );
    expect(open).toHaveBeenLastCalledWith(webLink, '_blank', 'noopener,noreferrer');

    await fireEvent.press(result.getByTestId('open-invite-link'));
    await waitFor(() =>
      expect(
        result.getByText('The invitation link was blocked. Copy it to open elsewhere.'),
      ).toBeTruthy(),
    );
    await result.unmount();
  });
});
