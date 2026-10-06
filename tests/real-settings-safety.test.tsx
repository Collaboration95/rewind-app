import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';

const secureStoreMock = { token: null as string | null };
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => secureStoreMock.token,
  setItemAsync: async (_key: string, value: string) => {
    secureStoreMock.token = value;
  },
  deleteItemAsync: async () => {
    secureStoreMock.token = null;
  },
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
jest.mock('../src/chat/native-event-source', () => ({
  createRuntimeEventSource: () => ({
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    close: jest.fn(),
    onerror: null,
    onopen: null,
  }),
}));

const originalFetch = globalThis.fetch;
const runtimeClient = { baseUrl: 'https://rewind.example' } as never;
const nativeToken = 's'.repeat(43);
const account = {
  id: 'safety-account',
  username: 'safety.user',
  displayName: 'Safety User',
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};
const group = {
  memberId: 'safety-profile',
  group: { id: 'safety-group', name: 'Our moments', role: 'owner', maxMembers: 4, timeZone: 'UTC' },
  cycle: {
    id: 'safety-cycle',
    prompt: 'A small good thing',
    startsAt: '2026-09-28T00:00:00.000Z',
    endsAt: '2026-10-26T00:00:00.000Z',
    quota: { maxCount: 5, maxSeconds: 30 },
    contributionUsage: { countUsed: 0, secondsUsed: 0 },
    contributionCount: 0,
  },
};
const friend = { memberId: 'friend-profile', displayName: 'Casey', role: 'member' };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function useSafetyApi(deleteStatus = 200) {
  const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/login')
      return json(200, {
        account,
        token: nativeToken,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    if (path === '/auth/account/delete')
      return json(deleteStatus, { deleted: deleteStatus === 200 });
    if (path === '/real/groups/current') return json(200, { group });
    if (path === '/real/groups') return json(200, { groups: [group] });
    if (path === '/real/groups/safety-group/members')
      return json(200, {
        group: group.group,
        members: [
          { memberId: group.memberId, displayName: account.displayName, role: 'owner' },
          friend,
        ],
        pendingInviteCount: 0,
      });
    if (path === '/contributions')
      return json(200, {
        cycleId: group.cycle.id,
        memberId: group.memberId,
        allowance: {
          maxCount: 5,
          maxSeconds: 30,
          countUsed: 0,
          secondsUsed: 0,
          deletionsUsed: 0,
          deletionAvailability: 'available',
        },
        entries: [],
        latestContribution: null,
        pagination: { limit: 50, hasMore: false, nextCursor: null },
      });
    if (path.endsWith('/reminders'))
      return json(200, {
        preference: { enabled: false, snoozedUntil: null, timeZone: 'UTC' },
      });
    if (path === '/real/blocks')
      return json(200, init?.method === 'POST' ? { blocked: true } : { blocked: [] });
    if (path === '/real/groups/safety-group/reports') return json(201, { reported: true });
    throw new Error(`Unexpected safety request: ${path}`);
  });
  globalThis.fetch = fetcher as typeof fetch;
  return fetcher;
}

async function openSettings() {
  const result = await render(<App runtimeClient={runtimeClient} />);
  await fireEvent.press(await result.findByRole('button', { name: 'Sign in' }));
  await fireEvent.changeText(result.getByLabelText('Username'), account.username);
  await fireEvent.changeText(result.getByLabelText('Password'), 'correct safety password');
  await fireEvent.press(result.getByTestId('real-account-submit'));
  await fireEvent.press(await result.findByTestId('real-account-settings-button'));
  return result;
}

async function openPerson(result: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(await result.findByTestId('real-settings-members'));
  await fireEvent.press(await result.findByTestId('real-group-member-1'));
  expect(
    within(result.getByTestId('real-person-dialog')).getByRole('header', { name: 'Casey' }),
  ).toBeTruthy();
}

function expectPost(fetcher: jest.Mock, path: string, body: object) {
  expect(fetcher).toHaveBeenCalledWith(
    `https://rewind.example${path}`,
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  const [, init] = fetcher.mock.calls.find(([url]) => String(url).endsWith(path))!;
  expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${nativeToken}`);
}

beforeEach(async () => {
  secureStoreMock.token = null;
  await AsyncStorage.clear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

it('shows wrong-password deletion failure and keeps the account signed in', async () => {
  const fetcher = useSafetyApi(403);
  const result = await openSettings();
  await fireEvent.press(result.getByTestId('real-settings-delete'));
  await fireEvent.changeText(result.getByTestId('real-delete-password'), 'wrong safety password');
  await fireEvent.press(result.getByTestId('real-delete-account'));
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/account/delete'))).toBe(
    false,
  );
  await fireEvent.press(result.getByTestId('real-delete-confirm'));
  expect(await result.findByTestId('real-delete-error')).toHaveTextContent(
    'The password is incorrect.',
  );
  expectPost(fetcher, '/auth/account/delete', { password: 'wrong safety password' });
  expect(result.queryByTestId('welcome-entry')).toBeNull();
  expect(secureStoreMock.token).toBe(nativeToken);
  expect(result.getByTestId('real-delete-account')).toBeEnabled();
});

it('deletes only after confirmation, clears the credential, and returns to Welcome', async () => {
  const fetcher = useSafetyApi();
  const result = await openSettings();
  await fireEvent.press(result.getByTestId('real-settings-delete'));
  await fireEvent.changeText(result.getByTestId('real-delete-password'), 'correct safety password');
  await fireEvent.press(result.getByTestId('real-delete-account'));
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/account/delete'))).toBe(
    false,
  );
  await fireEvent.press(result.getByRole('button', { name: 'Keep my account' }));
  expect(result.queryByTestId('real-delete-dialog')).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/account/delete'))).toBe(
    false,
  );
  await fireEvent.press(result.getByTestId('real-delete-account'));
  await fireEvent.press(result.getByTestId('real-delete-confirm'));
  expect(await result.findByTestId('welcome-entry')).toBeTruthy();
  expectPost(fetcher, '/auth/account/delete', { password: 'correct safety password' });
  await waitFor(() => expect(secureStoreMock.token).toBeNull());
  expect(result.queryByTestId('real-settings-delete')).toBeNull();
  expect(result.getByText('Your account is deleted.')).toBeTruthy();
});

it('reports the selected member and reason without blocking when Also block is unchecked', async () => {
  const fetcher = useSafetyApi();
  const result = await openSettings();
  await openPerson(result);
  await fireEvent.press(result.getByTestId('real-person-report'));
  expect(result.getByTestId('report-also-block')).toBeChecked();
  await fireEvent.press(result.getByTestId('report-also-block'));
  expect(result.getByTestId('report-also-block')).not.toBeChecked();
  await fireEvent.press(result.getByTestId('report-reason-3'));
  await fireEvent.press(result.getByTestId('report-send'));
  await waitFor(() => expect(result.queryByTestId('report-sheet')).toBeNull());
  expectPost(fetcher, '/real/groups/safety-group/reports', {
    memberId: friend.memberId,
    reason: 'Spam',
  });
  expect(
    fetcher.mock.calls.some(
      ([url, init]) => String(url).endsWith('/real/blocks') && init?.method === 'POST',
    ),
  ).toBe(false);
});

it('blocks the selected member from Members', async () => {
  const fetcher = useSafetyApi();
  const result = await openSettings();
  await openPerson(result);
  await fireEvent.press(result.getByTestId('real-person-block'));
  await waitFor(() => expect(result.queryByTestId('real-person-dialog')).toBeNull());
  expectPost(fetcher, '/real/blocks', { profileId: friend.memberId });
  expect(
    within(result.getByTestId('real-group-member-1')).getByText('Member · blocked'),
  ).toBeTruthy();
});

it('reports and blocks after toggling Also block back on', async () => {
  const fetcher = useSafetyApi();
  const result = await openSettings();
  await openPerson(result);
  await fireEvent.press(result.getByTestId('real-person-report'));
  await fireEvent.press(result.getByTestId('report-also-block'));
  await fireEvent.press(result.getByTestId('report-also-block'));
  expect(result.getByTestId('report-also-block')).toBeChecked();
  await fireEvent.press(result.getByTestId('report-reason-1'));
  await fireEvent.press(result.getByTestId('report-send'));
  await waitFor(() => expect(result.queryByTestId('report-sheet')).toBeNull());
  expectPost(fetcher, '/real/groups/safety-group/reports', {
    memberId: friend.memberId,
    reason: 'Harassment or bullying',
  });
  expectPost(fetcher, '/real/blocks', { profileId: friend.memberId });
  expect(
    within(result.getByTestId('real-group-member-1')).getByText('Member · blocked'),
  ).toBeTruthy();
});
