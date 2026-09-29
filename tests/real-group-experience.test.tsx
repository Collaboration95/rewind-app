import { fireEvent, render } from '@testing-library/react-native';

import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountGroupExperience } from '../src/groups/RealAccountGroupExperience';

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
  it('creates from the first-run choice and restores persisted group Home after remount', async () => {
    let saved: typeof persistedGroup | null = null;
    const authenticatedRequest = jest.fn(async (path: string, init?: RequestInit) => {
      if (path === '/real/groups/current') return jsonResponse({ group: saved });
      if (path === '/real/groups' && init?.method !== 'POST')
        return jsonResponse({ groups: saved ? [saved] : [] });
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
      true,
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
    expect(first.getByTestId('real-group-empty-contributions')).toBeTruthy();
    expect(first.queryByText('LOCKED')).toBeNull();
    await fireEvent.press(first.getByTestId('real-group-capture-action'));
    await first.findByTestId('video-capture-screen');
    expect(first.getByText('Record a contribution')).toBeTruthy();
    expect(first.queryByTestId('real-group-capture-unavailable')).toBeNull();

    first.unmount();
    const restored = await render(<RealAccountGroupExperience displayName="Real Owner" />);
    await restored.findByTestId('real-group-home');
    expect(restored.getByTestId('real-group-name-heading').props.children).toBe('Saturday table');
    expect(authenticatedRequest).toHaveBeenCalledWith('/real/groups/current');
  });
});
