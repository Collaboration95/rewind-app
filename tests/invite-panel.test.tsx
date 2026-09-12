import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import type { Cycle } from '../src/domain/cycles';
import type { Group } from '../src/domain/profiles';
import type { LocalInvite } from '../src/domain/invites';
import { createOfflineDemoSession } from '../src/session/session-store';
import type { RuntimeClient } from '../src/runtime/local-runtime-client';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

beforeEach(async () => {
  await AsyncStorage.clear();
});

const currentGroup: Group = {
  id: 'demo-group',
  name: 'Weekend People',
  memberIds: ['demo-1'],
  currentCycleId: 'demo-cycle',
  memberRoles: { 'demo-1': 'owner' },
  actingMemberRole: 'owner',
};

const joinedGroup: Group = {
  id: 'other-group',
  name: 'Other People',
  memberIds: ['demo-1'],
  currentCycleId: 'other-cycle',
  memberRoles: { 'demo-1': 'member' },
  actingMemberRole: 'member',
};

const cycle: Cycle = {
  id: 'demo-cycle',
  groupId: currentGroup.id,
  prompt: 'What made you pause and smile?',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2026-01-02T00:00:00.000Z',
  status: 'collecting',
  lockState: 'locked',
  quota: { maxCount: 5, maxSeconds: 30 },
  contributionUsage: { countUsed: 0, secondsUsed: 0 },
};

const invite: LocalInvite = {
  id: 'invite-1',
  groupId: joinedGroup.id,
  code: 'AB12CD34',
  status: 'used',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  usedAt: '2026-01-01T00:01:00.000Z',
};

function inviteRuntime() {
  const session = createOfflineDemoSession(
    'demo-1',
    'Amber',
    currentGroup.id,
    new Date('2026-01-01T00:00:00.000Z'),
  );
  const acceptInvite = jest.fn().mockResolvedValue({
    invite,
    group: joinedGroup,
    session: { ...session, groupId: joinedGroup.id },
  });
  const runtime: RuntimeClient = {
    baseUrl: 'http://runtime.test',
    getHealth: async () => ({
      ok: true,
      service: 'rewind-local-runtime',
      version: 'test',
      ready: true,
      checks: { sqlite: true, ffmpegConfigured: false },
      addresses: { local: 'http://runtime.test', lan: null },
    }),
    getGroupForMember: async (_memberId, preferredGroupId) =>
      preferredGroupId === joinedGroup.id ? joinedGroup : currentGroup,
    getCurrentCycle: async () => cycle,
    advanceDemoCycle: async () => ({ kind: 'RecoverableFailure' }),
    createDemoSession: async () => session,
    acceptInvite,
  };
  return { acceptInvite, runtime, session };
}

describe('local invite panel', () => {
  it('validates malformed codes before calling the runtime and accepts normalized cross-group codes', async () => {
    const { acceptInvite, runtime, session } = inviteRuntime();
    const result = await render(<App runtimeClient={runtime} />);
    await result.findByText('Current member: Amber');
    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));

    const input = result.getByTestId('invite-code-input');
    await fireEvent.changeText(input, 'bad');
    await fireEvent.press(result.getByTestId('accept-invite'));
    expect(acceptInvite).not.toHaveBeenCalled();
    expect(result.getByTestId('invite-code-error')).toBeTruthy();
    expect(input.props['aria-invalid']).toBe(true);

    await fireEvent.changeText(input, ' ab12 cd34 ');
    await fireEvent.press(result.getByTestId('accept-invite'));
    await waitFor(() => expect(acceptInvite).toHaveBeenCalledWith(session.id, 'AB12CD34'));
    expect(acceptInvite.mock.calls[0]).toHaveLength(2);
  });
});
