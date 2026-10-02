import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { useRealAccount } from '../src/auth/RealAccountProvider';
import {
  photoContributionStatusForJob,
  RealAccountGroupExperience,
} from '../src/groups/RealAccountGroupExperience';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

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
    await result.findByTestId('real-group-open-archive');
    expect(result.getByTestId('real-group-cycle-prompt').props.children).toBe(
      persistedGroup.cycle.prompt,
    );
    expect(result.getByTestId('real-group-release-real-cycle-older').props.children).toContain(
      'Film processing',
    );
    expect(result.queryByTestId(`real-group-release-${persistedGroup.cycle.id}`)).toBeNull();

    await fireEvent.press(result.getByTestId('real-group-open-archive'));
    await result.findByTestId('archive-empty-films');
    expect(authenticatedRequest).toHaveBeenCalledWith('/archive?groupId=real-group-1&limit=50');
    expect(authenticatedRequest).toHaveBeenCalledWith(
      '/cycles/real-cycle-1/premiere?groupId=real-group-1',
    );
    await fireEvent.press(result.getByText('Back to group'));
    await result.findByTestId('real-group-home');
    result.unmount();
  });

  it('joins an invited group with a six-letter code without a group ID', async () => {
    let joined = false;
    const authenticatedRequest = jest.fn(async (path: string, init?: RequestInit) => {
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
    await result.findByTestId('real-group-enter-code');
    await fireEvent.changeText(result.getByTestId('real-group-enter-code'), 'abc-def');
    await fireEvent.press(result.getByTestId('real-group-join-choice'));
    await result.findByTestId('real-group-home');
    expect(joined).toBe(true);
    expect(result.getByTestId('real-group-name-heading').props.children).toBe('Saturday table');
    result.unmount();
  });

  it('refreshes both Home allowance displays from the ledger when returning from capture', async () => {
    const activeGroup = { ...persistedGroup, memberId: 'real-member-1' };
    let ledgerRead = 0;
    const authenticatedRequest = jest.fn(async (path: string) => {
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
      expect(result.getByTestId('real-group-allowance').props.children).toContain('1 of 5'),
    );
    expect(result.getByText(/1 of 5 contributions and 3 seconds of 30 seconds used/)).toBeTruthy();

    await fireEvent.press(result.getByTestId('real-group-capture-action'));
    await result.findByTestId('camera-screen');
    await fireEvent.press(result.getByText('Back to group'));

    await waitFor(() => expect(ledgerRead).toBeGreaterThanOrEqual(3));
    await waitFor(() =>
      expect(result.getByTestId('real-group-allowance').props.children).toContain('3 of 5'),
    );
    expect(result.getByText(/3 of 5 contributions and 9 seconds of 30 seconds used/)).toBeTruthy();
    expect(result.getByTestId('real-group-allowance').props.children).toContain('9 of 30 seconds');
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
      throw new Error(`Unexpected authenticated request: ${path}`);
    });
    (useRealAccount as jest.Mock).mockReturnValue({ authenticatedRequest, signOut: jest.fn() });

    const first = await render(<RealAccountGroupExperience displayName="Real Owner" />);
    await first.findByTestId('real-group-create-choice');
    expect(first.getByTestId('real-group-join-choice').props.accessibilityState?.disabled).toBe(
      false,
    );
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
    await first.findByTestId('real-group-member-0');
    expect(first.getByTestId('real-group-empty-contributions')).toBeTruthy();
    expect(first.getByTestId('real-group-active-context').props.children).toBe('Your group');
    expect(first.getByTestId('real-group-name-heading').props.children).toBe('Saturday table');
    expect(first.getByTestId('real-group-member-0').props.children).toEqual([
      'Real Owner',
      ' · ',
      'Owner',
    ]);
    expect(first.queryByText('LOCKED')).toBeNull();
    await fireEvent.press(first.getByTestId('real-group-capture-action'));
    expect(first.getByTestId('camera-screen')).toBeTruthy();
    await fireEvent.press(first.getByTestId('camera-record-clip'));
    await first.findByTestId('video-capture-screen');
    expect(first.getByText('Record a contribution')).toBeTruthy();
    expect(first.queryByTestId('real-group-capture-unavailable')).toBeNull();

    first.unmount();
    const restored = await render(<RealAccountGroupExperience displayName="Real Owner" />);
    await restored.findByTestId('real-group-home');
    expect(restored.getByTestId('real-group-name-heading').props.children).toBe('Saturday table');
    expect(authenticatedRequest).toHaveBeenCalledWith('/real/groups/current');
    restored.unmount();
  });
});
