import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountGroupExperience } from '../src/groups/RealAccountGroupExperience';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));
jest.mock('../src/capture/VideoCaptureScreen', () => ({ VideoCaptureScreen: () => null }));
jest.mock('../src/chat/native-event-source', () => ({
  createRuntimeEventSource: () => ({
    addEventListener: jest.fn(),
    close: jest.fn(),
    onerror: null,
    onopen: null,
    removeEventListener: jest.fn(),
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const ownerGroup = {
  memberId: 'real-profile-owner',
  group: { id: 'real-group-1', name: 'Saturday table', role: 'owner' as const, maxMembers: 4 },
  cycle: {
    id: 'real-cycle-1',
    prompt: 'What made you pause and smile?',
    startsAt: '2026-09-28T00:00:00.000Z',
    endsAt: '2026-10-26T00:00:00.000Z',
    quota: { maxCount: 5, maxSeconds: 30 },
    contributionUsage: { countUsed: 0, secondsUsed: 0 },
    contributionCount: 0,
  },
};

const joinedGroup = {
  ...ownerGroup,
  memberId: 'real-profile-member',
  group: {
    ...ownerGroup.group,
    id: 'real-group-2',
    name: 'Garden circle',
    role: 'member' as const,
  },
  cycle: { ...ownerGroup.cycle, id: 'real-cycle-2' },
};

it('updates group members and active context when switching selected groups', async () => {
  let selected: typeof ownerGroup | typeof joinedGroup = ownerGroup;
  const groups = [ownerGroup, joinedGroup];
  const authenticatedRequest = jest.fn(async (path: string, init?: RequestInit) => {
    if (path === '/real/groups/current' && init?.method === 'POST') {
      const { groupId } = JSON.parse(String(init.body)) as { groupId: string };
      selected = groups.find((entry) => entry.group.id === groupId)!;
      return jsonResponse({ group: selected });
    }
    if (path === '/real/groups/current') return jsonResponse({ group: selected });
    if (path === '/real/groups') return jsonResponse({ groups });
    if (path.startsWith('/realtime/groups/') && path.includes('/messages?limit=100'))
      return jsonResponse({ events: [], nextCursor: null, watermarkEventId: 0, hasMore: false });
    if (path === `/real/groups/${ownerGroup.group.id}/members`)
      return jsonResponse({
        group: { id: ownerGroup.group.id, name: ownerGroup.group.name },
        members: [
          {
            memberId: 'real-profile-owner',
            displayName: 'Ada Owner',
            role: 'owner',
            joinedAt: '2026-09-28T00:00:00.000Z',
          },
          {
            memberId: 'real-profile-member',
            displayName: 'Bea Member',
            role: 'member',
            joinedAt: '2026-09-28T00:01:00.000Z',
          },
        ],
        pendingInviteCount: 1,
      });
    if (path === `/real/groups/${joinedGroup.group.id}/members`)
      return jsonResponse({
        group: { id: joinedGroup.group.id, name: joinedGroup.group.name },
        members: [
          {
            memberId: 'real-profile-cy',
            displayName: 'Cy Owner',
            role: 'owner',
            joinedAt: '2026-09-28T00:00:00.000Z',
          },
          {
            memberId: 'real-profile-member',
            displayName: 'Dee Member',
            role: 'member',
            joinedAt: '2026-09-28T00:02:00.000Z',
          },
        ],
        pendingInviteCount: 0,
      });
    throw new Error(`Unexpected authenticated request: ${path}`);
  });
  (useRealAccount as jest.Mock).mockReturnValue({
    baseUrl: 'https://runtime.example',
    session: { account: { id: 'real-account', displayName: 'Member' } },
    authenticatedRequest,
    realtimeAuthorizationHeader: () => 'Bearer token',
    signOut: jest.fn(),
  });

  const screen = await render(<RealAccountGroupExperience displayName="Member" />);
  await screen.findByTestId('real-group-home');
  expect(await screen.findByText('Ada Owner · Owner')).toBeTruthy();
  expect(screen.getByText('Bea Member · Member')).toBeTruthy();
  expect(screen.getByTestId('real-group-pending-invites').props.children).toBe(
    '1 pending invitation',
  );

  await fireEvent.press(screen.getByTestId(`switch-real-group-${joinedGroup.group.id}`));
  expect(await screen.findByText('Cy Owner · Owner')).toBeTruthy();
  expect(screen.getByTestId('real-group-active-context').props.children).toEqual([
    'ACTIVE GROUP · ',
    'Garden circle',
  ]);
  expect(screen.queryByText('Ada Owner · Owner')).toBeNull();
  expect(screen.getByTestId('real-group-pending-invites').props.children).toBe(
    'No pending invitations',
  );
  await fireEvent.press(screen.getByTestId('real-group-chat-action'));
  expect(screen.getByTestId('real-chat-context').props.children).toEqual([
    'ACTIVE GROUP · ',
    'Garden circle',
  ]);
  expect(await screen.findByTestId('real-chat-empty')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('real-group-chat-back'));
  await fireEvent.press(screen.getByTestId('real-group-capture-action'));
  expect(screen.getByTestId('real-group-capture-context').props.children).toEqual([
    'ACTIVE GROUP · ',
    'Garden circle',
  ]);
  screen.unmount();
});

it('keeps loading summaries honest and ignores a delayed prior-group response after switching', async () => {
  let selected: typeof ownerGroup | typeof joinedGroup = ownerGroup;
  const groups = [ownerGroup, joinedGroup];
  const delayedOwnerSummary = deferred<Response>();
  const authenticatedRequest = jest.fn((path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/real/groups/current' && init?.method === 'POST') {
      const { groupId } = JSON.parse(String(init.body)) as { groupId: string };
      selected = groups.find((entry) => entry.group.id === groupId)!;
      return Promise.resolve(jsonResponse({ group: selected }));
    }
    if (path === '/real/groups/current') return Promise.resolve(jsonResponse({ group: selected }));
    if (path === '/real/groups') return Promise.resolve(jsonResponse({ groups }));
    if (path === `/real/groups/${ownerGroup.group.id}/members`) return delayedOwnerSummary.promise;
    if (path === `/real/groups/${joinedGroup.group.id}/members`)
      return Promise.resolve(
        jsonResponse({
          group: { id: joinedGroup.group.id, name: joinedGroup.group.name },
          members: [
            { displayName: 'Cy Owner', role: 'owner', joinedAt: '2026-09-28T00:00:00.000Z' },
            { displayName: 'Dee Member', role: 'member', joinedAt: '2026-09-28T00:02:00.000Z' },
          ],
          pendingInviteCount: 0,
        }),
      );
    throw new Error(`Unexpected authenticated request: ${path}`);
  });
  (useRealAccount as jest.Mock).mockReturnValue({ authenticatedRequest, signOut: jest.fn() });

  const screen = await render(<RealAccountGroupExperience displayName="Member" />);
  await screen.findByTestId('real-group-home');
  expect(await screen.findByText('Loading group members…')).toBeTruthy();
  expect(screen.getByTestId('real-group-members').props.children).toBeDefined();
  expect(screen.queryByText('MEMBERS · 0/4')).toBeNull();
  expect(screen.getByTestId('real-group-pending-invites').props.children).toBe(
    'Loading invitation status…',
  );
  expect(screen.queryByText('No pending invitations')).toBeNull();

  await fireEvent.press(screen.getByTestId(`switch-real-group-${joinedGroup.group.id}`));
  expect(await screen.findByText('Cy Owner · Owner')).toBeTruthy();
  expect(screen.getByTestId('real-group-pending-invites').props.children).toBe(
    'No pending invitations',
  );

  await act(async () => {
    delayedOwnerSummary.resolve(
      jsonResponse({
        group: { id: ownerGroup.group.id, name: ownerGroup.group.name },
        members: [
          { displayName: 'Ada Owner', role: 'owner', joinedAt: '2026-09-28T00:00:00.000Z' },
          { displayName: 'Bea Member', role: 'member', joinedAt: '2026-09-28T00:01:00.000Z' },
        ],
        pendingInviteCount: 1,
      }),
    );
  });
  await waitFor(() => {
    expect(screen.getByTestId('real-group-active-context').props.children).toEqual([
      'ACTIVE GROUP · ',
      'Garden circle',
    ]);
    expect(screen.getByText('Cy Owner · Owner')).toBeTruthy();
    expect(screen.queryByText('Ada Owner · Owner')).toBeNull();
  });
  screen.unmount();
});

it('keeps member and invitation counts unknown when the summary request fails', async () => {
  const authenticatedRequest = jest.fn(async (path: string) => {
    if (path === '/real/groups/current') return jsonResponse({ group: ownerGroup });
    if (path === '/real/groups') return jsonResponse({ groups: [ownerGroup] });
    if (path === `/real/groups/${ownerGroup.group.id}/members`)
      return jsonResponse({ message: 'unavailable' }, 503);
    throw new Error(`Unexpected authenticated request: ${path}`);
  });
  (useRealAccount as jest.Mock).mockReturnValue({ authenticatedRequest, signOut: jest.fn() });

  const screen = await render(<RealAccountGroupExperience displayName="Member" />);
  await screen.findByText('Group members could not be loaded. Retry when connected.');
  expect(screen.getByTestId('real-group-pending-invites').props.children).toBe(
    'Invitation status unavailable.',
  );
  expect(screen.queryByText(/MEMBERS · 0\//)).toBeNull();
  expect(screen.queryByText('No pending invitations')).toBeNull();
  screen.unmount();
});
