import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountGroupExperience } from '../src/groups/RealAccountGroupExperience';
import {
  createPrivateReminderClient,
  type PrivateReminderSnapshot,
} from '../src/reminders/private-reminder-client';
import { subscribeToReminderIntents, type ReminderIntent } from '../src/reminders/reminder-intents';

jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/reminders/private-reminder-client', () => ({
  createPrivateReminderClient: jest.fn(),
}));
jest.mock('../src/reminders/reminder-intents', () => ({ subscribeToReminderIntents: jest.fn() }));
jest.mock('../src/capture/VideoCaptureScreen', () => ({ VideoCaptureScreen: () => null }));

const available: PrivateReminderSnapshot = {
  state: 'available',
  enabled: false,
  canEnable: true,
  canDisable: false,
  message: 'Explicit opt-in available.',
};
const revoked: PrivateReminderSnapshot = { ...available, state: 'revoked', canEnable: false };
const group = (id: string) => ({
  group: { id, name: id, role: 'owner', maxMembers: 5 },
  cycle: {
    id: `cycle-${id}`,
    prompt: 'Prompt',
    startsAt: '2026-09-28T00:00:00Z',
    endsAt: '2026-10-26T00:00:00Z',
    quota: { maxCount: 5, maxSeconds: 30 },
    contributionUsage: { countUsed: 0, secondsUsed: 0 },
    contributionCount: 0,
  },
});
const response = (body: unknown, status = 200) =>
  ({ ok: status === 200, status, json: async () => body }) as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let selected = group('group-one');
  const request = jest.fn(async (path: string, init?: RequestInit) => {
    if (path === '/real/groups/current') {
      if (init?.method === 'POST') selected = group(JSON.parse(String(init.body)).groupId);
      return response({ group: selected });
    }
    if (path === '/real/groups')
      return response({ groups: [group('group-one'), group('group-two')] });
    if (path === '/real/invites/accept') {
      selected = group('group-two');
      return response({ group: selected });
    }
    if (path.endsWith('/members'))
      return response({
        group: { id: selected.group.id, name: selected.group.name },
        members: [],
        pendingInviteCount: 0,
      });
    if (path.startsWith('/contributions?'))
      return response({
        cycleId: selected.cycle.id,
        entries: [],
        latestContribution: null,
        allowance: {
          maxCount: 5,
          maxSeconds: 30,
          countUsed: 0,
          secondsUsed: 0,
          deletionsUsed: 0,
          deletionAvailability: 'available',
        },
        pagination: { hasMore: false, nextCursor: null },
      });
    if (path.endsWith('/reminders'))
      return response({
        preference: { enabled: true, snoozedUntil: null },
        nextReminderAt: null,
        delivery: { state: 'unconfigured', message: 'Unconfigured' },
      });
    throw new Error(`Unexpected request: ${path}`);
  });
  const client = {
    load: jest.fn(async () => available),
    enable: jest.fn(async () => available),
    disable: jest.fn(async () => revoked),
    revoke: jest.fn(async () => revoked),
  };
  (createPrivateReminderClient as jest.Mock).mockImplementation(() => ({ ...client }));
  const callbacks: ((intent: ReminderIntent) => void | Promise<void>)[] = [];
  (subscribeToReminderIntents as jest.Mock).mockImplementation((callback) => {
    callbacks.push(callback);
    return jest.fn();
  });
  const auth = {
    session: { account: { id: 'account-one' } },
    authenticatedRequest: request,
    signOut: jest.fn(async () => {}),
    baseUrl: 'https://api.invalid',
    pending: false,
  };
  (useRealAccount as jest.Mock).mockReturnValue(auth);
  return { request, client, auth, callbacks };
}
beforeEach(() => jest.clearAllMocks());

it('loads scoped controls without opting in and awaits old-device removal before switching groups', async () => {
  const f = fixture();
  const removal = deferred<PrivateReminderSnapshot>();
  f.client.revoke.mockImplementationOnce(() => removal.promise);
  const ui = await render(<RealAccountGroupExperience displayName="Owner" />);
  await ui.findByText(available.message);
  expect(f.client.enable).not.toHaveBeenCalled();
  const oldContext = (createPrivateReminderClient as jest.Mock).mock.calls[0][0];
  expect(oldContext.isCurrentContext()).toBe(true);
  await fireEvent.press(ui.getByTestId('switch-real-group-group-two'));
  expect(
    f.request.mock.calls.some(
      ([path, init]) => path === '/real/groups/current' && init?.method === 'POST',
    ),
  ).toBe(false);
  expect(ui.getByTestId('private-reminder-enable').props.accessibilityState.disabled).toBe(true);
  expect(oldContext.isCurrentContext()).toBe(true);
  await act(async () => {
    removal.resolve(revoked);
  });
  await waitFor(() =>
    expect(ui.getByTestId('real-group-name-heading').props.children).toBe('group-two'),
  );
  expect(oldContext.isCurrentContext()).toBe(false);
  expect((createPrivateReminderClient as jest.Mock).mock.calls.at(-1)[0].groupId).toBe('group-two');
});

it('keeps a failed removal visible and never sends a group mutation', async () => {
  const f = fixture();
  f.client.revoke.mockResolvedValueOnce({ ...revoked, state: 'cleanup-pending' });
  const ui = await render(<RealAccountGroupExperience displayName="Owner" />);
  await ui.findByText(available.message);
  await fireEvent.press(ui.getByTestId('switch-real-group-group-two'));
  await ui.findByText('Device reminder removal is unconfirmed. Check reminder support and retry.');
  expect(ui.getByTestId('real-group-name-heading').props.children).toBe('group-one');
  expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('awaits removal before accepting an invitation that selects another group', async () => {
  const f = fixture();
  const removal = deferred<PrivateReminderSnapshot>();
  f.client.revoke.mockImplementationOnce(() => removal.promise);
  const ui = await render(
    <RealAccountGroupExperience
      displayName="Owner"
      inviteIntent={{ code: 'ABCDEF', groupId: 'group-two', expiresAt: '2026-10-25T00:00:00Z' }}
    />,
  );
  await ui.findByText(available.message);
  await fireEvent.press(ui.getByTestId('real-invite-accept'));
  expect(f.request).not.toHaveBeenCalledWith('/real/invites/accept', expect.anything());
  await act(async () => {
    removal.resolve(revoked);
  });
  await waitFor(() =>
    expect(ui.getByTestId('real-group-name-heading').props.children).toBe('group-two'),
  );
});

it('starts logout immediately while device cleanup is pending', async () => {
  const f = fixture();
  const removal = deferred<PrivateReminderSnapshot>();
  f.client.revoke.mockImplementationOnce(() => removal.promise);
  const ui = await render(<RealAccountGroupExperience displayName="Owner" />);
  await ui.findByText(available.message);
  await fireEvent.press(ui.getByTestId('real-group-sign-out'));
  expect(f.auth.signOut).toHaveBeenCalledTimes(1);
  const context = (createPrivateReminderClient as jest.Mock).mock.calls[0][0];
  await ui.unmount();
  expect(context.isCurrentContext()).toBe(false);
  await act(async () => {
    removal.resolve(revoked);
  });
});

it('revalidates a tap against the server-selected group without switching to payload context', async () => {
  const f = fixture();
  const ui = await render(<RealAccountGroupExperience displayName="Owner" />);
  await ui.findByText(available.message);
  await act(async () => {
    await f.callbacks[0]({ groupId: 'group-two', reminderId: 'one' });
  });
  await ui.findByText('This reminder is for another group. Choose a group you belong to.');
  expect(ui.getByTestId('real-group-name-heading').props.children).toBe('group-one');
  expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  await act(async () => {
    await f.callbacks[0]({ groupId: 'group-one', reminderId: 'two' });
  });
  expect(ui.getByTestId('real-group-name-heading').props.children).toBe('group-one');
});

it('discards a delayed reminder response after the authenticated context changes', async () => {
  const f = fixture();
  const ui = await render(<RealAccountGroupExperience displayName="Owner" />);
  await ui.findByText(available.message);
  const pending = deferred<Response>();
  f.request.mockImplementationOnce(() => pending.promise);
  let tap!: Promise<void> | void;
  await act(async () => {
    tap = f.callbacks[0]({ groupId: 'group-two', reminderId: 'one' });
  });
  (useRealAccount as jest.Mock).mockReturnValue({
    ...f.auth,
    authenticatedRequest: async () => response({ group: null, groups: [] }),
    session: { account: { id: 'other-account' } },
  });
  await ui.rerender(<RealAccountGroupExperience displayName="Other" />);
  await act(async () => {
    pending.resolve(response({ group: group('group-two') }));
    await tap;
  });
  expect(
    ui.queryByText('This reminder is for another group. Choose a group you belong to.'),
  ).toBeNull();
  expect(ui.queryByText('group-two')).toBeNull();
});
