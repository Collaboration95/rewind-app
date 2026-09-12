import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import type { Cycle } from '../src/domain/cycles';
import type { Group } from '../src/domain/profiles';
import type { LocalInvite } from '../src/domain/invites';
import type { RuntimeClient } from '../src/runtime/local-runtime-client';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

beforeEach(async () => {
  await AsyncStorage.clear();
});

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
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2026-01-02T00:00:00.000Z',
  status: 'collecting',
  lockState: 'locked',
  quota: { maxCount: 5, maxSeconds: 30 },
  contributionUsage: { countUsed: 0, secondsUsed: 0 },
};

const invite: LocalInvite = {
  id: 'invite-1',
  groupId: group.id,
  code: 'AB12CD34',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  usedAt: null,
};

function inviteRuntime(): RuntimeClient {
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
    createInvite: jest.fn().mockResolvedValue(invite),
  };
}

function restoreFailureRuntime(): RuntimeClient {
  return {
    ...inviteRuntime(),
    createDemoSession: jest.fn().mockRejectedValue(new Error('Runtime unavailable')),
  };
}

describe('native accessibility panels', () => {
  it('does not group the Demo access recovery action with its error message', async () => {
    const result = await render(<App runtimeClient={restoreFailureRuntime()} />);

    await result.findByText('Runtime unavailable');
    expect(result.getByTestId('demo-access-error').props.accessible).toBe(false);
    expect(result.getByRole('button', { name: 'Retry Demo access' })).toBeTruthy();
  });

  it('does not group capsule recovery with the Retry action', async () => {
    const result = await render(
      <App
        cycleRepository={{
          getCurrentCycle: jest.fn().mockResolvedValue({ kind: 'RecoverableFailure' }),
        }}
      />,
    );

    const panel = await result.findByTestId('capsule-error');
    expect(panel.props.accessible).toBe(false);
    expect(result.getByRole('button', { name: 'Retry loading capsule' })).toBeTruthy();
  });

  it('keeps invite actions as separate native accessibility elements', async () => {
    const result = await render(<App runtimeClient={inviteRuntime()} />);
    await result.findByText('Current member: Amber');
    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));

    const panel = result.getByTestId('settings-invites');
    expect(panel.props.accessible).toBe(false);
    expect(result.getByRole('button', { name: 'Generate invite code' })).toBeTruthy();
    expect(result.getByRole('button', { name: 'Accept invitation', disabled: true })).toBeTruthy();

    await fireEvent.press(result.getByRole('button', { name: 'Generate invite code' }));
    await result.findByText(invite.code);
    expect(result.getByRole('button', { name: 'Copy invite code' })).toBeTruthy();
  });
});
