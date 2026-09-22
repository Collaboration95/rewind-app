import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import type { Cycle } from '../src/domain/cycles';
import type { LocalInvite } from '../src/domain/invites';
import type { CreateGroupInput, Group } from '../src/domain/profiles';
import { createOfflineDemoSession } from '../src/session/session-store';
import { LocalRuntimeError, type RuntimeClient } from '../src/runtime/local-runtime-client';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

const currentGroup: Group = {
  id: 'demo-group',
  name: 'Weekend People',
  memberIds: ['demo-1'],
  currentCycleId: 'demo-cycle',
  memberRoles: { 'demo-1': 'owner' },
  actingMemberRole: 'owner',
};

const createdGroup: Group = {
  id: 'created-group',
  name: 'Saturday table',
  memberIds: ['demo-1'],
  currentCycleId: 'created-cycle',
  memberRoles: { 'demo-1': 'owner' },
  actingMemberRole: 'owner',
};

const joinedGroup: Group = {
  id: 'joined-group',
  name: 'Other People',
  memberIds: ['demo-1'],
  currentCycleId: 'joined-cycle',
  memberRoles: { 'demo-1': 'member' },
  actingMemberRole: 'member',
};

const session = createOfflineDemoSession(
  'demo-1',
  'Amber',
  currentGroup.id,
  new Date('2026-09-01T00:00:00.000Z'),
);

const cycle: Cycle = {
  id: currentGroup.currentCycleId,
  groupId: currentGroup.id,
  prompt: 'What made you pause and smile?',
  startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: '2026-09-02T00:00:00.000Z',
  status: 'collecting',
  lockState: 'locked',
  quota: { maxCount: 5, maxSeconds: 30 },
  contributionUsage: { countUsed: 0, secondsUsed: 0 },
};

const activeInvite: LocalInvite = {
  id: 'invite-1',
  groupId: joinedGroup.id,
  code: 'AB12CD34',
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-09-02T00:00:00.000Z',
  usedAt: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function runtimeFixture(
  overrides: Partial<RuntimeClient> = {},
  groupState: { id: string } = { id: currentGroup.id },
): RuntimeClient {
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
    getGroupForMember: async () => {
      if (groupState.id === createdGroup.id) return createdGroup;
      if (groupState.id === joinedGroup.id) return joinedGroup;
      return currentGroup;
    },
    getCurrentCycle: async () => cycle,
    advanceDemoCycle: async () => ({ kind: 'RecoverableFailure' }),
    createDemoSession: async () => session,
    ...overrides,
  };
}

async function activeApp(runtimeClient: RuntimeClient) {
  const result = await render(<App runtimeClient={runtimeClient} />);
  await result.findByRole('header', { name: currentGroup.name });
  return result;
}

function acceptedInvite() {
  return {
    invite: { ...activeInvite, status: 'used' as const, usedAt: '2026-09-01T00:01:00.000Z' },
    group: joinedGroup,
    session: { ...session, groupId: joinedGroup.id },
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('group creation and invite failure paths', () => {
  it('validates group input before invoking the runtime or writing a group', async () => {
    const createGroup = jest.fn<Promise<{ ok: true; group: Group }>, [string, CreateGroupInput]>();
    const result = await activeApp(runtimeFixture({ createGroup }));

    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.press(result.getByRole('button', { name: 'Create a local group' }));
    await fireEvent.changeText(result.getByTestId('group-name-input'), '   ');
    await fireEvent.press(result.getByTestId('create-group-submit'));

    expect(result.getByText('Enter a group name.')).toBeTruthy();
    expect(createGroup).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem('rewind.local-demo.groups.v1')).toBeNull();
  });

  it('keeps creation pending and prevents duplicate submissions until a delayed call succeeds', async () => {
    const request = deferred<{ ok: true; group: Group }>();
    const groupState = { id: currentGroup.id };
    const createGroup = jest.fn().mockImplementation(() => {
      groupState.id = createdGroup.id;
      return request.promise;
    });
    const result = await activeApp(runtimeFixture({ createGroup }, groupState));

    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.press(result.getByRole('button', { name: 'Create a local group' }));
    await fireEvent.changeText(result.getByTestId('group-name-input'), createdGroup.name);
    await fireEvent.press(result.getByTestId('create-group-submit'));
    await fireEvent.press(result.getByTestId('create-group-submit'));

    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(result.getByTestId('create-group-submit').props.accessibilityState?.disabled).toBe(true);
    expect(result.getByText('Creating group…')).toBeTruthy();

    request.resolve({ ok: true, group: createdGroup });
    await result.findByRole('header', { name: createdGroup.name });
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(result.getByText('Current member: Amber')).toBeTruthy();
  });

  it('retries a rejected group creation deterministically and navigates after the single success', async () => {
    const groupState = { id: currentGroup.id };
    const createGroup = jest
      .fn()
      .mockRejectedValueOnce(new LocalRuntimeError('The group service is temporarily unavailable.'))
      .mockImplementationOnce(() => {
        groupState.id = createdGroup.id;
        return Promise.resolve({ ok: true, group: createdGroup });
      });
    const result = await activeApp(runtimeFixture({ createGroup }, groupState));

    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.press(result.getByRole('button', { name: 'Create a local group' }));
    await fireEvent.changeText(result.getByTestId('group-name-input'), createdGroup.name);
    await fireEvent.press(result.getByTestId('create-group-submit'));

    await waitFor(() =>
      expect(result.getByText('The group service is temporarily unavailable.')).toBeTruthy(),
    );
    expect(result.getByTestId('create-group-submit').props.accessibilityState?.disabled).toBe(
      false,
    );

    await fireEvent.press(result.getByTestId('create-group-submit'));
    await result.findByRole('header', { name: createdGroup.name });
    expect(createGroup).toHaveBeenCalledTimes(2);
    expect(createGroup.mock.calls[0]).toEqual([
      session.id,
      { name: createdGroup.name, prompt: cycle.prompt },
    ]);
    expect(createGroup.mock.calls[1]).toEqual([
      session.id,
      { name: createdGroup.name, prompt: cycle.prompt },
    ]);
  });

  it.each([
    ['duplicate', new LocalRuntimeError('This invitation has already been used.', 409)],
    ['expired', new LocalRuntimeError('This invitation has expired.', 410)],
  ])('surfaces a %s invite failure without changing the current group', async (_label, error) => {
    const acceptInvite = jest.fn().mockRejectedValue(error);
    const result = await activeApp(runtimeFixture({ acceptInvite }));

    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.changeText(result.getByTestId('invite-code-input'), activeInvite.code);
    await fireEvent.press(result.getByTestId('accept-invite'));

    await waitFor(() => expect(result.getByText(error.message)).toBeTruthy());
    expect(acceptInvite).toHaveBeenCalledTimes(1);
    expect(result.getByTestId('accept-invite').props.accessibilityState?.disabled).toBe(false);
    expect(result.getByText(`Weekend People`)).toBeTruthy();
    expect(result.queryByText(`Joined ${joinedGroup.name}. The code is now used.`)).toBeNull();
  });

  it('prevents duplicate invite acceptance while a runtime call is delayed, then navigates the session to the joined group', async () => {
    const request = deferred<ReturnType<typeof acceptedInvite>>();
    const groupState = { id: currentGroup.id };
    const acceptInvite = jest.fn().mockImplementation(() => {
      groupState.id = joinedGroup.id;
      return request.promise;
    });
    const result = await activeApp(runtimeFixture({ acceptInvite }, groupState));

    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.changeText(result.getByTestId('invite-code-input'), ` ab12 cd34 `);
    await fireEvent.press(result.getByTestId('accept-invite'));
    await fireEvent.press(result.getByTestId('accept-invite'));

    expect(acceptInvite).toHaveBeenCalledTimes(1);
    expect(acceptInvite).toHaveBeenCalledWith(session.id, activeInvite.code);
    expect(result.getByTestId('accept-invite').props.accessibilityState?.disabled).toBe(true);

    request.resolve(acceptedInvite());
    await waitFor(() =>
      expect(result.getByText(`Joined ${joinedGroup.name}. The code is now used.`)).toBeTruthy(),
    );
    expect(result.getByText(joinedGroup.name)).toBeTruthy();
    expect(result.getByTestId('accept-invite').props.accessibilityState?.disabled).toBe(true);
  });

  it('retries a rejected invite with the same normalized code and accepts it once', async () => {
    const groupState = { id: currentGroup.id };
    const acceptInvite = jest
      .fn()
      .mockRejectedValueOnce(new LocalRuntimeError('This invitation is temporarily unavailable.'))
      .mockImplementationOnce(() => {
        groupState.id = joinedGroup.id;
        return Promise.resolve(acceptedInvite());
      });
    const result = await activeApp(runtimeFixture({ acceptInvite }, groupState));

    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.changeText(result.getByTestId('invite-code-input'), ' ab12 cd34 ');
    await fireEvent.press(result.getByTestId('accept-invite'));
    await waitFor(() =>
      expect(result.getByText('This invitation is temporarily unavailable.')).toBeTruthy(),
    );
    expect(result.getByTestId('invite-code-input').props.value).toBe(activeInvite.code);
    expect(result.getByTestId('accept-invite').props.accessibilityState?.disabled).toBe(false);

    await fireEvent.press(result.getByTestId('accept-invite'));
    await waitFor(() =>
      expect(result.getByText(`Joined ${joinedGroup.name}. The code is now used.`)).toBeTruthy(),
    );
    expect(acceptInvite).toHaveBeenCalledTimes(2);
    expect(acceptInvite.mock.calls).toEqual([
      [session.id, activeInvite.code],
      [session.id, activeInvite.code],
    ]);
  });
});
