import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { useRealAccount } from '../src/auth/RealAccountProvider';
import {
  photoContributionStatusForJob,
  RealAccountGroupExperience,
} from '../src/groups/RealAccountGroupExperience';
import { jsonResponse } from './mocks/fetch';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));
const eventSources: { close: jest.Mock }[] = [];
jest.mock('../src/chat/native-event-source', () => ({
  createRuntimeEventSource: () => {
    const source = {
      addEventListener: jest.fn(),
      close: jest.fn(),
      onerror: null,
      onopen: null,
      removeEventListener: jest.fn(),
    };
    eventSources.push(source);
    return source;
  },
}));

const persistedGroup = {
  group: { id: 'real-group-1', name: 'Saturday table', role: 'owner' as const, maxMembers: 2 },
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

describe('real account group journey', () => {
  it('shows the server group rate-limit message in the existing creation error slot', async () => {
    const message = 'You have reached the group creation limit. Please try again later.';
    const authenticatedRequest = jest.fn(async (path: string, init?: RequestInit) => {
      if (path === '/real/media/config?uploadProtocol=2')
        return jsonResponse({ directTransfer: false });
      if (path === '/real/groups/current') return jsonResponse({ group: null });
      if (path === '/real/groups' && init?.method !== 'POST') return jsonResponse({ groups: [] });
      if (path === '/real/groups' && init?.method === 'POST')
        return jsonResponse({ error: 'rate_limited', message }, 429);
      throw new Error(`Unexpected authenticated request: ${path}`);
    });
    (useRealAccount as jest.Mock).mockReturnValue({ authenticatedRequest, signOut: jest.fn() });
    const result = await render(<RealAccountGroupExperience displayName="Real Owner" />);
    await fireEvent.press(await result.findByTestId('real-group-create-choice'));
    await fireEvent.changeText(result.getByTestId('real-group-name'), 'Saturday table');
    await fireEvent.press(result.getByTestId('real-group-create-submit'));
    expect(await result.findByText(message)).toBeTruthy();
    expect(result.getByTestId('real-group-create-submit')).toBeEnabled();
    expect(result.queryByTestId('real-group-home')).toBeNull();
  });

  it('keeps active capture separate from older releases and opens real Archive', async () => {
    const activeGroup = {
      ...persistedGroup,
      releases: [
        {
          cycleId: 'real-cycle-older',
          endsAt: '2026-09-01T00:00:00.000Z',
          publishedAt: null,
          state: 'processing' as const,
        },
        {
          cycleId: persistedGroup.cycle.id,
          endsAt: persistedGroup.cycle.endsAt,
          publishedAt: null,
          state: 'processing' as const,
        },
      ],
    };
    const authenticatedRequest = jest.fn(async (path: string) => {
      if (path === '/real/media/config?uploadProtocol=2')
        return jsonResponse({ directTransfer: false });
      if (path === '/real/groups/current') return jsonResponse({ group: activeGroup });
      if (path === '/real/groups') return jsonResponse({ groups: [activeGroup] });
      if (path.endsWith('/members'))
        return jsonResponse({
          group: { id: activeGroup.group.id, name: activeGroup.group.name },
          members: [],
          pendingInviteCount: 0,
        });
      if (path.startsWith('/contributions?'))
        return jsonResponse({
          cycleId: activeGroup.cycle.id,
          memberId: 'real-member-1',
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
      if (path.startsWith('/archive?'))
        return jsonResponse({
          archive: { films: [], clips: [] },
          pagination: {
            filmCursor: null,
            clipCursor: null,
            hasMoreFilms: false,
            hasMoreClips: false,
          },
        });
      if (path.startsWith('/cycles/'))
        return jsonResponse({ premiere: { state: 'processing', cycleId: activeGroup.cycle.id } });
      throw new Error(`Unexpected authenticated request: ${path}`);
    });
    (useRealAccount as jest.Mock).mockReturnValue({
      baseUrl: 'https://api.example.test',
      authenticatedRequest,
      signOut: jest.fn(),
    });

    const result = await render(<RealAccountGroupExperience displayName="Real Owner" />);
    await result.findByTestId('real-group-home');
    expect(result.getByTestId('real-group-cycle-prompt').props.children).toBe(
      persistedGroup.cycle.prompt,
    );
    // The older cycle's film is developing; the current cycle never shows as a release.
    expect(result.getByTestId('real-home-card-developing')).toHaveTextContent(
      /Your film is developing/,
    );
    expect(result.queryAllByTestId(/^real-home-card-/)).toHaveLength(1);

    await fireEvent.press(result.getByTestId('real-group-nav-archive'));
    await result.findByTestId('real-archive-first');
    expect(authenticatedRequest).toHaveBeenCalledWith('/archive?groupId=real-group-1&limit=20');
    // The top card follows the group's release state instead of a separate premiere request.
    expect(result.getByTestId('real-archive-now')).toHaveTextContent(/Your film is developing/);
    await fireEvent.press(result.getByTestId('real-group-nav-home'));
    await result.findByTestId('real-group-home');

    // #402: the bottom navigation reaches Archive and returns Home.
    expect(result.getByTestId('real-group-navigation')).toBeTruthy();
    await fireEvent.press(result.getByTestId('real-group-nav-archive'));
    await result.findByTestId('real-archive-first');
    expect(result.getByTestId('real-group-navigation')).toBeTruthy();
    await fireEvent.press(result.getByTestId('real-group-nav-home'));
    await result.findByTestId('real-group-home');
    await result.unmount();
  });

  it('joins an invited group with a six-letter code without a group ID', async () => {
    let joined = false;
    const authenticatedRequest = jest.fn(async (path: string, init?: RequestInit) => {
      if (path === '/real/media/config?uploadProtocol=2')
        return jsonResponse({ directTransfer: false });
      if (path === '/real/groups/current') return jsonResponse({ group: null });
      if (path === '/real/groups') return jsonResponse({ groups: [] });
      if (path === '/real/invites/accept') {
        expect(JSON.parse(String(init?.body))).toEqual({ code: 'ABCDEF' });
        joined = true;
        return jsonResponse({ group: persistedGroup });
      }
      if (path.endsWith('/members'))
        return jsonResponse({
          group: { id: persistedGroup.group.id, name: persistedGroup.group.name },
          members: [],
          pendingInviteCount: 0,
        });
      if (path.startsWith('/contributions?'))
        return jsonResponse({
          cycleId: persistedGroup.cycle.id,
          memberId: 'real-member-1',
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
      throw new Error(`Unexpected authenticated request: ${path}`);
    });
    (useRealAccount as jest.Mock).mockReturnValue({ authenticatedRequest, signOut: jest.fn() });

    const result = await render(<RealAccountGroupExperience displayName="Invited member" />);
    await fireEvent.press(await result.findByTestId('real-group-join-start'));
    await fireEvent.changeText(result.getByTestId('real-group-enter-code'), 'abc-def');
    expect(result.getByTestId('real-group-enter-code').props.value).toBe('ABC-DEF');
    await fireEvent.press(result.getByTestId('real-group-join-choice'));
    expect(await result.findByTestId('real-join-done')).toHaveTextContent(/Joined Saturday table/);
    await fireEvent.press(result.getByTestId('real-join-go'));
    await result.findByTestId('real-group-home');
    expect(joined).toBe(true);
    expect(result.getByTestId('real-group-name-heading').props.children).toBe('Saturday table');
    await result.unmount();
  });

  it('refreshes both Home allowance displays from the ledger when returning from capture', async () => {
    const activeGroup = { ...persistedGroup, memberId: 'real-member-1' };
    let ledgerRead = 0;
    const authenticatedRequest = jest.fn(async (path: string) => {
      if (path === '/real/media/config?uploadProtocol=2')
        return jsonResponse({ directTransfer: false });
      if (path === '/real/groups/current') return jsonResponse({ group: activeGroup });
      if (path === '/real/groups') return jsonResponse({ groups: [activeGroup] });
      if (path.endsWith('/members'))
        return jsonResponse({
          group: { id: activeGroup.group.id, name: activeGroup.group.name },
          members: [],
          pendingInviteCount: 0,
        });
      if (path.startsWith('/contributions?')) {
        ledgerRead += 1;
        const countUsed = ledgerRead === 1 ? 1 : 3;
        return jsonResponse({
          cycleId: activeGroup.cycle.id,
          memberId: 'real-member-1',
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
      }
      throw new Error(`Unexpected authenticated request: ${path}`);
    });
    (useRealAccount as jest.Mock).mockReturnValue({ authenticatedRequest, signOut: jest.fn() });

    const result = await render(<RealAccountGroupExperience displayName="Real Owner" />);
    await result.findByTestId('real-group-home');
    await waitFor(() =>
      expect(result.getByTestId('real-group-allowance').props.accessibilityLabel).toContain(
        '1 of 5',
      ),
    );
    expect(result.getByText('You · 1 of 5 · 3 of 30 s')).toBeTruthy();
    expect(result.getByTestId('real-group-capture-action').props.accessibilityLabel).toBe(
      'Add a moment · 4 of 5 left',
    );

    await fireEvent.press(result.getByTestId('real-group-capture-action'));
    await result.findByTestId('camera-screen');
    await fireEvent.press(result.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(ledgerRead).toBeGreaterThanOrEqual(3));
    await waitFor(() =>
      expect(result.getByTestId('real-group-allowance').props.accessibilityLabel).toContain(
        '3 of 5',
      ),
    );
    expect(result.getByTestId('real-group-capture-action').props.accessibilityLabel).toBe(
      'Add a moment · 2 of 5 left',
    );
    expect(result.getByTestId('real-group-allowance').props.accessibilityLabel).toContain(
      '9 of 30 seconds',
    );
  });

  it('keeps an already-processing photo queued or processing and reserves retryable failure for terminal jobs', () => {
    const details = {
      contributionId: 'contribution-photo-1',
      createdAt: '2026-09-29T00:00:00.000Z',
      durationSeconds: 3,
      jobId: 'photo-job-1',
    };

    expect(photoContributionStatusForJob('pending', details)).toMatchObject({
      state: 'queued',
      retryable: false,
    });
    expect(photoContributionStatusForJob('processing', details)).toMatchObject({
      state: 'processing',
      retryable: false,
    });
    expect(photoContributionStatusForJob('ready', details)).toMatchObject({
      state: 'sealed',
      retryable: false,
    });
    expect(photoContributionStatusForJob('failed', details)).toMatchObject({
      state: 'failed',
      retryable: true,
    });
    expect(photoContributionStatusForJob('cancelled', details)).toMatchObject({
      state: 'failed',
      retryable: true,
    });
  });

  it('creates from the first-run choice and restores persisted group Home after remount', async () => {
    let saved: typeof persistedGroup | null = null;
    const authenticatedRequest = jest.fn(async (path: string, init?: RequestInit) => {
      if (path === '/real/media/config?uploadProtocol=2')
        return jsonResponse({ directTransfer: false });
      if (path === '/real/groups/current') return jsonResponse({ group: saved });
      if (path === '/real/groups' && init?.method !== 'POST')
        return jsonResponse({ groups: saved ? [saved] : [] });
      if (path.endsWith('/members'))
        return jsonResponse({
          group: { id: saved?.group.id, name: saved?.group.name },
          members: saved
            ? [{ displayName: 'Real Owner', role: 'owner', joinedAt: '2026-09-28T00:00:00.000Z' }]
            : [],
          pendingInviteCount: 0,
        });
      if (path === '/real/groups' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          name: 'Saturday table',
          prompt: 'What made you pause and smile?',
          maxMembers: 2,
        });
        saved = persistedGroup;
        return jsonResponse(saved, 201);
      }
      if (path.startsWith('/contributions?'))
        return jsonResponse({
          cycleId: persistedGroup.cycle.id,
          memberId: 'real-member-1',
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
      throw new Error(`Unexpected authenticated request: ${path}`);
    });
    (useRealAccount as jest.Mock).mockReturnValue({ authenticatedRequest, signOut: jest.fn() });

    const first = await render(<RealAccountGroupExperience displayName="Real Owner" />);
    await first.findByTestId('real-group-create-choice');
    expect(first.getByTestId('real-group-join-start')).toBeEnabled();
    await fireEvent.press(first.getByTestId('real-group-create-choice'));
    await fireEvent.changeText(first.getByTestId('real-group-name'), '   ');
    await fireEvent.press(first.getByTestId('real-group-create-submit'));
    expect(first.getByText(/enter a group name/i)).toBeTruthy();
    await fireEvent.changeText(first.getByTestId('real-group-name'), 'Saturday table');
    for (let index = 0; index < 8; index += 1) {
      await fireEvent.press(first.getByTestId('real-group-capacity-decrease'));
    }
    expect(first.getByTestId('real-group-capacity').props.children).toBe(2);
    await fireEvent.press(first.getByTestId('real-group-create-submit'));
    await first.findByTestId('real-group-home');
    expect(first.getByText('Nothing sealed yet this week')).toBeTruthy();
    expect(first.getByTestId('real-group-menu-button').props.accessibilityLabel).toBe(
      'Saturday table · switch group',
    );
    expect(first.getByTestId('real-group-name-heading').props.children).toBe('Saturday table');
    await fireEvent.press(first.getByTestId('real-account-settings-button'));
    await fireEvent.press(await first.findByTestId('real-settings-members'));
    expect(await first.findByTestId('real-group-member-0')).toHaveTextContent(/Real Owner.*Owner/);
    expect(first.getByTestId('real-group-member-0').props.accessibilityLabel).toBe(
      'Real Owner, owner',
    );
    await fireEvent.press(first.getByLabelText('Back'));
    await fireEvent.press(first.getByTestId('real-settings-back'));
    expect(first.queryByText('LOCKED')).toBeNull();
    await fireEvent.press(first.getByTestId('real-group-capture-action'));
    expect(await first.findByTestId('camera-screen')).toBeTruthy();
    await fireEvent.press(first.getByTestId('camera-record-clip'));
    await first.findByTestId('video-capture-screen');
    expect(first.getByRole('tab', { name: 'Video', selected: true })).toBeTruthy();
    expect(first.queryByTestId('real-group-capture-unavailable')).toBeNull();

    await first.unmount();
    const restored = await render(<RealAccountGroupExperience displayName="Real Owner" />);
    await restored.findByTestId('real-group-home');
    expect(restored.getByTestId('real-group-name-heading').props.children).toBe('Saturday table');
    expect(authenticatedRequest).toHaveBeenCalledWith('/real/groups/current');
    await restored.unmount();
  });
});

/** The live-state cases run on a controlled clock one hour before the allowance resets. */
describe('open session reconciles with the server (#521)', () => {
  type Group = typeof persistedGroup & {
    memberId?: string;
    releases?: { cycleId: string; endsAt: string; publishedAt: string | null; state: string }[];
  };
  const T0 = '2026-10-04T23:00:00.000Z';
  const RESET = Date.parse('2026-10-05T00:00:00.000Z');
  const owner: Group = { ...persistedGroup, memberId: 'real-member-1' };
  const olderRelease = (state: string, publishedAt: string | null = null) => ({
    cycleId: 'real-cycle-0',
    endsAt: '2026-09-28T00:00:00.000Z',
    publishedAt,
    state,
  });
  const filmBody = (id: string, cycleId: string) => ({
    id,
    cycleId,
    publishedAt: '2026-10-05T01:00:00.000Z',
    downloadPath: `/media/access/${'d'.repeat(43)}`,
    playbackPath: `/media/access/${'p'.repeat(43)}`,
  });

  interface Server {
    group: Group | null;
    groups: Group[];
    countUsed: number;
    secondsUsed: number;
    failCurrent: boolean;
    failLedger: boolean;
    /** One entry per upcoming GET /real/groups/current, resolved by the test. */
    gates: Promise<void>[];
    films: ReturnType<typeof filmBody>[];
    olderFilms: ReturnType<typeof filmBody>[];
  }
  let server: Server;
  let authenticatedRequest: jest.Mock;
  let appStateListeners: Set<(state: string) => void>;
  let originalAddEventListener: typeof AppState.addEventListener;

  const calls = (path: string) =>
    authenticatedRequest.mock.calls.filter(
      ([requested, init]) => requested === path && init?.method !== 'POST',
    ).length;
  const ledgerCalls = () =>
    authenticatedRequest.mock.calls.filter(([path]) => String(path).startsWith('/contributions?'))
      .length;
  const advance = (ms: number) =>
    act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  const toBoundary = async (extraMs = 0) => advance(RESET - Date.now() + 1_500 + extraMs);
  const emitAppState = (state: string) =>
    act(async () => {
      appStateListeners.forEach((listener) => listener(state));
      await jest.advanceTimersByTimeAsync(0);
    });
  const shutter = (screen: Awaited<ReturnType<typeof render>>) =>
    screen.getByTestId('real-group-capture-action').props.accessibilityLabel as string;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(T0) });
    appStateListeners = new Set();
    originalAddEventListener = AppState.addEventListener;
    (AppState as unknown as { addEventListener: unknown }).addEventListener = ((
      _event: string,
      listener: (state: string) => void,
    ) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    }) as never;
    server = {
      group: owner,
      groups: [owner],
      countUsed: 5,
      secondsUsed: 15,
      failCurrent: false,
      failLedger: false,
      gates: [],
      films: [],
      olderFilms: [],
    };
    authenticatedRequest = jest.fn(async (path: string, init?: RequestInit) => {
      if (path === '/real/media/config?uploadProtocol=2')
        return jsonResponse({ directTransfer: false });
      if (path === `/real/groups/${server.group?.group.id}/reminders/destinations`)
        return jsonResponse({ destinations: [] });
      if (path === '/real/groups/current' && init?.method === 'POST') {
        const { groupId } = JSON.parse(String(init.body)) as { groupId: string };
        server.group = server.groups.find((entry) => entry.group.id === groupId) ?? null;
        return jsonResponse({ group: server.group });
      }
      if (path === '/real/groups/current') {
        const snapshot = server.group;
        const gate = server.gates.shift();
        if (gate) await gate;
        if (server.failCurrent) throw new Error('offline');
        return jsonResponse({ group: snapshot });
      }
      if (path === '/real/groups') return jsonResponse({ groups: server.groups });
      if (path.endsWith('/members'))
        return jsonResponse({
          group: { id: server.group?.group.id, name: server.group?.group.name },
          members: [],
          pendingInviteCount: 0,
        });
      if (path.endsWith('/reminders'))
        return jsonResponse({ preference: { enabled: false, snoozedUntil: null } });
      if (path.startsWith('/realtime/groups/'))
        return jsonResponse({ events: [], nextCursor: null, watermarkEventId: 0, hasMore: false });
      if (path.startsWith('/contributions?')) {
        if (server.failLedger) throw new Error('offline');
        return jsonResponse({
          cycleId: server.group?.cycle.id ?? '',
          memberId: 'real-member-1',
          allowance: {
            maxCount: 5,
            maxSeconds: 30,
            countUsed: server.countUsed,
            secondsUsed: server.secondsUsed,
            deletionsUsed: 0,
            deletionAvailability: 'available',
          },
          entries: [],
          latestContribution: null,
          pagination: { limit: 50, hasMore: false, nextCursor: null },
        });
      }
      if (path.startsWith('/archive?')) {
        const older = path.includes('filmCursor=older');
        return jsonResponse({
          archive: { films: older ? server.olderFilms : server.films, clips: [] },
          pagination: {
            filmCursor: !older && server.olderFilms.length ? 'older' : null,
            clipCursor: null,
            hasMoreFilms: !older && server.olderFilms.length > 0,
            hasMoreClips: false,
          },
        });
      }
      throw new Error(`Unexpected authenticated request: ${path}`);
    });
    (useRealAccount as jest.Mock).mockReturnValue({
      baseUrl: 'https://api.example.test',
      authenticatedRequest,
      session: { account: { id: 'account-1', username: 'owner' } },
      realtimeAuthorizationHeader: () => undefined,
      signOut: jest.fn(),
    });
  });
  afterEach(() => {
    (AppState as unknown as { addEventListener: unknown }).addEventListener =
      originalAddEventListener;
    jest.useRealTimers();
  });

  async function open(displayName = 'Real Owner') {
    const screen = await render(<RealAccountGroupExperience displayName={displayName} />);
    await screen.findByTestId('real-group-home');
    await waitFor(() =>
      expect(screen.getByTestId('real-group-allowance').props.accessibilityLabel).not.toContain(
        'loading',
      ),
    );
    return screen;
  }

  it.each([
    ['count', 5, 15, /5 moments are used/],
    ['seconds', 3, 30, /30 seconds are used/],
  ])(
    'frees an exhausted %s allowance once the seven-day window resets',
    async (_label, countUsed, secondsUsed, used) => {
      server.countUsed = countUsed;
      server.secondsUsed = secondsUsed;
      const screen = await open();
      expect(shutter(screen)).toMatch(used);
      expect(shutter(screen)).toContain('resets in 1 day');

      server.countUsed = 0;
      server.secondsUsed = 0;
      await toBoundary();

      expect(shutter(screen)).toBe('Add a moment · 5 of 5 left');
      expect(screen.getByTestId('real-group-allowance').props.accessibilityLabel).toContain(
        '0 of 5',
      );
      await screen.unmount();
    },
  );

  it('measures weeks from the cycle start, so a mid-cycle reset needs no reload', async () => {
    const midCycle = { ...owner, cycle: { ...owner.cycle, startsAt: '2026-09-21T06:00:00.000Z' } };
    server.group = midCycle;
    server.groups = [midCycle];
    const screen = await open();
    // Windows run 21 Sep 06:00, 28 Sep 06:00, 5 Oct 06:00: the next reset is 6 hours out.
    expect(shutter(screen)).toContain('resets in 1 day');
    server.countUsed = 0;
    server.secondsUsed = 0;
    await advance(7 * 60 * 60 * 1000 + 5_000);
    expect(shutter(screen)).toBe('Add a moment · 5 of 5 left');
    await screen.unmount();
  });

  it('adopts the next cycle at rollover without a reload', async () => {
    const ending = { ...owner, cycle: { ...owner.cycle, endsAt: '2026-10-05T00:00:00.000Z' } };
    server.group = ending;
    server.groups = [ending];
    const screen = await open();
    expect(screen.getByTestId('real-group-cycle-prompt').props.children).toBe(
      persistedGroup.cycle.prompt,
    );

    server.group = {
      ...owner,
      cycle: {
        ...owner.cycle,
        id: 'real-cycle-2',
        prompt: 'What did you cook this week?',
        startsAt: '2026-10-05T00:00:00.000Z',
        endsAt: '2026-11-02T00:00:00.000Z',
      },
      releases: [
        {
          cycleId: owner.cycle.id,
          endsAt: '2026-10-05T00:00:00.000Z',
          publishedAt: null,
          state: 'processing',
        },
      ],
    };
    server.countUsed = 0;
    server.secondsUsed = 0;
    await toBoundary();

    expect(screen.getByTestId('real-group-cycle-prompt').props.children).toBe(
      'What did you cook this week?',
    );
    expect(screen.getByTestId('real-home-card-developing')).toBeTruthy();
    expect(shutter(screen)).toBe('Add a moment · 5 of 5 left');
    expect(screen.getByTestId('real-group-week')).toHaveTextContent('Week 1 of 4');
    await screen.unmount();
  });

  it('notices a processing film being published, then stops polling', async () => {
    server.group = { ...owner, releases: [olderRelease('processing')] };
    const screen = await open();
    expect(screen.getByTestId('real-home-card-developing')).toBeTruthy();

    await advance(30_000);
    expect(calls('/real/groups/current')).toBe(2);
    expect(screen.getByTestId('real-home-card-developing')).toBeTruthy();

    server.group = { ...owner, releases: [olderRelease('premiere', '2026-10-04T23:01:00.000Z')] };
    await advance(30_000);
    expect(screen.getByTestId('real-home-card-released')).toBeTruthy();
    expect(screen.queryByTestId('real-home-card-developing')).toBeNull();

    const settled = calls('/real/groups/current');
    await advance(5 * 60 * 1000);
    expect(calls('/real/groups/current')).toBe(settled);
    await screen.unmount();
  });

  it('bounds polling when a film stays in processing', async () => {
    server.group = { ...owner, releases: [olderRelease('processing')] };
    const screen = await open();
    await advance(15 * 60 * 1000);
    const bounded = calls('/real/groups/current');
    expect(bounded).toBeLessThanOrEqual(21);
    await advance(30 * 60 * 1000);
    expect(calls('/real/groups/current')).toBe(bounded);
    await screen.unmount();
  });

  it('drops an expired premiere from Home and Chat while Chat keeps its draft', async () => {
    server.group = { ...owner, releases: [olderRelease('premiere', '2026-10-04T12:00:00.000Z')] };
    const screen = await open();
    expect(screen.getByTestId('real-home-card-released')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('real-group-nav-chat'));
    expect(await screen.findByTestId('real-chat-premiere')).toBeTruthy();
    await fireEvent.changeText(
      await screen.findByTestId('real-chat-composer'),
      'half-written thought',
    );

    // The premiere runs 24 hours from publication: until 12:00 on 5 Oct.
    server.group = { ...owner, releases: [olderRelease('archived', '2026-10-04T12:00:00.000Z')] };
    await advance(Date.parse('2026-10-05T12:00:03.000Z') - Date.now());

    expect(screen.queryByTestId('real-chat-premiere')).toBeNull();
    expect(screen.getByTestId('real-chat-composer').props.value).toBe('half-written thought');
    await fireEvent.press(screen.getByTestId('real-group-nav-home'));
    expect(screen.queryByTestId('real-home-card-released')).toBeNull();
    await screen.unmount();
  });

  it('reconciles on foreground return, including a clock that did not tick in the background', async () => {
    const screen = await open();
    expect(shutter(screen)).toMatch(/are used/);
    const groupReads = calls('/real/groups/current');
    const ledgerReads = ledgerCalls();

    await emitAppState('active');
    expect(calls('/real/groups/current')).toBe(groupReads);

    await emitAppState('background');
    // Timers are throttled while hidden: the clock moves past the reset without firing any.
    jest.setSystemTime(RESET + 60_000);
    server.countUsed = 0;
    server.secondsUsed = 0;
    await emitAppState('active');

    expect(calls('/real/groups/current')).toBe(groupReads + 1);
    expect(ledgerCalls()).toBe(ledgerReads + 1);
    expect(shutter(screen)).toBe('Add a moment · 5 of 5 left');
    await screen.unmount();
  });

  it('ignores a delayed refresh for the group the user switched away from', async () => {
    const other: Group = {
      ...owner,
      group: { ...owner.group, id: 'real-group-2', name: 'Garden circle' },
      cycle: { ...owner.cycle, id: 'real-cycle-9', prompt: 'Garden prompt' },
    };
    server.groups = [owner, other];
    const screen = await open();
    await waitFor(() => expect(screen.getByTestId('real-group-menu-button')).toBeTruthy());

    let release!: () => void;
    server.gates.push(new Promise<void>((resolve) => (release = resolve)));
    server.group = {
      ...owner,
      cycle: { ...owner.cycle, prompt: 'Stale prompt for the old group' },
    };
    await emitAppState('background');
    await emitAppState('active');

    await fireEvent.press(screen.getByTestId('real-group-menu-button'));
    await fireEvent.press(screen.getByTestId('switch-real-group-real-group-2'));
    await waitFor(() =>
      expect(screen.getByTestId('real-group-name-heading').props.children).toBe('Garden circle'),
    );

    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('real-group-name-heading').props.children).toBe('Garden circle');
    expect(screen.getByTestId('real-group-cycle-prompt').props.children).toBe('Garden prompt');
    await screen.unmount();
  });

  it('keeps the newest of overlapping refreshes when an older one answers last', async () => {
    const screen = await open();
    let releaseOld!: () => void;
    server.gates.push(new Promise<void>((resolve) => (releaseOld = resolve)));
    server.group = { ...owner, cycle: { ...owner.cycle, prompt: 'Old answer' } };
    await emitAppState('background');
    await emitAppState('active');

    // The boundary request is newer and answers first.
    server.group = { ...owner, cycle: { ...owner.cycle, prompt: 'New answer' } };
    server.countUsed = 0;
    server.secondsUsed = 0;
    await toBoundary();
    expect(screen.getByTestId('real-group-cycle-prompt').props.children).toBe('New answer');

    await act(async () => {
      releaseOld();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('real-group-cycle-prompt').props.children).toBe('New answer');
    await screen.unmount();
  });

  it('keeps the last confirmed allowance on a failed refresh and retries only on request', async () => {
    const screen = await open();
    expect(shutter(screen)).toMatch(/are used/);

    server.failCurrent = true;
    server.failLedger = true;
    await toBoundary();
    expect(await screen.findByTestId('real-group-refresh-error')).toBeTruthy();
    // Null would read as "ready"; the exhausted shutter must stay exhausted.
    expect(shutter(screen)).toMatch(/are used/);
    expect(screen.getByTestId('real-group-allowance').props.accessibilityLabel).toContain('5 of 5');

    const groupReads = calls('/real/groups/current');
    const ledgerReads = ledgerCalls();
    await advance(20 * 60 * 1000);
    expect(calls('/real/groups/current')).toBe(groupReads);
    expect(ledgerCalls()).toBe(ledgerReads);

    server.failCurrent = false;
    server.failLedger = false;
    server.countUsed = 0;
    server.secondsUsed = 0;
    await fireEvent.press(screen.getByTestId('real-group-refresh-retry'));
    await waitFor(() => expect(screen.queryByTestId('real-group-refresh-error')).toBeNull());
    expect(shutter(screen)).toBe('Add a moment · 5 of 5 left');
    await screen.unmount();
  });

  it('leaves an open capture screen alone and reconciles when it closes', async () => {
    server.countUsed = 4;
    server.secondsUsed = 12;
    const screen = await open();
    await fireEvent.press(screen.getByTestId('real-group-capture-action'));
    await screen.findByTestId('camera-screen');
    const groupReads = calls('/real/groups/current');

    server.countUsed = 0;
    server.secondsUsed = 0;
    await toBoundary();
    expect(calls('/real/groups/current')).toBe(groupReads);
    expect(screen.getByTestId('camera-screen')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(shutter(screen)).toBe('Add a moment · 5 of 5 left'));
    expect(calls('/real/groups/current')).toBe(groupReads + 1);
    await screen.unmount();
  });

  it('keeps Settings inputs and the pushed screen through a refresh', async () => {
    const screen = await open();
    await fireEvent.press(screen.getByTestId('real-account-settings-button'));
    await fireEvent.press(await screen.findByTestId('real-settings-prompt'));
    await fireEvent.press(await screen.findByTestId('real-group-custom-prompt-choice'));
    await fireEvent.changeText(screen.getByTestId('real-group-custom-prompt'), 'My own words');

    server.group = { ...owner, cycle: { ...owner.cycle, prompt: 'Changed elsewhere' } };
    server.countUsed = 0;
    server.secondsUsed = 0;
    await toBoundary();

    expect(screen.getByTestId('real-group-custom-prompt').props.value).toBe('My own words');
    expect(screen.getByTestId('real-group-save-settings')).toBeTruthy();
    await screen.unmount();
  });

  it('returns to the empty state when the member is removed while the app is open', async () => {
    const screen = await open();
    server.group = null;
    server.groups = [];
    await emitAppState('background');
    await emitAppState('active');
    expect(await screen.findByTestId('real-group-none')).toBeTruthy();
    await screen.unmount();
  });

  it('adds a newly published film to an open Archive without losing loaded pages', async () => {
    server.group = { ...owner, releases: [olderRelease('processing')] };
    server.films = [filmBody('film-b', 'real-cycle-b')];
    server.olderFilms = [filmBody('film-a', 'real-cycle-a')];
    const screen = await open();
    await fireEvent.press(screen.getByTestId('real-group-nav-archive'));
    await screen.findByTestId('real-archive-film-film-b');
    await fireEvent.press(screen.getByTestId('real-archive-older'));
    await screen.findByTestId('real-archive-film-film-a');
    expect(screen.getByTestId('real-archive-now')).toHaveTextContent(/developing/);

    server.group = { ...owner, releases: [olderRelease('archived', '2026-10-05T01:00:00.000Z')] };
    server.films = [filmBody('film-new', 'real-cycle-0'), filmBody('film-b', 'real-cycle-b')];
    await advance(30_000);

    expect(await screen.findByTestId('real-archive-film-film-new')).toBeTruthy();
    expect(screen.getByTestId('real-archive-film-film-b')).toBeTruthy();
    expect(screen.getByTestId('real-archive-film-film-a')).toBeTruthy();
    expect(screen.queryByTestId('real-archive-now')).toBeTruthy();
    expect(screen.getByTestId('real-archive-now')).toHaveTextContent(/collecting/);
    await screen.unmount();
  });
});
