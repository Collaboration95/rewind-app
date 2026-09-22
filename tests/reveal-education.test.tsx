import { fireEvent, render } from '@testing-library/react-native';

import { RevealEducationPanel } from '../src/capsule/RevealEducationPanel';
import {
  getRevealEducationCopy,
  revealStateForCycle,
  revealStateForPremiere,
} from '../src/domain/reveal-education';
import type { Cycle } from '../src/domain/cycles';

const cycle: Cycle = {
  id: 'cycle-1',
  groupId: 'group-1',
  prompt: 'Prompt',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2026-01-02T00:00:00.000Z',
  status: 'collecting',
  lockState: 'locked',
  quota: { maxCount: 5, maxSeconds: 30 },
  contributionUsage: { countUsed: 0, secondsUsed: 0 },
};

describe('reveal education', () => {
  it.each([
    ['locked', 'Add a moment'],
    ['delayed', 'Open Archive'],
    ['released', 'Open Archive'],
  ] as const)('gives Home one honest %s next action', async (state, actionLabel) => {
    const onAction = jest.fn();
    const result = await render(
      <RevealEducationPanel
        onAction={onAction}
        state={state}
        surface="home"
        testID={`home-reveal-${state}`}
      />,
    );
    const panel = await result.findByTestId(`home-reveal-${state}`);
    expect(panel.props.accessible).toBe(false);
    expect(result.getByRole('button', { name: actionLabel })).toBeTruthy();
    fireEvent.press(result.getByRole('button', { name: actionLabel }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(
      result.getByLabelText(new RegExp(getRevealEducationCopy('home', state).title)),
    ).toBeTruthy();
  });

  it('maps cycle and premiere lifecycle states consistently', () => {
    expect(revealStateForCycle(cycle)).toBe('locked');
    expect(revealStateForCycle({ ...cycle, status: 'revealing' })).toBe('processing');
    expect(revealStateForCycle({ ...cycle, lockState: 'unlocked', status: 'archived' })).toBe(
      'released',
    );
    expect(revealStateForPremiere({ state: 'locked', cycleId: 'cycle-1' })).toBe('locked');
    expect(revealStateForPremiere({ state: 'processing', cycleId: 'cycle-1' })).toBe('processing');
    expect(revealStateForPremiere({ state: 'delayed', cycleId: 'cycle-1' })).toBe('delayed');
    expect(
      revealStateForPremiere({
        state: 'ready',
        cycleId: 'cycle-1',
        filmId: 'film-1',
        playbackUrl: 'https://example.test/film.mp4',
      }),
    ).toBe('released');
  });
});
