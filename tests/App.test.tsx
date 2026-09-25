import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import type { Cycle, CycleRepository } from '../src/domain/cycles';
import type { ContributionLedgerPage } from '../src/domain/contributions';
import { SELECTION_KEY } from '../src/data/selection-store';
import type { SelectionStore } from '../src/domain/profiles';
import { DemoProfilePicker } from '../src/profiles/DemoProfilePicker';
import { DemoProfileProvider } from '../src/profiles/DemoProfileProvider';
import { DemoCameraPlatform } from '../src/capture/platform';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockStatusBar = jest.fn((_props: { style?: string }) => null);

jest.mock('expo-status-bar', () => ({
  StatusBar: (props: { style?: string }) => mockStatusBar(props),
}));

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

beforeEach(async () => {
  await AsyncStorage.clear();
  mockStatusBar.mockClear();
});

function picker(store: SelectionStore) {
  return render(
    <DemoProfileProvider store={store}>
      <DemoProfilePicker />
    </DemoProfileProvider>,
  );
}

const TEST_NOW = Date.parse('2026-01-01T00:00:00.000Z');

function cycleFixture(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: 'demo-cycle',
    groupId: 'demo-group',
    prompt: 'What made you pause and smile?',
    startsAt: new Date(TEST_NOW - 60_000).toISOString(),
    endsAt: new Date(TEST_NOW + 2 * 60 * 60 * 1000).toISOString(),
    status: 'collecting',
    lockState: 'locked',
    quota: { maxCount: 5, maxSeconds: 30 },
    contributionUsage: { countUsed: 0, secondsUsed: 0 },
    ...overrides,
  };
}

function cycleRepository(
  result: Cycle | { kind: 'NotFound' | 'RecoverableFailure' },
): CycleRepository {
  return {
    getCurrentCycle: jest.fn().mockResolvedValue(result),
  };
}

function runtimeClientWithPremiere(
  premiere:
    | { state: 'locked' | 'processing' | 'delayed'; cycleId: string }
    | {
        state: 'ready';
        cycleId: string;
        filmId: string;
        playbackUrl: string;
      },
) {
  return {
    baseUrl: 'http://localhost:8787',
    getHealth: jest.fn().mockResolvedValue({
      ok: true,
      service: 'rewind-local-runtime',
      version: '0.1.0',
      ready: true,
      checks: { sqlite: true, ffmpegConfigured: true },
      addresses: { local: 'http://localhost:8787', lan: null },
    }),
    getGroupForMember: jest.fn().mockResolvedValue({
      id: 'demo-group',
      name: 'Weekend People',
      memberIds: ['demo-1'],
      currentCycleId: 'demo-cycle',
      actingMemberRole: 'owner',
    }),
    getCurrentCycle: jest.fn().mockResolvedValue(cycleFixture({ status: 'revealing' })),
    advanceDemoCycle: jest.fn().mockResolvedValue({
      id: 'demo-cycle',
      groupId: 'demo-group',
      prompt: 'Prompt',
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-09-12T00:00:00.000Z',
      status: 'collecting',
      lockState: 'locked',
      quota: { maxCount: 5, maxSeconds: 30 },
      contributionUsage: { countUsed: 0, secondsUsed: 0 },
    }),
    revealDemoCycle: jest
      .fn()
      .mockResolvedValue({ state: 'compiling', cycleId: 'demo-cycle', jobId: 'demo-film' }),
    getPremiere: jest.fn().mockResolvedValue(premiere),
    getReleasedArchive: jest.fn().mockResolvedValue({ films: [], clips: [] }),
    getCycleHistory: jest.fn().mockResolvedValue([
      {
        id: 'demo-cycle',
        prompt: 'What made you pause and smile?',
        startsAt: '2026-09-01T00:00:00.000Z',
        endsAt: '2026-09-12T00:00:00.000Z',
        status: 'collecting',
        releaseStatus: 'unpublished',
      },
      {
        id: 'revealing-cycle',
        prompt: 'The revealing prompt',
        startsAt: '2026-08-20T00:00:00.000Z',
        endsAt: '2026-08-27T00:00:00.000Z',
        status: 'revealing',
        releaseStatus: 'unpublished',
      },
      {
        id: 'locked-archived-cycle',
        prompt: 'The sealed archived prompt',
        startsAt: '2026-08-10T00:00:00.000Z',
        endsAt: '2026-08-17T00:00:00.000Z',
        status: 'archived',
        releaseStatus: 'unpublished',
      },
      {
        id: 'old-cycle',
        prompt: 'The archived prompt',
        startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-08-08T00:00:00.000Z',
        status: 'archived',
        releaseStatus: 'published',
      },
    ]),
  };
}

describe('Rewind Home start screen', () => {
  it('keeps the application inside the device safe area', async () => {
    const result = await render(<App />);

    expect(result.getByTestId('application-safe-area')).toBeTruthy();
  });

  it('uses a light status bar on the dark application shell', async () => {
    await render(<App />);

    expect(mockStatusBar).toHaveBeenCalledWith({ style: 'light' });
  });

  it('shows the sample group, local-demo capsule summary, and profile picker', async () => {
    const result = await render(<App />);

    expect(result.getByRole('header', { name: 'Weekend People' })).toBeTruthy();
    expect(result.getByLabelText('Local demo data')).toBeTruthy();
    expect(result.getByRole('header', { name: 'Local demo' })).toBeTruthy();
    expect(result.getByLabelText('Current capsule. 2 days remaining.')).toBeTruthy();
    expect(result.getByLabelText('Current prompt: What made you pause and smile?')).toBeTruthy();
    expect(result.getByLabelText(/0 of 5 contributions used/)).toBeTruthy();
    await result.findByText('Current member: Amber');
  });

  it('mounts the signed-in contribution ledger on Home and refreshes it on return', async () => {
    const ledger: ContributionLedgerPage = {
      cycleId: 'demo-cycle',
      memberId: 'demo-1',
      allowance: {
        maxCount: 5,
        maxSeconds: 30,
        countUsed: 1,
        secondsUsed: 4,
        deletionsUsed: 0,
        deletionAvailability: 'available',
      },
      entries: [
        {
          contributionId: 'contribution-1',
          jobId: 'clip-job-1',
          state: 'sealed',
          durationSeconds: 4,
          createdAt: '2026-09-10T12:00:00.000Z',
          updatedAt: '2026-09-10T12:01:00.000Z',
          attempts: 1,
          progress: 100,
          failureCategory: null,
          retryable: false,
          replaced: false,
          restored: null,
        },
      ],
      pagination: { limit: 50, hasMore: false, nextCursor: null },
    };
    const client = {
      ...runtimeClientWithPremiere({ state: 'locked', cycleId: 'demo-cycle' }),
      getContributionLedger: jest.fn().mockResolvedValue(ledger),
    };
    const result = await render(<App runtimeClient={client} />);
    await result.findByText('Reference contribution-1');
    expect(client.getContributionLedger).toHaveBeenCalledWith(expect.any(String), 'demo-group');
    await fireEvent.press(result.getByRole('tab', { name: 'Camera' }));
    expect(result.queryByTestId('contribution-ledger-ready')).toBeNull();
    await fireEvent.press(result.getByRole('tab', { name: 'Home' }));
    await waitFor(() => expect(client.getContributionLedger).toHaveBeenCalledTimes(2));
  });

  it('starts on Home and makes every main area reachable', async () => {
    const result = await render(<App />);

    expect(result.getByRole('header', { name: 'Weekend People' })).toBeTruthy();

    for (const area of [
      { key: 'camera', label: 'Camera' },
      { key: 'chat', label: 'Chat' },
      { key: 'archive', label: 'Archive' },
    ]) {
      await fireEvent.press(result.getByTestId(`nav-${area.key}`));

      if (area.key === 'camera') {
        expect(await result.findByRole('header', { name: 'Add a still moment' })).toBeTruthy();
      } else if (area.key === 'archive') {
        expect(await result.findByRole('header', { name: 'Premiere unavailable' })).toBeTruthy();
      } else {
        expect(result.getByRole('header', { name: area.label })).toBeTruthy();
      }
    }
  });

  it('provides named tabs with a visible and accessible selected state', async () => {
    const result = await render(<App />);

    expect(result.getByRole('tab', { name: 'Home', selected: true })).toBeTruthy();
    expect(result.getByText('SELECTED')).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Chat' }));

    expect(result.getByRole('tab', { name: 'Chat', selected: true })).toBeTruthy();
    expect(result.getAllByText('SELECTED')).toHaveLength(1);
  });

  it('uses an honest permission state for Camera and unavailable states elsewhere', async () => {
    const result = await render(<App />);

    await fireEvent.press(result.getByRole('tab', { name: 'Camera' }));
    expect(await result.findByTestId('camera-temporarily-unavailable')).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Chat' }));
    expect(result.getByRole('header', { name: 'Chat' })).toBeTruthy();
    expect(await result.findByTestId('chat-unavailable')).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Archive' }));
    expect(await result.findByTestId('archive-unavailable')).toBeTruthy();
  });

  it('renders a player only for a server-published premiere', async () => {
    const client = runtimeClientWithPremiere({
      state: 'ready',
      cycleId: 'demo-cycle',
      filmId: 'demo-film',
      playbackUrl: 'http://localhost:8787/films/demo-film/play?sessionId=demo',
    });
    client.getCycleHistory.mockResolvedValue([
      {
        id: 'demo-cycle',
        prompt: 'What made you pause and smile?',
        startsAt: '2026-09-01T00:00:00.000Z',
        endsAt: '2026-09-12T00:00:00.000Z',
        status: 'revealing',
        releaseStatus: 'published',
      },
    ]);
    const result = await render(<App runtimeClient={client} />);
    await result.findByTestId('capsule-ready');
    await fireEvent.press(result.getByRole('tab', { name: 'Archive' }));
    expect(await result.findByTestId('archive-video-player')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Play group film' })).toBeTruthy();
    expect(result.queryByTestId('archive-locked')).toBeNull();
  });

  it('keeps a ready premiere locked unless cycle history confirms publication', async () => {
    const playbackUrl = 'http://localhost:8787/films/demo-film/play?sessionId=demo';
    const client = runtimeClientWithPremiere({
      state: 'ready',
      cycleId: 'demo-cycle',
      filmId: 'demo-film',
      playbackUrl,
    });
    const result = await render(<App runtimeClient={client} />);
    await result.findByTestId('capsule-ready');
    await fireEvent.press(result.getByRole('tab', { name: 'Archive' }));
    expect(await result.findByTestId('archive-locked')).toBeTruthy();
    expect(result.queryByTestId('archive-video-player')).toBeNull();
    expect(result.queryByRole('button', { name: 'Play group film' })).toBeNull();
    expect(JSON.stringify(result.toJSON())).not.toContain(playbackUrl);
  });

  it('shows the owner-only local reveal control and keeps its lifecycle truthful', async () => {
    const runtime = runtimeClientWithPremiere({
      state: 'locked',
      cycleId: 'demo-cycle',
    });
    const result = await render(<App runtimeClient={runtime} />);
    await result.findByTestId('capsule-ready');
    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await result.findByTestId('settings-local-reveal');
    await fireEvent.press(result.getByTestId('progress-local-reveal'));
    await result.findByText(/durable film job is ready to compile/);
    expect(runtime.advanceDemoCycle).toHaveBeenCalledWith(
      'demo-group',
      'demo-1',
      24 * 60 * 60,
      expect.any(String),
    );
    expect(runtime.revealDemoCycle).toHaveBeenCalledWith(expect.any(String), 'demo-group');
    expect(result.getByRole('button', { name: 'Compile and release' })).toBeTruthy();
  });

  it('keeps the archive player absent while a premiere is locked or delayed', async () => {
    const client = runtimeClientWithPremiere({ state: 'delayed', cycleId: 'demo-cycle' });
    const result = await render(<App runtimeClient={client} />);
    await result.findByTestId('capsule-ready');
    await fireEvent.press(result.getByRole('tab', { name: 'Archive' }));
    expect(await result.findByTestId('archive-delayed')).toBeTruthy();
    expect(result.getByText('Film delayed')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Check premiere again' })).toBeTruthy();
    expect(result.queryByTestId('archive-video-player')).toBeNull();
  });

  it.each([
    {
      archiveTestId: 'archive-delayed',
      educationState: 'delayed',
      premiere: { state: 'delayed' as const, cycleId: 'demo-cycle' },
      released: false,
    },
    {
      archiveTestId: 'archive-premiere-ready',
      educationState: 'released',
      premiere: {
        state: 'ready' as const,
        cycleId: 'demo-cycle',
        filmId: 'demo-film',
        playbackUrl: 'http://localhost:8787/films/demo-film/play?sessionId=demo',
      },
      released: true,
    },
  ])(
    'drives Home and Capture $educationState education from the actual premiere route state',
    async ({ archiveTestId, educationState, premiere, released }) => {
      const client = runtimeClientWithPremiere(premiere);
      if (released) {
        client.getCycleHistory.mockResolvedValue([
          {
            id: 'demo-cycle',
            prompt: 'What made you pause and smile?',
            startsAt: '2026-09-01T00:00:00.000Z',
            endsAt: '2026-09-12T00:00:00.000Z',
            status: 'revealing',
            releaseStatus: 'published',
          },
        ]);
      }
      const result = await render(
        <App cameraPlatform={new DemoCameraPlatform()} runtimeClient={client} />,
      );

      await result.findByTestId(`home-reveal-${educationState}`);
      expect(result.getByRole('button', { name: 'Open Archive' })).toBeTruthy();
      expect(result.queryByTestId('archive-video-player')).toBeNull();
      expect(result.queryAllByRole('image')).toHaveLength(0);

      await fireEvent.press(result.getByRole('tab', { name: 'Camera' }));
      await result.findByTestId(`capture-reveal-${educationState}`);
      expect(result.getByRole('button', { name: 'Open Archive' })).toBeTruthy();
      expect(result.queryByTestId('archive-video-player')).toBeNull();

      await fireEvent.press(result.getByRole('button', { name: 'Open Archive' }));
      await result.findByTestId(archiveTestId);
      if (released) expect(result.getByTestId('archive-video-player')).toBeTruthy();
      else expect(result.queryByTestId('archive-video-player')).toBeNull();
    },
  );

  it('maps released media to cycle history and keeps locked cycles metadata only', async () => {
    const client = runtimeClientWithPremiere({ state: 'locked', cycleId: 'demo-cycle' });
    client.getReleasedArchive.mockResolvedValue({
      films: [
        {
          id: 'film-1',
          cycleId: 'old-cycle',
          publishedAt: '2026-09-18T00:00:00.000Z',
          downloadUrl: 'http://localhost:8787/films/film-1/download?sessionId=demo',
        },
        {
          id: 'locked-film',
          cycleId: 'demo-cycle',
          publishedAt: '2026-09-18T00:00:00.000Z',
          downloadUrl: 'http://localhost:8787/films/locked-film/download?sessionId=demo',
        },
        {
          id: 'locked-archived-film',
          cycleId: 'locked-archived-cycle',
          publishedAt: '2026-08-18T00:00:00.000Z',
          downloadUrl: 'http://localhost:8787/films/locked-archived-film/download?sessionId=demo',
        },
      ],
      clips: [
        {
          id: 'clip-1',
          contributionId: 'contribution-1',
          cycleId: 'old-cycle',
          createdAt: '2026-08-06T00:00:00.000Z',
          downloadUrl: 'http://localhost:8787/clips/clip-1/download?sessionId=demo',
        },
        {
          id: 'locked-clip',
          contributionId: 'locked-contribution',
          cycleId: 'demo-cycle',
          createdAt: '2026-09-06T00:00:00.000Z',
          downloadUrl: 'http://localhost:8787/clips/locked-clip/download?sessionId=demo',
        },
      ],
    });
    const result = await render(<App runtimeClient={client} />);
    await result.findByTestId('capsule-ready');
    await fireEvent.press(result.getByRole('tab', { name: 'Archive' }));
    expect(await result.findByTestId('archive-released-media')).toBeTruthy();
    expect(result.getByText('Group film')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Download released group film' })).toBeTruthy();
    expect(result.getByTestId('archive-film-cycle-film-1')).toHaveTextContent(
      'Cycle: The archived prompt',
    );
    expect(result.getByTestId('archive-clip-cycle-clip-1')).toHaveTextContent(
      'Cycle: The archived prompt',
    );
    const lockedCycle = result.getByTestId('archive-cycle-demo-cycle');
    expect(within(lockedCycle).getByText('What made you pause and smile?')).toBeTruthy();
    expect(within(lockedCycle).getByText('collecting')).toBeTruthy();
    expect(within(lockedCycle).getByText(/2026/)).toBeTruthy();
    expect(within(lockedCycle).getByTestId('archive-cycle-locked-demo-cycle')).toBeTruthy();
    expect(within(lockedCycle).queryByRole('button')).toBeNull();
    expect(within(lockedCycle).queryByRole('image')).toBeNull();
    const revealingCycle = result.getByTestId('archive-cycle-revealing-cycle');
    expect(within(revealingCycle).getByText('The revealing prompt')).toBeTruthy();
    expect(within(revealingCycle).getByText('revealing')).toBeTruthy();
    const archivedCycle = result.getByTestId('archive-cycle-old-cycle');
    expect(within(archivedCycle).getByText('The archived prompt')).toBeTruthy();
    expect(within(archivedCycle).getByText('archived')).toBeTruthy();
    const lockedArchivedCycle = result.getByTestId('archive-cycle-locked-archived-cycle');
    expect(within(lockedArchivedCycle).getByText('The sealed archived prompt')).toBeTruthy();
    expect(
      within(lockedArchivedCycle).getByTestId('archive-cycle-locked-locked-archived-cycle'),
    ).toBeTruthy();
    expect(within(lockedArchivedCycle).queryByRole('button')).toBeNull();
    expect(result.queryByTestId('archive-video-player')).toBeNull();
    expect(result.queryByRole('button', { name: /share/i })).toBeNull();
    expect(result.getAllByRole('button', { name: /download/i })).toHaveLength(2);
    expect(result.queryByTestId('archive-film-cycle-locked-film')).toBeNull();
    expect(result.queryByTestId('archive-film-cycle-locked-archived-film')).toBeNull();
    expect(result.queryByTestId('archive-clip-cycle-locked-clip')).toBeNull();
  });

  it('keeps sample moments sealed and routes Add a moment to Camera', async () => {
    const result = await render(<App />);

    expect(result.getByLabelText('Locked demo moment 1 of 3')).toBeTruthy();
    expect(result.getByLabelText('Locked demo moment 2 of 3')).toBeTruthy();
    expect(result.getByLabelText('Locked demo moment 3 of 3')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Add a moment' })).toBeTruthy();

    await fireEvent.press(result.getByRole('button', { name: 'Add a moment' }));
    expect(await result.findByRole('header', { name: 'Add a still moment' })).toBeTruthy();
  });

  it('shows the repository-backed prompt, countdown, quota, and locked-safe state', async () => {
    const result = await render(<App />);

    expect(result.getByTestId('cycle-countdown')).toBeTruthy();
    expect(result.getByText('0 of 5 contributions')).toBeTruthy();
    expect(result.getByText(/0 of 30 seconds used/)).toBeTruthy();
    expect(result.getByLabelText(/Contributions are collecting and locked/)).toBeTruthy();
    expect(result.queryAllByRole('image')).toHaveLength(0);
    expect(result.queryByRole('button', { name: /share/i })).toBeNull();
  });

  it('uses changed seeded quota metadata from the cycle repository', async () => {
    const result = await render(
      <App
        clock={() => TEST_NOW}
        cycleRepository={cycleRepository(
          cycleFixture({
            quota: { maxCount: 9, maxSeconds: 45 },
            contributionUsage: { countUsed: 2, secondsUsed: 11 },
          }),
        )}
      />,
    );

    await result.findByText('2 of 9 contributions');
    expect(result.getByText(/11 of 45 seconds used/)).toBeTruthy();
    expect(result.getByLabelText(/2 of 9 contributions used/)).toBeTruthy();
  });

  it('reads the capsule for the selected synthetic member', async () => {
    const getCurrentCycle = jest.fn().mockResolvedValue(cycleFixture());
    const result = await render(<App cycleRepository={{ getCurrentCycle }} />);

    await result.findByTestId('capsule-ready');
    await fireEvent.press(result.getByRole('button', { name: 'Choose Clover, sample member' }));
    await waitFor(() => expect(getCurrentCycle).toHaveBeenLastCalledWith('demo-group', 'demo-3'));
  });

  it('shows an understandable loading state while the capsule is fetched', async () => {
    let resolveCycle!: (cycle: Cycle) => void;
    const repository: CycleRepository = {
      getCurrentCycle: jest.fn(
        () =>
          new Promise<Cycle>((resolve) => {
            resolveCycle = resolve;
          }),
      ),
    };
    const result = await render(<App cycleRepository={repository} />);

    expect(result.getByTestId('capsule-loading')).toBeTruthy();
    await act(async () => resolveCycle(cycleFixture()));
    await result.findByTestId('capsule-ready');
  });

  it('distinguishes an empty capsule from a recoverable failure and supports retry', async () => {
    const empty = await render(<App cycleRepository={cycleRepository({ kind: 'NotFound' })} />);
    await empty.findByTestId('capsule-empty');
    expect(empty.getByText('No active capsule')).toBeTruthy();
    await empty.unmount();

    const getCurrentCycle = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'RecoverableFailure' as const })
      .mockResolvedValueOnce(cycleFixture());
    const retryResult = await render(<App cycleRepository={{ getCurrentCycle }} />);
    await retryResult.findByTestId('capsule-error');
    await fireEvent.press(retryResult.getByRole('button', { name: 'Retry loading capsule' }));
    await retryResult.findByTestId('capsule-ready');
    expect(getCurrentCycle).toHaveBeenCalledTimes(2);
  });
});

describe('Local demo profile flow', () => {
  it('offers five accessible choices, remembers selection on relaunch, and resets cleanly', async () => {
    const result = await render(<App />);
    expect(result.getByRole('header', { name: 'Weekend People' })).toBeTruthy();
    expect(result.getByRole('header', { name: 'Local demo' })).toBeTruthy();
    await result.findByText('Current member: Amber');
    expect(result.getAllByRole('button', { name: /Choose .*sample member/ })).toHaveLength(5);
    await fireEvent.press(result.getByRole('button', { name: 'Choose Clover, sample member' }));
    expect(result.getByText('Current member: Clover')).toBeTruthy();
    expect(
      result.getByRole('button', { name: 'Choose Clover, sample member, selected' }),
    ).toBeTruthy();
    await waitFor(async () => expect(await AsyncStorage.getItem(SELECTION_KEY)).toBe('demo-3'));
    await result.unmount();
    const relaunched = await render(<App />);
    await relaunched.findByText('Current member: Clover');
    await relaunched.unmount();
    await AsyncStorage.clear();
    const reset = await render(<App />);
    await reset.findByText('Current member: Amber');
  });

  it('falls back to the default for an unknown stored actor', async () => {
    await AsyncStorage.setItem(SELECTION_KEY, 'outsider');
    const result = await render(<App />);
    await result.findByText('Current member: Amber');
  });

  it('waits for saved selection before enabling choices', async () => {
    let finishLoad!: (id: string) => void;
    const result = await picker({
      load: () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
      save: async () => {},
    });
    expect(result.getByText('Loading your demo profile…')).toBeTruthy();
    expect(result.queryAllByRole('button')).toHaveLength(0);
    await act(async () => finishLoad('demo-4'));
    expect(result.getByText('Current member: Dune')).toBeTruthy();
  });

  it('switches immediately but serializes writes so the latest choice wins', async () => {
    let finishFirst!: () => void;
    let savedId: string | null = null;
    const save = jest
      .fn()
      .mockImplementationOnce(
        (id: string) =>
          new Promise<void>((resolve) => {
            finishFirst = () => {
              savedId = id;
              resolve();
            };
          }),
      )
      .mockImplementation(async (id: string) => {
        savedId = id;
      });
    const result = await picker({ load: async () => null, save });
    await result.findByText('Current member: Amber');
    await fireEvent.press(result.getByRole('button', { name: 'Choose Birch, sample member' }));
    await fireEvent.press(result.getByRole('button', { name: 'Choose Echo, sample member' }));
    expect(result.getByText('Current member: Echo')).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => finishFirst());
    await waitFor(() => expect(savedId).toBe('demo-5'));
    expect(save.mock.calls.map(([id]) => id)).toEqual(['demo-2', 'demo-5']);
  });

  it('discloses restore failure and allows saving the fallback member', async () => {
    const store = {
      load: jest.fn().mockRejectedValue(new Error('Unavailable')),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const result = await picker(store);
    await result.findByText('Current member: Amber');
    expect(result.getByRole('alert')).toBeTruthy();
    expect(result.queryByText('Your selection is remembered on this device.')).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Retry saving selection' }));
    await waitFor(() => expect(result.queryByRole('alert')).toBeNull());
    expect(store.save).toHaveBeenCalledWith('demo-1');
  });

  it('keeps the current actor on save failure and retries successfully', async () => {
    const store = {
      load: async () => null,
      save: jest.fn().mockRejectedValueOnce(new Error('Full')).mockResolvedValue(undefined),
    };
    const result = await picker(store);
    await result.findByText('Current member: Amber');
    await fireEvent.press(result.getByRole('button', { name: 'Choose Birch, sample member' }));
    await result.findByText('Could not save this selection. It may not be remembered next time.');
    expect(result.getByText('Current member: Birch')).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Retry saving selection' }));
    await result.findByText('Your selection is remembered on this device.');
    expect(store.save).toHaveBeenLastCalledWith('demo-2');
  });
});
