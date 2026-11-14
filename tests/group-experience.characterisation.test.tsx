/**
 * Characterisation of src/groups/RealAccountGroupExperience.tsx as a person
 * meets it: the requests it makes, the states it shows and how its screens
 * connect. Children render for real (Home, Settings, Chat, Archive, Film,
 * Moments, camera). Reminder-registration ordering, member-list freshness,
 * allowance refresh, live reconciliation and media-mode discovery already have
 * dedicated suites (real-group-reminders, real-group-members,
 * real-group-experience, real-capture-mode) and are not repeated.
 */
import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountGroupExperience } from '../src/groups/RealAccountGroupExperience';
import { ToastProvider } from '../src/ui/primitives';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('../src/chat/native-event-source', () => ({
  createRuntimeEventSource: () => ({
    addEventListener: jest.fn(),
    close: jest.fn(),
    onerror: null,
    onopen: null,
    removeEventListener: jest.fn(),
  }),
}));

type Screen = Awaited<ReturnType<typeof render>>;
type Handler = (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;

const DAY = 86_400_000;
const response = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

function makeGroup(
  id: string,
  name: string,
  role: 'owner' | 'member' = 'owner',
  extra: Record<string, unknown> = {},
) {
  return {
    memberId: `profile-${id}`,
    group: { id, name, role, maxMembers: 4, timeZone: 'Asia/Singapore' },
    cycle: {
      id: `cycle-${id}`,
      prompt: `Prompt for ${name}`,
      startsAt: new Date(Date.now() - 3 * DAY).toISOString(),
      endsAt: new Date(Date.now() + 20 * DAY).toISOString(),
      quota: { maxCount: 5, maxSeconds: 30 },
      contributionUsage: { countUsed: 0, secondsUsed: 0 },
      contributionCount: 0,
    },
    ...extra,
  };
}
type Group = ReturnType<typeof makeGroup>;

const ledger = (group: Group | null, countUsed = 0) => ({
  cycleId: group?.cycle.id ?? '',
  memberId: group?.memberId ?? '',
  allowance: {
    maxCount: 5,
    maxSeconds: 30,
    countUsed,
    secondsUsed: countUsed * 3,
    deletionsUsed: 0,
    deletionAvailability: 'available',
  },
  entries: [],
  latestContribution: null,
  pagination: { limit: 50, hasMore: false, nextCursor: null },
});

interface Server {
  current: Group | null;
  groups: Group[];
  /** Consulted first; return a Response to override the default behaviour. */
  override: Handler | null;
}

function setup(initial: Partial<Server> = {}, accountOverrides: Record<string, unknown> = {}) {
  const alpha = makeGroup('group-a', 'Saturday table');
  const server: Server = {
    current: alpha,
    groups: [alpha],
    override: null,
    ...initial,
  };
  const request = jest.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const overridden = server.override?.(path, init);
    if (overridden) return overridden;
    if (path === '/real/groups/current' && method === 'POST') {
      const { groupId } = JSON.parse(String(init?.body));
      server.current = server.groups.find((entry) => entry.group.id === groupId) ?? null;
      return response({ group: server.current });
    }
    if (path === '/real/groups/current') return response({ group: server.current });
    if (path === '/real/groups' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const created = makeGroup('group-new', body.name);
      server.groups = [...server.groups, created];
      server.current = created;
      return response(created, 201);
    }
    if (path === '/real/groups') return response({ groups: server.groups });
    if (path === '/real/invites/accept') {
      const { groupId } = JSON.parse(String(init?.body));
      const joined = server.groups.find((entry) => entry.group.id === groupId) ?? server.groups[0];
      server.current = joined;
      return response({ status: 'accepted', group: joined });
    }
    const members = path.match(/^\/real\/groups\/([^/]+)\/members$/);
    if (members) {
      const found = server.groups.find((entry) => entry.group.id === members[1]);
      return response({
        group: { id: members[1], name: found?.group.name ?? members[1] },
        members: [
          {
            memberId: found?.memberId,
            displayName: 'Ada Owner',
            role: found?.group.role,
            joinedAt: '2026-09-28T00:00:00.000Z',
          },
          {
            memberId: 'profile-friend',
            displayName: 'Casey',
            role: 'member',
            joinedAt: '2026-09-28T00:01:00.000Z',
          },
        ],
        pendingInviteCount: 0,
      });
    }
    if (/\/reminders\/destinations$/.test(path)) return response({ destinations: [] });
    if (/\/reminders$/.test(path))
      return response({ preference: { enabled: false, snoozedUntil: null, timeZone: 'UTC' } });
    if (path === '/real/blocks') return response({ blocked: [] });
    if (path.startsWith('/contributions?')) return response(ledger(server.current));
    if (path.startsWith('/realtime/groups/'))
      return response({ events: [], nextCursor: null, watermarkEventId: 0, hasMore: false });
    if (path.startsWith('/archive?'))
      return response({
        archive: { films: [], clips: [] },
        pagination: {
          filmCursor: null,
          clipCursor: null,
          hasMoreFilms: false,
          hasMoreClips: false,
        },
      });
    if (path === '/real/media/config?uploadProtocol=2') return response({ directTransfer: false });
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  const auth = {
    authenticatedRequest: request,
    baseUrl: 'https://api.example.test',
    deleteAccount: jest.fn(async () => 'deleted' as const),
    notice: null,
    pending: false,
    realtimeAuthorizationHeader: () => 'Bearer token',
    session: {
      account: { id: 'account-1', username: 'ada.owner', displayName: 'Ada Owner' },
      signInMethod: 'password',
    },
    signOut: jest.fn(async () => undefined),
    ...accountOverrides,
  };
  (useRealAccount as jest.Mock).mockReturnValue(auth);
  return { server, request, auth };
}

const experience = (props: Partial<Parameters<typeof RealAccountGroupExperience>[0]> = {}) => (
  <ToastProvider>
    <RealAccountGroupExperience displayName="Ada Owner" {...props} />
  </ToastProvider>
);
async function start(props: Partial<Parameters<typeof RealAccountGroupExperience>[0]> = {}) {
  const ui = await render(experience(props));
  await ui.findByTestId('real-group-home');
  return ui;
}

const paths = (request: jest.Mock, method = 'GET') =>
  request.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(([path]) => String(path));
const callsTo = (request: jest.Mock, method: string, path: string | RegExp) =>
  request.mock.calls.filter(
    ([called, init]) =>
      (init?.method ?? 'GET') === method &&
      (typeof path === 'string' ? called === path : path.test(String(called))),
  );
const heading = (ui: Screen) => ui.getByTestId('real-group-name-heading').props.children;
const openSettings = async (ui: Screen) =>
  fireEvent.press(await ui.findByTestId('real-account-settings-button'));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('opening the app', () => {
  it('shows "Restoring your group…" until the first reads settle, then Home', async () => {
    let release!: (value: Response) => void;
    const { server } = setup();
    server.override = (path) =>
      path === '/real/groups/current'
        ? (new Promise<Response>((resolve) => {
            release = resolve;
          }) as never)
        : undefined;
    const ui = await render(experience());
    expect(ui.getByTestId('real-group-loading')).toBeTruthy();
    expect(ui.getByText('Restoring your group…')).toBeTruthy();
    expect(ui.queryByTestId('real-group-navigation')).toBeNull();
    expect(ui.queryByTestId('real-group-home')).toBeNull();
    await act(async () => {
      release(response({ group: server.current }));
    });
    expect(await ui.findByTestId('real-group-home')).toBeTruthy();
    expect(ui.queryByTestId('real-group-loading')).toBeNull();
  });

  it('reads the current group, the memberships, the members and the ledger, and nothing else', async () => {
    const { request, server } = setup();
    const ui = await start();
    await waitFor(() => expect(callsTo(request, 'GET', /^\/contributions\?/)).toHaveLength(1));
    const reads = paths(request).filter((path) => !path.startsWith('/realtime/'));
    expect(reads.sort()).toEqual(
      [
        '/real/groups/current',
        '/real/groups',
        '/real/groups/group-a/members',
        '/contributions?groupId=group-a',
      ].sort(),
    );
    // No media discovery until Capture, no Archive until the tab opens, no reminder reads until Settings.
    expect(paths(request, 'POST')).toEqual([]);
    expect(heading(ui)).toBe(server.current!.group.name);
    expect(ui.getByTestId('real-group-cycle-prompt').props.children).toBe(
      'Prompt for Saturday table',
    );
    expect(ui.getByTestId('real-group-menu-button').props.accessibilityLabel).toBe(
      'Saturday table · switch group',
    );
    expect(ui.getByTestId('real-account-settings-button').props.accessibilityLabel).toBe(
      'Ada Owner · settings',
    );
  });

  it('shows the dock with Home selected and a shutter that says how many moments are left', async () => {
    const ui = await start();
    expect(ui.getByTestId('real-group-nav-home').props.accessibilityState.selected).toBe(true);
    expect(ui.getByTestId('real-group-nav-chat').props.accessibilityState.selected).toBe(false);
    expect(ui.getByTestId('real-group-nav-archive').props.accessibilityState.selected).toBe(false);
    await waitFor(() =>
      expect(ui.getByTestId('real-group-capture-action').props.accessibilityLabel).toBe(
        'Add a moment · 5 of 5 left',
      ),
    );
  });

  it('shows a retryable error, with no dock, when the group cannot be read, and recovers on retry', async () => {
    const { server, request } = setup();
    let failing = true;
    server.override = (path) =>
      failing && path === '/real/groups/current' ? response({}, 503) : undefined;
    const ui = await render(experience());
    const error = await ui.findByTestId('real-group-error');
    expect(within(error).getByText('Couldn’t load your group')).toBeTruthy();
    expect(within(error).getByText('Check your connection and try again.')).toBeTruthy();
    expect(ui.getByTestId('real-group-retry')).toBeTruthy();
    expect(ui.queryByTestId('real-group-navigation')).toBeNull();
    expect(ui.queryByTestId('real-group-home')).toBeNull();
    expect(callsTo(request, 'GET', '/real/groups/current')).toHaveLength(1);

    failing = false;
    await fireEvent.press(ui.getByTestId('real-group-retry'));
    expect(await ui.findByTestId('real-group-home')).toBeTruthy();
    expect(callsTo(request, 'GET', '/real/groups/current')).toHaveLength(2);
    expect(ui.queryByTestId('real-group-error')).toBeNull();
    expect(heading(ui)).toBe('Saturday table');
  });

  it('shows the same error when only the membership list fails', async () => {
    const { server } = setup();
    server.override = (path) => (path === '/real/groups' ? response({}, 500) : undefined);
    const ui = await render(experience());
    expect(await ui.findByTestId('real-group-error')).toBeTruthy();
    expect(ui.getByTestId('real-group-retry')).toBeTruthy();
  });

  it('shows the same error when the read throws (offline)', async () => {
    const { server } = setup();
    server.override = (path) => {
      if (path === '/real/groups/current') throw new TypeError('Failed to fetch');
      return undefined;
    };
    const ui = await render(experience());
    expect(await ui.findByTestId('real-group-error')).toBeTruthy();
  });
});

describe('an account with no group', () => {
  const noGroup = () => setup({ current: null, groups: [] });

  it('offers to join or create, without a dock or a group menu', async () => {
    noGroup();
    const ui = await render(experience());
    const empty = await ui.findByTestId('real-group-none');
    expect(within(empty).getByText('You’re not in a group yet')).toBeTruthy();
    expect(
      within(empty).getByText('Join one with an invite code, or start your own.'),
    ).toBeTruthy();
    expect(ui.getByText('Rewind')).toBeTruthy();
    expect(ui.queryByTestId('real-group-menu-button')).toBeNull();
    expect(ui.queryByTestId('real-group-navigation')).toBeNull();
    expect(ui.queryByTestId('real-group-capture-action')).toBeNull();
    expect(ui.getByTestId('real-group-join-start')).toBeTruthy();
    expect(ui.getByTestId('real-group-create-choice')).toBeTruthy();
  });

  it('opens the join and create screens over the empty state and Back returns to it', async () => {
    noGroup();
    const ui = await render(experience());
    await fireEvent.press(await ui.findByTestId('real-group-join-start'));
    expect(ui.getByRole('header', { name: 'Have an invite?' })).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-join-back'));
    expect(ui.queryByRole('header', { name: 'Have an invite?' })).toBeNull();
    expect(ui.getByTestId('real-group-none')).toBeTruthy();

    await fireEvent.press(ui.getByTestId('real-group-create-choice'));
    expect(ui.getByRole('header', { name: 'New group' })).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-create-back'));
    expect(ui.queryByRole('header', { name: 'New group' })).toBeNull();
    expect(ui.getByTestId('real-group-none')).toBeTruthy();
  });

  it('rejects a malformed code locally, and shows the server reason for a refused one', async () => {
    const { request, server } = noGroup();
    server.override = (path) =>
      path === '/real/invites/accept'
        ? response({ message: 'That invitation has expired.' }, 410)
        : undefined;
    const ui = await render(experience());
    await fireEvent.press(await ui.findByTestId('real-group-join-start'));
    await fireEvent.changeText(ui.getByTestId('real-group-enter-code'), 'ab');
    await fireEvent.press(ui.getByTestId('real-group-join-choice'));
    expect(ui.getByTestId('real-group-join-feedback')).toHaveTextContent(
      'Enter the six-letter invitation code, like ABC-DEF.',
    );
    expect(callsTo(request, 'POST', '/real/invites/accept')).toHaveLength(0);

    await fireEvent.changeText(ui.getByTestId('real-group-enter-code'), 'abcdef');
    await fireEvent.press(ui.getByTestId('real-group-join-choice'));
    await waitFor(() =>
      expect(ui.getByTestId('real-group-join-feedback')).toHaveTextContent(
        'That invitation has expired.',
      ),
    );
    const [accept] = callsTo(request, 'POST', '/real/invites/accept');
    expect(accept[1]).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABCDEF' }),
    });
    expect(ui.getByRole('header', { name: 'Have an invite?' })).toBeTruthy();
    expect(ui.getByTestId('real-group-join-choice')).toBeEnabled();
  });
});

describe('an invitation link', () => {
  const intent = {
    code: 'ABCDEF',
    groupId: 'group-b',
    expiresAt: new Date(Date.now() + DAY).toISOString(),
  };
  const twoGroups = () => {
    const beta = makeGroup('group-b', 'Garden circle', 'member');
    const alpha = makeGroup('group-a', 'Saturday table');
    return { current: alpha, groups: [alpha, beta] };
  };

  it('offers Accept on Home, and accepting posts the code and group then shows that group', async () => {
    const { request } = setup(twoGroups());
    const ui = await start({ inviteIntent: intent });
    const card = within(ui.getByTestId('real-invite-intent'));
    expect(card.getByText('You have an invitation')).toBeTruthy();
    expect(card.getByText(/Accept it to join this private group\./)).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-invite-accept'));
    await waitFor(() => expect(heading(ui)).toBe('Garden circle'));
    const [accept] = callsTo(request, 'POST', '/real/invites/accept');
    expect(accept[1]).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABCDEF', groupId: 'group-b' }),
    });
    expect(ui.getByTestId('real-group-home')).toBeTruthy();
    // The members of the joined group are read before Home shows it.
    expect(callsTo(request, 'GET', '/real/groups/group-b/members').length).toBeGreaterThan(0);
  });

  it('shows the server reason on the card and keeps the current group when acceptance fails', async () => {
    const { server } = setup(twoGroups());
    server.override = (path) =>
      path === '/real/invites/accept'
        ? response({ message: 'This group is full.' }, 409)
        : undefined;
    const ui = await start({ inviteIntent: intent });
    await fireEvent.press(ui.getByTestId('real-invite-accept'));
    expect(await ui.findByTestId('real-invite-feedback')).toHaveTextContent('This group is full.');
    expect(heading(ui)).toBe('Saturday table');
    expect(ui.getByTestId('real-invite-accept')).toBeEnabled();
  });

  it('rejects a link code of the wrong shape without calling the server', async () => {
    const { request } = setup(twoGroups());
    const ui = await start({ inviteIntent: { ...intent, code: 'AB' } });
    await fireEvent.press(ui.getByTestId('real-invite-accept'));
    expect(await ui.findByTestId('real-invite-feedback')).toHaveTextContent(
      'Enter the six-letter invitation code, like ABC-DEF.',
    );
    expect(callsTo(request, 'POST', '/real/invites/accept')).toHaveLength(0);
  });

  it('also offers the card to an account that has no group yet', async () => {
    setup({ current: null, groups: [] });
    const ui = await render(experience({ inviteIntent: intent }));
    await ui.findByTestId('real-group-none');
    expect(
      within(ui.getByTestId('real-group-none')).getByTestId('real-invite-intent'),
    ).toBeTruthy();
  });
});

describe('owner invitations in Settings', () => {
  const invite = {
    id: 'invite-1',
    groupId: 'group-a',
    code: 'ABCDEF',
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-02T00:00:00.000Z',
  };
  async function openInvite(ui: Screen) {
    await openSettings(ui);
    await fireEvent.press(await ui.findByTestId('real-settings-invite'));
  }

  it('makes a code on opening Invite and shows it spaced out with its expiry', async () => {
    const { request, server } = setup();
    server.override = (path, init) =>
      path === '/real/groups/group-a/invites' && init?.method === 'POST'
        ? response({ invite }, 201)
        : undefined;
    const ui = await start();
    await openInvite(ui);
    expect(await ui.findByTestId('real-group-invite-code')).toHaveTextContent('ABC-DEF');
    expect(ui.getByTestId('real-group-invite-expiry')).toHaveTextContent(
      'Works once · expires in 24 hours',
    );
    const creates = callsTo(request, 'POST', '/real/groups/group-a/invites');
    expect(creates).toHaveLength(1);
    expect(creates[0][1]).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  });

  it('copies the code and says so', async () => {
    const { server } = setup();
    server.override = (path, init) =>
      path.endsWith('/invites') && init?.method === 'POST' ? response({ invite }, 201) : undefined;
    const ui = await start();
    await openInvite(ui);
    await fireEvent.press(await ui.findByTestId('real-group-copy-invite'));
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('ABC-DEF'));
    expect(await ui.findByText('Invitation code copied.')).toBeTruthy();
  });

  it('explains when copying is unavailable', async () => {
    const { server } = setup();
    server.override = (path, init) =>
      path.endsWith('/invites') && init?.method === 'POST' ? response({ invite }, 201) : undefined;
    (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(new Error('blocked'));
    const ui = await start();
    await openInvite(ui);
    await fireEvent.press(await ui.findByTestId('real-group-copy-invite'));
    expect(await ui.findByTestId('real-invite-feedback')).toHaveTextContent(
      'Copy is unavailable here. Select the invitation code to copy it.',
    );
  });

  it('shares a message with the spaced code and how to use it', async () => {
    const { server } = setup();
    server.override = (path, init) =>
      path.endsWith('/invites') && init?.method === 'POST' ? response({ invite }, 201) : undefined;
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const ui = await start();
    await openInvite(ui);
    await fireEvent.press(await ui.findByTestId('real-group-share-invite'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({
      message: 'Join my Rewind group with code ABC-DEF. Open Rewind and choose Have an invite?',
    });
    expect(ui.queryByTestId('real-invite-feedback')).toBeNull();
  });

  it('explains when sharing is unavailable', async () => {
    const { server } = setup();
    server.override = (path, init) =>
      path.endsWith('/invites') && init?.method === 'POST' ? response({ invite }, 201) : undefined;
    jest.spyOn(Share, 'share').mockRejectedValue(new Error('no share sheet'));
    const ui = await start();
    await openInvite(ui);
    await fireEvent.press(await ui.findByTestId('real-group-share-invite'));
    expect(await ui.findByTestId('real-invite-feedback')).toHaveTextContent(
      'Share is unavailable here. Copy the invitation code to share it.',
    );
  });

  it('revokes the code by id, confirms, re-reads the members and returns to the waiting state', async () => {
    const { request, server } = setup();
    server.override = (path, init) => {
      if (path.endsWith('/invites') && init?.method === 'POST') return response({ invite }, 201);
      if (path.endsWith('/invites/invite-1') && init?.method === 'DELETE')
        return response({ revoked: true });
      return undefined;
    };
    const ui = await start();
    await openInvite(ui);
    await fireEvent.press(await ui.findByTestId('real-group-revoke-invite'));
    expect(await ui.findByText('Code revoked. Make a new one when you need it.')).toBeTruthy();
    expect(callsTo(request, 'DELETE', '/real/groups/group-a/invites/invite-1')).toHaveLength(1);
    await waitFor(() => expect(ui.queryByTestId('real-group-invite-code')).toBeNull());
    expect(ui.getByText('— — —')).toBeTruthy();
    // A new code is only made on request now.
    expect(callsTo(request, 'POST', '/real/groups/group-a/invites')).toHaveLength(1);
    await fireEvent.press(ui.getByTestId('real-group-create-invite'));
    await waitFor(() =>
      expect(callsTo(request, 'POST', '/real/groups/group-a/invites')).toHaveLength(2),
    );
    expect(await ui.findByTestId('real-group-invite-code')).toHaveTextContent('ABC-DEF');
  });

  it('shows why a code could not be made, with the server reason when there is one', async () => {
    const { server } = setup();
    let reply: Response = response({ message: 'Too many open invitations.' }, 429);
    server.override = (path, init) =>
      path.endsWith('/invites') && init?.method === 'POST' ? reply : undefined;
    const ui = await start();
    await openInvite(ui);
    expect(await ui.findByTestId('real-invite-feedback')).toHaveTextContent(
      'Too many open invitations.',
    );
    expect(ui.queryByTestId('real-group-invite-code')).toBeNull();
    reply = response({}, 500);
    await fireEvent.press(ui.getByTestId('real-group-create-invite'));
    await waitFor(() =>
      expect(ui.getByTestId('real-invite-feedback')).toHaveTextContent(
        'The invitation could not be created. Retry when connected.',
      ),
    );
  });

  it('keeps the code and shows why when revoking fails', async () => {
    const { server } = setup();
    server.override = (path, init) => {
      if (path.endsWith('/invites') && init?.method === 'POST') return response({ invite }, 201);
      if (init?.method === 'DELETE') return response({}, 500);
      return undefined;
    };
    const ui = await start();
    await openInvite(ui);
    await fireEvent.press(await ui.findByTestId('real-group-revoke-invite'));
    expect(await ui.findByTestId('real-invite-feedback')).toHaveTextContent(
      'The invitation could not be revoked. Try again.',
    );
    expect(ui.getByTestId('real-group-invite-code')).toHaveTextContent('ABC-DEF');
  });

  it('offers a member no Invite row and never creates a code', async () => {
    const member = makeGroup('group-a', 'Saturday table', 'member');
    const { request } = setup({ current: member, groups: [member] });
    const ui = await start();
    await openSettings(ui);
    await ui.findByTestId('real-settings-members');
    expect(ui.queryByTestId('real-settings-invite')).toBeNull();
    expect(callsTo(request, 'POST', /\/invites$/)).toHaveLength(0);
  });
});

describe('switching and creating groups', () => {
  const beta = makeGroup('group-b', 'Garden circle', 'member');
  const alpha = makeGroup('group-a', 'Saturday table');

  it('switches from the header menu: posts the group id, toasts, and shows the other group', async () => {
    const { request } = setup({ current: alpha, groups: [alpha, beta] });
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    const menu = within(ui.getByTestId('real-group-switcher'));
    expect(menu.getByText('Your groups')).toBeTruthy();
    expect(ui.getByTestId('switch-real-group-group-a').props.accessibilityState.checked).toBe(true);
    expect(ui.getByTestId('switch-real-group-group-b').props.accessibilityState.checked).toBe(
      false,
    );
    await fireEvent.press(ui.getByTestId('switch-real-group-group-b'));
    await waitFor(() => expect(heading(ui)).toBe('Garden circle'));
    const [post] = callsTo(request, 'POST', '/real/groups/current');
    expect(post[1]).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: 'group-b' }),
    });
    expect(await ui.findByText('Switched to Garden circle.')).toBeTruthy();
    expect(ui.queryByTestId('real-group-switcher')).toBeNull();
    expect(ui.getByTestId('real-group-cycle-prompt').props.children).toBe(
      'Prompt for Garden circle',
    );
    expect(callsTo(request, 'GET', '/real/groups/group-b/members').length).toBeGreaterThan(0);
  });

  it('closes the menu without a request when the current group is chosen again', async () => {
    const { request } = setup({ current: alpha, groups: [alpha, beta] });
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    await fireEvent.press(ui.getByTestId('switch-real-group-group-a'));
    expect(ui.queryByTestId('real-group-switcher')).toBeNull();
    expect(callsTo(request, 'POST', '/real/groups/current')).toHaveLength(0);
  });

  it('closes the menu from its dismiss layer', async () => {
    setup({ current: alpha, groups: [alpha, beta] });
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    await fireEvent.press(ui.getByTestId('real-group-menu-dismiss'));
    expect(ui.queryByTestId('real-group-switcher')).toBeNull();
  });

  it('switches from Settings → Switch group, toasts, and returns to Settings on the new group', async () => {
    setup({ current: alpha, groups: [alpha, beta] });
    const ui = await start();
    await openSettings(ui);
    await fireEvent.press(await ui.findByTestId('real-settings-groups'));
    expect(ui.getByTestId('real-settings-switch-group-a').props.accessibilityState.selected).toBe(
      true,
    );
    await fireEvent.press(ui.getByTestId('real-settings-switch-group-b'));
    expect(await ui.findByText('Switched to Garden circle.')).toBeTruthy();
    const summary = await ui.findByTestId('real-settings-group-summary');
    expect(within(ui.getByTestId('real-settings-main')).getByText('Garden circle')).toBeTruthy();
    expect(summary).toHaveTextContent(/^Member · /);
    await fireEvent.press(ui.getByTestId('real-settings-back'));
    expect(heading(ui)).toBe('Garden circle');
  });

  it('stays on the current group and says why when the switch is refused', async () => {
    const { server } = setup({ current: alpha, groups: [alpha, beta] });
    server.override = (path, init) =>
      path === '/real/groups/current' && init?.method === 'POST' ? response({}, 503) : undefined;
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    await fireEvent.press(ui.getByTestId('switch-real-group-group-b'));
    expect(await ui.findByTestId('real-group-switch-error')).toHaveTextContent(
      'Your group could not be loaded. Retry when connected.',
    );
    expect(heading(ui)).toBe('Saturday table');
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    expect(ui.getByTestId('switch-real-group-group-a').props.accessibilityState.checked).toBe(true);
    expect(ui.getByTestId('switch-real-group-group-b').props.accessibilityState).toMatchObject({
      checked: false,
      disabled: false,
    });
  });

  it('says the group is not available when the server selects none', async () => {
    const { server } = setup({ current: alpha, groups: [alpha, beta] });
    server.override = (path, init) =>
      path === '/real/groups/current' && init?.method === 'POST'
        ? response({ group: null })
        : undefined;
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    await fireEvent.press(ui.getByTestId('switch-real-group-group-b'));
    expect(await ui.findByTestId('real-group-switch-error')).toHaveTextContent(
      'That group is not available to this account.',
    );
    expect(heading(ui)).toBe('Saturday table');
  });

  it('creates a group from the menu: posts name, prompt and limit, toasts, and shows it', async () => {
    const { request } = setup();
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    await fireEvent.press(ui.getByTestId('real-group-menu-create'));
    expect(ui.queryByTestId('real-group-switcher')).toBeNull();
    expect(ui.getByRole('header', { name: 'New group' })).toBeTruthy();
    await fireEvent.changeText(ui.getByTestId('real-group-name'), '  Sunday walk  ');
    await fireEvent.press(ui.getByTestId('real-group-capacity-decrease'));
    await fireEvent.press(ui.getByTestId('real-group-create-submit'));
    await waitFor(() => expect(heading(ui)).toBe('Sunday walk'));
    const [post] = callsTo(request, 'POST', '/real/groups');
    expect(post[1]).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Sunday walk',
        prompt: 'What made you pause and smile?',
        maxMembers: 9,
      }),
    });
    expect(await ui.findByText('Created “Sunday walk”.')).toBeTruthy();
    expect(ui.queryByRole('header', { name: 'New group' })).toBeNull();
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    expect(ui.getByTestId('switch-real-group-group-new').props.accessibilityState.checked).toBe(
      true,
    );
    expect(ui.getByTestId('switch-real-group-group-a')).toBeTruthy();
  });

  it('keeps the form and shows the reason when creation fails', async () => {
    const { server } = setup();
    server.override = (path, init) =>
      path === '/real/groups' && init?.method === 'POST' ? response({}, 400) : undefined;
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    await fireEvent.press(ui.getByTestId('real-group-menu-create'));
    await fireEvent.changeText(ui.getByTestId('real-group-name'), 'Sunday walk');
    await fireEvent.press(ui.getByTestId('real-group-create-submit'));
    expect(
      await ui.findByText('The group could not be created. Check the details and retry.'),
    ).toBeTruthy();
    expect(ui.getByTestId('real-group-name').props.value).toBe('Sunday walk');
    expect(ui.getByTestId('real-group-create-submit')).toBeEnabled();
    expect(heading(ui)).toBe('Saturday table');
    // Back clears the error for the next visit.
    await fireEvent.press(ui.getByTestId('real-create-back'));
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    await fireEvent.press(ui.getByTestId('real-group-menu-create'));
    expect(
      ui.queryByText('The group could not be created. Check the details and retry.'),
    ).toBeNull();
  });

  it('opens Have an invite? from the menu over Home', async () => {
    setup();
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-menu-button'));
    await fireEvent.press(ui.getByTestId('real-group-menu-join'));
    expect(ui.getByRole('header', { name: 'Have an invite?' })).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-join-back'));
    expect(ui.getByTestId('real-group-home')).toBeTruthy();
  });
});

describe('moving between screens', () => {
  it('moves Home → Chat → Archive → Home with the dock, marking the selected tab', async () => {
    const { request } = setup();
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-nav-chat'));
    expect(ui.getByPlaceholderText('Message Saturday table')).toBeTruthy();
    expect(ui.queryByTestId('real-group-home')).toBeNull();
    expect(ui.getByTestId('real-group-nav-chat').props.accessibilityState.selected).toBe(true);
    expect(ui.getByTestId('real-group-nav-home').props.accessibilityState.selected).toBe(false);
    // The header stays pinned over Chat, so the menu and Settings remain reachable.
    expect(ui.getByTestId('real-group-menu-button')).toBeTruthy();

    await fireEvent.press(ui.getByTestId('real-group-nav-archive'));
    await ui.findByTestId('real-archive-first');
    expect(ui.getByTestId('real-group-nav-archive').props.accessibilityState.selected).toBe(true);
    expect(ui.queryByPlaceholderText('Message Saturday table')).toBeNull();
    expect(callsTo(request, 'GET', '/archive?groupId=group-a&limit=20')).toHaveLength(1);

    await fireEvent.press(ui.getByTestId('real-group-nav-home'));
    expect(await ui.findByTestId('real-group-home')).toBeTruthy();
    expect(ui.getByTestId('real-group-nav-home').props.accessibilityState.selected).toBe(true);
  });

  it('walks Settings → Members and back out, one level per Back press', async () => {
    const { request } = setup();
    const ui = await start();
    await openSettings(ui);
    expect(await ui.findByTestId('real-settings-main')).toBeTruthy();
    expect(ui.getByRole('header', { name: 'Settings' })).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-settings-members'));
    expect(ui.getByTestId('real-settings-members')).toBeTruthy();
    expect(ui.getByRole('header', { name: 'Members' })).toBeTruthy();
    expect(await ui.findByLabelText('Ada Owner, owner')).toBeTruthy();
    expect(ui.getByLabelText('Casey, member')).toBeTruthy();
    // Opening Members asks which people are blocked.
    expect(callsTo(request, 'GET', '/real/blocks')).toHaveLength(1);

    await fireEvent.press(ui.getByRole('button', { name: 'Back' }));
    expect(ui.getByRole('header', { name: 'Settings' })).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-settings-back'));
    expect(ui.queryByRole('header', { name: 'Settings' })).toBeNull();
    expect(ui.getByTestId('real-group-home')).toBeTruthy();
  });

  it('marks blocked people in Members from the server list', async () => {
    const { server } = setup();
    server.override = (path) =>
      path === '/real/blocks'
        ? response({ blocked: [{ profileId: 'profile-friend' }] })
        : undefined;
    const ui = await start();
    await openSettings(ui);
    await fireEvent.press(await ui.findByTestId('real-settings-members'));
    await waitFor(() =>
      expect(within(ui.getByLabelText('Casey, member')).getByText('Member · blocked')).toBeTruthy(),
    );
  });

  it('stacks Join and Create over Settings and returns to Settings', async () => {
    setup();
    const ui = await start();
    await openSettings(ui);
    await fireEvent.press(await ui.findByTestId('real-settings-join'));
    expect(ui.getByRole('header', { name: 'Have an invite?' })).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-join-back'));
    expect(ui.getByRole('header', { name: 'Settings' })).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-settings-create'));
    expect(ui.getByRole('header', { name: 'New group' })).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-create-back'));
    expect(ui.getByRole('header', { name: 'Settings' })).toBeTruthy();
  });

  it('opens Your moments from the allowance row and closes it with Back', async () => {
    setup();
    const ui = await start();
    await waitFor(() =>
      expect(ui.getByTestId('real-group-allowance').props.accessibilityLabel).toBe(
        'Your moments: 0 of 5, 0 of 30 seconds',
      ),
    );
    await fireEvent.press(ui.getByTestId('real-group-allowance'));
    expect(ui.getByTestId('real-moments')).toBeTruthy();
    expect(ui.getByRole('header', { name: 'Your moments' })).toBeTruthy();
    expect(ui.getByTestId('real-moments-count')).toHaveTextContent('0 of 5');
    expect(await ui.findByText('Nothing sealed yet this week.')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-moments-back'));
    expect(ui.queryByTestId('real-moments')).toBeNull();
    expect(ui.getByTestId('real-group-home')).toBeTruthy();
  });

  it('opens the film from the Home premiere card and closes back to Home', async () => {
    const released = makeGroup('group-a', 'Saturday table', 'owner', {
      releases: [
        {
          cycleId: 'cycle-old',
          endsAt: new Date(Date.now() - 10 * DAY).toISOString(),
          publishedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          state: 'premiere',
        },
      ],
    });
    const { request, server } = setup({ current: released, groups: [released] });
    server.override = (path) =>
      path.startsWith('/cycles/')
        ? response({ premiere: { state: 'processing' } }, 404)
        : undefined;
    const ui = await start();
    expect(
      within(ui.getByTestId('real-home-card-released')).getByText('Your film is here'),
    ).toBeTruthy();
    expect(ui.getByTestId('real-group-nav-archive').props.accessibilityLabel).toBe(
      'Archive, new film',
    );
    await fireEvent.press(ui.getByTestId('real-home-watch'));
    expect(await ui.findByTestId('real-film')).toBeTruthy();
    expect(callsTo(request, 'GET', '/cycles/cycle-old/premiere?groupId=group-a')).toHaveLength(1);
    await fireEvent.press(await ui.findByTestId('real-film-close'));
    expect(ui.queryByTestId('real-film')).toBeNull();
    expect(ui.getByTestId('real-group-home')).toBeTruthy();
  });

  it('checks the media mode before opening Capture, and Close returns to Home', async () => {
    const { request } = setup();
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-capture-action'));
    expect(await ui.findByTestId('camera-screen')).toBeTruthy();
    expect(callsTo(request, 'GET', '/real/media/config?uploadProtocol=2')).toHaveLength(1);
    expect(ui.getByTestId('camera-group-context')).toHaveTextContent('Group · Saturday table');
    await fireEvent.press(ui.getByTestId('capture-back-to-group'));
    expect(await ui.findByTestId('real-group-home')).toBeTruthy();
    expect(ui.queryByTestId('camera-screen')).toBeNull();
  });

  it('goes Photo → Video → Photo inside Capture, and closes from either', async () => {
    setup();
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-capture-action'));
    await fireEvent.press(await ui.findByTestId('camera-record-clip'));
    expect(await ui.findByTestId('video-capture-screen')).toBeTruthy();
    expect(ui.queryByTestId('camera-screen')).toBeNull();
    await fireEvent.press(ui.getByTestId('video-photo-mode'));
    expect(await ui.findByTestId('camera-screen')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('camera-record-clip'));
    await ui.findByTestId('video-capture-screen');
    await fireEvent.press(ui.getByTestId('video-close'));
    expect(await ui.findByTestId('real-group-home')).toBeTruthy();
    expect(ui.queryByTestId('video-capture-screen')).toBeNull();
  });

  it('stays on Home with the reason when the media mode cannot be read', async () => {
    const { server } = setup();
    server.override = (path) =>
      path === '/real/media/config?uploadProtocol=2' ? response({}, 503) : undefined;
    const ui = await start();
    await fireEvent.press(ui.getByTestId('real-group-capture-action'));
    expect(await ui.findByTestId('real-group-switch-error')).toHaveTextContent(
      'Capture settings are unavailable. Reconnect or sign in again, then retry.',
    );
    expect(ui.queryByTestId('camera-screen')).toBeNull();
    expect(ui.getByTestId('real-group-capture-action')).toBeEnabled();
  });
});

describe('account actions in Settings', () => {
  it('signs out only after the confirmation', async () => {
    const { auth } = setup();
    const ui = await start();
    await openSettings(ui);
    await fireEvent.press(await ui.findByTestId('real-group-sign-out'));
    expect(auth.signOut).not.toHaveBeenCalled();
    await fireEvent.press(ui.getByTestId('real-group-sign-out-confirm'));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('shows the unconfirmed sign-out notice and a "Retry sign out" label', async () => {
    setup({}, { notice: 'revocation-unconfirmed' });
    const ui = await start();
    expect(ui.getByTestId('logout-unconfirmed')).toHaveTextContent(
      'This device signed out, but server revocation was not confirmed. Another device may remain signed in until expiry or account reset.',
    );
    await openSettings(ui);
    expect(
      within(await ui.findByTestId('real-group-sign-out')).getByText('Retry sign out'),
    ).toBeTruthy();
    expect(ui.getByTestId('settings-logout-unconfirmed')).toBeTruthy();
  });

  it('passes the typed password to the account deletion, and asks a Cognito account for DELETE', async () => {
    const { auth } = setup();
    const ui = await start();
    await openSettings(ui);
    await fireEvent.press(await ui.findByTestId('real-settings-delete'));
    await fireEvent.changeText(ui.getByTestId('real-delete-password'), 'secret words');
    await fireEvent.press(ui.getByTestId('real-delete-account'));
    await fireEvent.press(ui.getByTestId('real-delete-confirm'));
    await waitFor(() => expect(auth.deleteAccount).toHaveBeenCalledWith('secret words'));
    await ui.unmount();

    setup(
      {},
      {
        session: { account: { id: 'a', username: 'u', displayName: 'U' }, signInMethod: 'cognito' },
      },
    );
    const cognito = await start();
    await openSettings(cognito);
    await fireEvent.press(await cognito.findByTestId('real-settings-delete'));
    expect(cognito.getByLabelText('Type DELETE to confirm')).toBeTruthy();
    expect(cognito.queryByTestId('real-delete-password')).toBeNull();
  });
});
