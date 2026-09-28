import { fireEvent, render } from '@testing-library/react-native';

import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountGroupExperience } from '../src/groups/RealAccountGroupExperience';

jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ownerGroup = {
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
    if (path === `/real/groups/${ownerGroup.group.id}/members`)
      return jsonResponse({
        group: { id: ownerGroup.group.id, name: ownerGroup.group.name },
        members: [
          { displayName: 'Ada Owner', role: 'owner', joinedAt: '2026-09-28T00:00:00.000Z' },
          { displayName: 'Bea Member', role: 'member', joinedAt: '2026-09-28T00:01:00.000Z' },
        ],
        pendingInviteCount: 1,
      });
    if (path === `/real/groups/${joinedGroup.group.id}/members`)
      return jsonResponse({
        group: { id: joinedGroup.group.id, name: joinedGroup.group.name },
        members: [
          { displayName: 'Cy Owner', role: 'owner', joinedAt: '2026-09-28T00:00:00.000Z' },
          { displayName: 'Dee Member', role: 'member', joinedAt: '2026-09-28T00:02:00.000Z' },
        ],
        pendingInviteCount: 0,
      });
    throw new Error(`Unexpected authenticated request: ${path}`);
  });
  (useRealAccount as jest.Mock).mockReturnValue({ authenticatedRequest, signOut: jest.fn() });

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
  await fireEvent.press(screen.getByTestId('real-group-capture-action'));
  expect(screen.getByTestId('real-group-capture-context').props.children).toEqual([
    'ACTIVE GROUP · ',
    'Garden circle',
  ]);
  screen.unmount();
});
