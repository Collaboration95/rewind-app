/**
 * Characterisation of src/capture/VideoCaptureScreen.tsx with the props
 * RealAccountGroupExperience passes (allowance, onBack, onClose, and
 * realAccount = { groupId, authenticatedRequest, transferMode: 'server' })
 * inside a ContributionStatusProvider. Uploads go through the real
 * real-account runtime adapter into a recorded `authenticatedRequest`, so the
 * assertions are on the HTTP the app sends. Only the camera platform is a
 * double (tests/mocks/capture-doubles.ts). VideoCaptureScreen.test.tsx covers
 * the browser-preview, trim edge cases, background interruption and
 * runtimeClient-injected paths, which are not repeated.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import { ContributionStatusProvider } from '../src/capture/contribution-status';
import { createRealAccountVideoRuntimeClient } from '../src/capture/real-account-video-runtime';
import * as capturePlatform from '../src/capture/platform';
import { VideoCaptureScreen } from '../src/capture/VideoCaptureScreen';
import { ToastProvider } from '../src/ui/primitives';
import { CLIP, GRANTED, SUPPORTED, createVideoPlatform } from './mocks/capture-doubles';
import { resetMockVideoPlayers } from './mocks/expo-video';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-camera', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { CameraView: (props: Record<string, unknown>) => <View {...props} /> };
});

type Screen = Awaited<ReturnType<typeof render>>;
type Props = Parameters<typeof VideoCaptureScreen>[0];

const response = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const allowance = (countUsed = 0, secondsUsed = countUsed * 8) => ({
  maxCount: 5,
  maxSeconds: 30,
  countUsed,
  secondsUsed,
  deletionsUsed: 0,
  deletionAvailability: 'available' as const,
});
const entry = (state: 'sealed' | 'failed' = 'sealed') => ({
  contributionId: 'contribution-1',
  jobId: 'job-1',
  state,
  durationSeconds: 8,
  mediaType: 'video' as const,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  attempts: 1,
  progress: 100,
  failureCategory: null,
  retryable: state === 'failed',
  replaced: false,
  restored: null,
});
const ledger = (latest: ReturnType<typeof entry> | null = null, usage = allowance()) => ({
  cycleId: 'cycle-1',
  memberId: 'member-1',
  allowance: usage,
  latestContribution: latest,
  entries: latest ? [latest] : [],
  pagination: { limit: 50, hasMore: false, nextCursor: null },
});
const upload = {
  contribution: {
    id: 'contribution-1',
    cycleId: 'cycle-1',
    groupId: 'group-1',
    memberId: 'member-1',
    durationSeconds: 8,
    createdAt: '2026-10-01T00:00:00.000Z',
  },
  existing: false,
  job: {
    id: 'job-1',
    contributionId: 'contribution-1',
    groupId: 'group-1',
    kind: 'clip' as const,
    status: 'pending' as const,
    createdAt: '2026-10-01T00:00:00.000Z',
  },
};
const jobStatus = (status: string) => ({ job: { ...upload.job, status } });

type Router = (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;

/** A recorded authenticatedRequest that behaves like a healthy server unless overridden. */
function server(override: Router = () => undefined, initialLedger = ledger()) {
  let current = initialLedger;
  const request = jest.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const handled = override(path, init);
    if (handled) return handled;
    if (path.startsWith('/contributions/upload/source?'))
      return response({ source: { uri: 'staged://clip-source', byteLength: 3 } }, 201);
    if (path.startsWith('/contributions/upload?')) return response({ upload }, 201);
    if (/^\/contributions\/jobs\/[^/]+\/process\?/.test(path)) return response(jobStatus('ready'));
    if (method === 'DELETE' && path.startsWith('/contributions/upload/'))
      return response({ cancelled: true });
    if (method === 'DELETE' && path.startsWith('/contributions/'))
      return response({ deleted: true });
    if (path.startsWith('/contributions?')) return response(current);
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  return {
    request,
    setLedger: (next: typeof current) => {
      current = next;
    },
  };
}

function setup(
  props: Partial<Props> = {},
  options: {
    platform?: ReturnType<typeof createVideoPlatform>;
    router?: Router;
    ledger?: ReturnType<typeof ledger>;
  } = {},
) {
  const platform = options.platform ?? createVideoPlatform();
  const api = server(options.router, options.ledger);
  const media = createRealAccountVideoRuntimeClient(api.request, { transferMode: 'server' });
  const onBack = jest.fn();
  const onClose = jest.fn();
  const tree = (
    <ToastProvider>
      <ContributionStatusProvider
        loadStatus={() => media.getContributionLedger('group-1')}
        scope={{ sessionId: 'real-account-session', groupId: 'group-1', memberId: 'account-1' }}
      >
        <VideoCaptureScreen
          allowance={allowance()}
          onBack={onBack}
          onClose={onClose}
          platform={platform}
          realAccount={{
            groupId: 'group-1',
            authenticatedRequest: api.request,
            transferMode: 'server',
          }}
          {...props}
        />
      </ContributionStatusProvider>
    </ToastProvider>
  );
  return { platform, api, onBack, onClose, tree };
}
async function open(...args: Parameters<typeof setup>) {
  const harness = setup(...args);
  const ui = await render(harness.tree);
  return { ui, ...harness };
}
async function openToReview(...args: Parameters<typeof setup>) {
  const opened = await open(...args);
  await fireEvent.press(await opened.ui.findByRole('button', { name: 'Start recording' }));
  await opened.ui.findByTestId('video-review');
  return opened;
}
const looks = (ui: Screen) => within(ui.getByLabelText('Look'));
const checkedLook = (ui: Screen) =>
  looks(ui)
    .getAllByRole('radio')
    .filter((radio) => radio.props.accessibilityState.checked)
    .map((radio) => within(radio).getByText(/./).props.children);
const nudgeTrim = async (ui: Screen, handle: 'Trim start' | 'Trim end', steps: number) => {
  for (let step = 0; step < Math.abs(steps); step += 1)
    await fireEvent(ui.getByLabelText(handle), 'accessibilityAction', {
      nativeEvent: { actionName: steps > 0 ? 'increment' : 'decrement' },
    });
};
const requestsTo = (request: jest.Mock, method: string, path: RegExp) =>
  request.mock.calls.filter(
    ([called, init]) => (init?.method ?? 'GET') === method && path.test(String(called)),
  );
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

beforeEach(async () => {
  await AsyncStorage.clear();
  resetMockVideoPlayers();
  jest.spyOn(capturePlatform, 'readManagedRecordedClipBase64').mockResolvedValue('AQID');
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('opening video capture', () => {
  it('shows the viewfinder with timer, guidance, looks and a shutter that records up to 15 seconds', async () => {
    const { ui, platform } = await open();
    const shutter = await ui.findByRole('button', { name: 'Start recording' });
    expect(shutter.props.accessibilityHint).toBe('Records up to 15 seconds');
    expect(ui.getByLabelText('Up to 15 seconds')).toBeTruthy();
    expect(ui.getByText('0:00 / 0:15')).toBeTruthy();
    expect(ui.getByTestId('video-portrait-guidance')).toHaveTextContent(
      'Up to 15 s with sound · hold your phone upright',
    );
    expect(checkedLook(ui)).toEqual(['Compact Digital']);
    expect(ui.getByTestId('camera-allowance')).toHaveTextContent('5 left · 30 s');
    expect(ui.getByTestId('video-live-preview')).toBeTruthy();
    expect(platform.getCapabilities).toHaveBeenCalled();
    expect(platform.recordClip).not.toHaveBeenCalled();
    expect(platform.requestPermissions).not.toHaveBeenCalled();
  });

  it('shortens the limit to the seconds left this week, and turns the shutter off below one second', async () => {
    const some = await open({ allowance: allowance(2, 22) });
    await some.ui.findByRole('button', { name: 'Start recording' });
    expect(some.ui.getByLabelText('Up to 8 seconds')).toBeTruthy();
    expect(some.ui.getByText('0:00 / 0:08')).toBeTruthy();
    expect(some.ui.getByTestId('video-portrait-guidance')).toHaveTextContent(
      'Up to 8 s with sound · hold your phone upright',
    );
    expect(some.ui.getByRole('button', { name: 'Start recording' })).toBeEnabled();
    await some.ui.unmount();

    const none = await open({ allowance: allowance(5, 30) });
    expect(await none.ui.findByRole('button', { name: 'Start recording' })).toBeDisabled();
    expect(none.ui.getByTestId('camera-allowance')).toHaveTextContent('0 left · 0 s');
  });

  it('has Photo and Video tabs with Video selected; Photo leaves through onBack', async () => {
    const { ui, onBack, onClose } = await open();
    await ui.findByRole('button', { name: 'Start recording' });
    const tabs = within(ui.getByLabelText('Capture mode'));
    expect(tabs.getByRole('tab', { name: 'Video' }).props.accessibilityState.selected).toBe(true);
    expect(tabs.getByRole('tab', { name: 'Photo' }).props.accessibilityState.selected).toBe(false);
    await fireEvent.press(tabs.getByRole('tab', { name: 'Video' }));
    expect(onBack).not.toHaveBeenCalled();
    await fireEvent.press(tabs.getByRole('tab', { name: 'Photo' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes the screen at once, through onClose, when nothing has been recorded', async () => {
    const { ui, onClose, onBack } = await open();
    await fireEvent.press(await ui.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(ui.queryByRole('button', { name: 'Discard' })).toBeNull();
  });
});

describe('camera and microphone access', () => {
  it('asks for camera and microphone only after Continue, then opens the viewfinder', async () => {
    const platform = createVideoPlatform(
      { camera: 'undetermined', microphone: 'undetermined' },
      { requestPermissions: jest.fn(async () => GRANTED) },
    );
    platform.getPermissions
      .mockResolvedValueOnce({ camera: 'undetermined', microphone: 'undetermined' })
      .mockResolvedValue(GRANTED);
    const { ui } = await open({}, { platform });
    const card = await ui.findByTestId('video-permission');
    expect(within(card).getByText('Allow camera and mic')).toBeTruthy();
    expect(within(card).getByText('Rewind records short videos with sound.')).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Start recording' })).toBeNull();
    expect(platform.requestPermissions).not.toHaveBeenCalled();
    await fireEvent.press(ui.getByRole('button', { name: 'Continue' }));
    expect(await ui.findByRole('button', { name: 'Start recording' })).toBeEnabled();
    expect(platform.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['camera', { camera: 'denied', microphone: 'granted' }],
    ['microphone', { camera: 'granted', microphone: 'denied' }],
  ] as const)(
    'treats a denied %s as "Camera or mic is off" with a way to Settings',
    async (_which, permissions) => {
      const platform = createVideoPlatform(permissions);
      const { ui } = await open({}, { platform });
      const card = await ui.findByTestId('video-permission-denied');
      expect(within(card).getByText('Camera or mic is off')).toBeTruthy();
      expect(
        within(card).getByText(
          'Turn Camera and Microphone on for Rewind in your phone’s Settings, then come back. Nothing was recorded.',
        ),
      ).toBeTruthy();
      expect(ui.queryByRole('button', { name: 'Start recording' })).toBeNull();
      await fireEvent.press(ui.getByRole('button', { name: 'Open Settings' }));
      expect(platform.openSettings).toHaveBeenCalledTimes(1);
      // The Photo tab and Close stay available.
      expect(ui.getByRole('button', { name: 'Close' })).toBeTruthy();
      expect(ui.getByRole('tab', { name: 'Photo' })).toBeTruthy();
    },
  );

  it('re-reads blocked access on Check again without asking the system', async () => {
    const platform = createVideoPlatform({ camera: 'blocked', microphone: 'granted' });
    const { ui } = await open({}, { platform });
    await ui.findByTestId('video-permission-blocked');
    const reads = platform.getPermissions.mock.calls.length;
    platform.getPermissions.mockResolvedValue(GRANTED);
    await fireEvent.press(ui.getByRole('button', { name: 'Check again' }));
    expect(await ui.findByRole('button', { name: 'Start recording' })).toBeEnabled();
    expect(platform.getPermissions.mock.calls.length).toBeGreaterThan(reads);
    expect(platform.requestPermissions).not.toHaveBeenCalled();
  });

  it('asks the system again on Check again after a plain denial', async () => {
    const platform = createVideoPlatform({ camera: 'denied', microphone: 'granted' });
    const { ui } = await open({}, { platform });
    await ui.findByTestId('video-permission-denied');
    platform.requestPermissions.mockResolvedValue({ camera: 'denied', microphone: 'granted' });
    await fireEvent.press(ui.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(platform.requestPermissions).toHaveBeenCalledTimes(1));
    await ui.findByTestId('video-permission-denied');
  });

  it('says recording is unsupported, with no file fallback, when the device lacks a camera or mic', async () => {
    const platform = createVideoPlatform(GRANTED, {
      getCapabilities: jest.fn(async () => ({ camera: 'supported', microphone: 'unsupported' })),
    });
    const { ui } = await open({}, { platform });
    const card = await ui.findByTestId('video-unsupported');
    expect(within(card).getByText('Recording is not supported here')).toBeTruthy();
    expect(
      within(card).getByText(
        'Use a physical device with camera and microphone access. Unsupported recording cannot be started here.',
      ),
    ).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Start recording' })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Choose a video file' })).toBeNull();
  });

  it('shows a retryable "temporarily unavailable" card while capability is undecided', async () => {
    const platform = createVideoPlatform(GRANTED, {
      getCapabilities: jest
        .fn()
        .mockResolvedValueOnce({ camera: 'undecided', microphone: 'supported' })
        .mockResolvedValue(SUPPORTED),
    });
    const { ui } = await open({}, { platform });
    const card = await ui.findByTestId('video-temporarily-unavailable');
    expect(within(card).getByText('Recording is temporarily unavailable')).toBeTruthy();
    expect(
      within(card).getByText('The device capability check is not ready yet. Try again shortly.'),
    ).toBeTruthy();
    await fireEvent.press(ui.getByRole('button', { name: 'Check again' }));
    expect(await ui.findByRole('button', { name: 'Start recording' })).toBeEnabled();
  });
});

describe('recording', () => {
  it('records up to 15 seconds, shows Stop recording while it runs, and stops on request', async () => {
    const recording = deferred<typeof CLIP>();
    const platform = createVideoPlatform(GRANTED, { recordClip: jest.fn(() => recording.promise) });
    const { ui } = await open({}, { platform });
    await fireEvent.press(await ui.findByRole('button', { name: 'Start recording' }));
    expect(platform.recordClip).toHaveBeenCalledWith(15);
    const stop = await ui.findByRole('button', { name: 'Stop recording' });
    expect(ui.getByTestId('video-recording').props.accessibilityLabel).toBe(
      'Recording, 0 of 15 seconds',
    );
    // Photo/Video tabs and the guidance line leave the screen while recording.
    expect(ui.queryByLabelText('Capture mode')).toBeNull();
    expect(ui.queryByTestId('video-portrait-guidance')).toBeNull();
    expect(checkedLook(ui)).toEqual(['Compact Digital']);
    expect(looks(ui).getAllByRole('radio')[0].props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(stop);
    expect(platform.stopRecording).toHaveBeenCalledTimes(1);
    await act(async () => {
      recording.resolve({ ...CLIP });
    });
    expect(await ui.findByTestId('video-review')).toBeTruthy();
  });

  it('shows the reason, and the viewfinder again, when recording fails', async () => {
    const platform = createVideoPlatform(GRANTED, {
      recordClip: jest.fn(async () => {
        throw new Error('The microphone stopped responding.');
      }),
    });
    const { ui } = await open({}, { platform });
    await fireEvent.press(await ui.findByRole('button', { name: 'Start recording' }));
    expect(await ui.findByText('The microphone stopped responding.')).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Start recording' })).toBeEnabled();
    expect(ui.queryByTestId('video-review')).toBeNull();
  });

  it('rejects a recording that breaks the rules (over 15 s) before review', async () => {
    const platform = createVideoPlatform(GRANTED, {
      recordClip: jest.fn(async () => ({ ...CLIP, durationSeconds: 16 })),
    });
    const { ui } = await open({}, { platform });
    await fireEvent.press(await ui.findByRole('button', { name: 'Start recording' }));
    expect(await ui.findByText('Recordings must be 15 seconds or shorter.')).toBeTruthy();
    expect(ui.queryByTestId('video-review')).toBeNull();
  });
});

describe('reviewing a clip', () => {
  it('describes the recording and offers trim, looks, Retake and Seal', async () => {
    const { ui } = await openToReview();
    expect(ui.getByTestId('video-review-facts')).toHaveTextContent(
      'Recorded 8.0 seconds · 720 × 1280 · audio included',
    );
    expect(ui.getByTestId('video-trim-text')).toHaveTextContent('0.0 – 8.0 s · 8.0 s');
    expect(checkedLook(ui)).toEqual(['Compact Digital']);
    expect(ui.getByRole('button', { name: 'Retake' })).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Seal' })).toBeEnabled();
    // The shutter and mode tabs make way for the review.
    expect(ui.queryByRole('button', { name: 'Start recording' })).toBeNull();
    expect(ui.queryByLabelText('Capture mode')).toBeNull();
    expect(ui.queryByTestId('video-portrait-guidance')).toBeNull();
  });

  it('retakes: back to the viewfinder, ready to record again', async () => {
    const { ui, platform } = await openToReview();
    await fireEvent.press(ui.getByRole('button', { name: 'Retake' }));
    expect(await ui.findByRole('button', { name: 'Start recording' })).toBeEnabled();
    expect(ui.queryByTestId('video-review')).toBeNull();
    await fireEvent.press(ui.getByRole('button', { name: 'Start recording' }));
    await ui.findByTestId('video-review');
    expect(platform.recordClip).toHaveBeenCalledTimes(2);
  });

  it('asks before leaving a clip that is not sealed, and Keep stays', async () => {
    const { ui, onClose } = await openToReview();
    await fireEvent.press(ui.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(ui.getByText('Discard this video?')).toBeTruthy();
    expect(ui.getByText('It hasn’t been sealed, so it won’t count.')).toBeTruthy();
    await fireEvent.press(ui.getByRole('button', { name: 'Keep' }));
    expect(ui.queryByText('Discard this video?')).toBeNull();
    expect(ui.getByTestId('video-review')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Discard closes through onClose', async () => {
    const { ui, onClose, api } = await openToReview();
    await fireEvent.press(ui.getByRole('button', { name: 'Close' }));
    await fireEvent.press(ui.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Nothing was sent to the server for an unsealed clip.
    expect(requestsTo(api.request, 'POST', /^\/contributions/)).toHaveLength(0);
  });
});

describe('sealing a clip (HTTP sent through authenticatedRequest)', () => {
  it('stages the bytes, registers the upload, processes the job, then shows Sealed', async () => {
    const { ui, api, onClose } = await openToReview();
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    expect(await ui.findByTestId('camera-contribution-status-sealed')).toBeTruthy();

    const posts = api.request.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(
      posts.map(([path]) => String(path).replace(/idempotencyKey=.*/, 'idempotencyKey=…')),
    ).toEqual([
      '/contributions/upload/source?groupId=group-1&idempotencyKey=…',
      '/contributions/upload?groupId=group-1',
      '/contributions/jobs/job-1/process?groupId=group-1',
    ]);
    const [stage, register, process] = posts;
    expect(stage[1]?.headers).toEqual({ 'Content-Type': 'video/mp4' });
    expect(Array.from(stage[1]?.body as Uint8Array)).toEqual([1, 2, 3]);
    expect(register[1]?.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = bodyOf(register);
    expect(body).toEqual({
      byteLength: 3,
      durationSeconds: 8,
      hasAudio: true,
      height: 1280,
      idempotencyKey: expect.stringMatching(/^clip-/),
      mimeType: 'video/mp4',
      mode: 'ccd',
      sourceDurationSeconds: 8,
      sourceUri: 'staged://clip-source',
      trimEndSeconds: 8,
      trimStartSeconds: 0,
      width: 720,
    });
    // The staging request and the registration share one idempotency key.
    expect(String(stage[0])).toContain(`idempotencyKey=${encodeURIComponent(body.idempotencyKey)}`);
    expect(process[1]).toEqual({ method: 'POST' });
    // Nothing identifies a session or credential in any path.
    expect(api.request.mock.calls.map(([path]) => String(path)).join('&')).not.toMatch(
      /sessionId|token|authorization/i,
    );
    // The review is replaced by the Sealed overlay with Done as the only way on.
    expect(ui.getByRole('header', { name: 'Sealed' })).toBeTruthy();
    expect(ui.queryByTestId('video-review')).toBeNull();
    await fireEvent.press(ui.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends the chosen look and the trimmed window', async () => {
    const { ui, api } = await openToReview();
    await fireEvent.press(looks(ui).getByRole('radio', { name: '8mm Home Movie' }));
    await nudgeTrim(ui, 'Trim start', 2);
    await nudgeTrim(ui, 'Trim end', -2);
    expect(ui.getByTestId('video-trim-text')).toHaveTextContent('1.0 – 7.0 s · 6.0 s');
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    await ui.findByTestId('camera-contribution-status-sealed');
    const [register] = requestsTo(api.request, 'POST', /^\/contributions\/upload\?/);
    expect(bodyOf(register)).toMatchObject({
      durationSeconds: 6,
      mode: '8mm',
      sourceDurationSeconds: 8,
      trimEndSeconds: 7,
      trimStartSeconds: 1,
    });
  });

  it('shows Uploading with a Cancel while the registration is pending; Cancel returns to review', async () => {
    const pending = deferred<Response>();
    const { ui, api } = await openToReview(
      {},
      {
        router: (path) => (path.startsWith('/contributions/upload?') ? pending.promise : undefined),
      },
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    expect(await ui.findByTestId('video-uploading')).toBeTruthy();
    expect(ui.getByLabelText('Uploading 10%').props.accessibilityRole).toBe('progressbar');
    expect(ui.queryByRole('button', { name: 'Seal' })).toBeNull();
    await fireEvent.press(ui.getByRole('button', { name: 'Cancel upload' }));
    expect(
      await ui.findByText('Upload cancelled. Your moment is still here to seal.'),
    ).toBeTruthy();
    expect(ui.queryByTestId('video-uploading')).toBeNull();
    expect(ui.getByRole('button', { name: 'Seal' })).toBeEnabled();
    await act(async () => {
      pending.resolve(response({ upload }, 201));
    });
    // The registration that landed after Cancel is withdrawn again.
    await waitFor(() =>
      expect(requestsTo(api.request, 'DELETE', /^\/contributions\/upload\/job-1\?/)).toHaveLength(
        1,
      ),
    );
    expect(ui.queryByTestId('camera-contribution-status-sealed')).toBeNull();
  });

  it('leaves the clip pending ("queued") when the job is still processing', async () => {
    const { ui } = await openToReview(
      {},
      {
        router: (path) =>
          /\/process\?/.test(path) ? response(jobStatus('processing')) : undefined,
      },
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    expect(await ui.findByText('Upload queued as one pending contribution.')).toBeTruthy();
    expect(ui.queryByTestId('camera-contribution-status-sealed')).toBeNull();
    expect(ui.getByRole('button', { name: 'Retake' })).toBeTruthy();
    expect(ui.getByTestId('video-review')).toBeTruthy();
  });

  it('offers Retry when processing fails, and a retry registers again then seals', async () => {
    let processed = 0;
    const { ui, api } = await openToReview(
      {},
      {
        router: (path) =>
          /\/process\?/.test(path)
            ? response(jobStatus(++processed === 1 ? 'failed' : 'ready'))
            : undefined,
      },
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    const failed = await ui.findByTestId('camera-contribution-status-failed');
    expect(within(failed).getByText('Couldn’t upload')).toBeTruthy();
    expect(
      within(failed).getByText('It’s kept on this phone and doesn’t count until it’s sealed.'),
    ).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Retry upload' })).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Back to review' })).toBeTruthy();
    await fireEvent.press(ui.getByRole('button', { name: 'Retry upload' }));
    expect(await ui.findByTestId('camera-contribution-status-sealed')).toBeTruthy();
    expect(requestsTo(api.request, 'POST', /^\/contributions\/upload\?/)).toHaveLength(2);
    // Both registrations carry the same idempotency key.
    const keys = requestsTo(api.request, 'POST', /^\/contributions\/upload\?/).map(
      (call) => bodyOf(call).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it('shows a retryable failure for a server error, and Back to review returns to Seal', async () => {
    const { ui } = await openToReview(
      {},
      {
        router: (path) =>
          path.startsWith('/contributions/upload?')
            ? response({ message: 'The upload service is busy.' }, 503)
            : undefined,
      },
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    const failed = await ui.findByTestId('camera-contribution-status-failed');
    expect(within(failed).getByText('Couldn’t upload')).toBeTruthy();
    expect(ui.getAllByText('The upload service is busy.').length).toBeGreaterThan(0);
    await fireEvent.press(ui.getByRole('button', { name: 'Back to review' }));
    expect(ui.queryByTestId('camera-contribution-status-failed')).toBeNull();
    expect(ui.getByRole('button', { name: 'Seal' })).toBeEnabled();
  });

  it('treats a rejected upload (4xx) as final: take it again, no Retry', async () => {
    const { ui } = await openToReview(
      {},
      {
        router: (path) =>
          path.startsWith('/contributions/upload?')
            ? response({ error: 'validation', message: 'The clip was rejected.' }, 400)
            : undefined,
      },
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    const failed = await ui.findByTestId('camera-contribution-status-failed');
    expect(within(failed).getByText('Couldn’t seal this moment')).toBeTruthy();
    expect(
      within(failed).getByText('This one can’t be retried. Take it again to add a new moment.'),
    ).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Retry upload' })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Seal' })).toBeNull();
    await fireEvent.press(ui.getByRole('button', { name: 'Retake' }));
    expect(await ui.findByRole('button', { name: 'Start recording' })).toBeEnabled();
  });

  it('says "No moments left" when the server reports the quota is used', async () => {
    const { ui } = await openToReview(
      {},
      {
        router: (path) =>
          path.startsWith('/contributions/upload?')
            ? response({ error: 'quota_exceeded', message: 'No moments left.' }, 409)
            : undefined,
      },
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    const failed = await ui.findByTestId('camera-contribution-status-failed');
    expect(within(failed).getByText('No moments left')).toBeTruthy();
    expect(within(failed).getByText('You’ve used all your moments this cycle.')).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Retry upload' })).toBeNull();
  });

  it('does not register an upload when staging the bytes fails', async () => {
    const { ui, api } = await openToReview(
      {},
      {
        router: (path) =>
          path.startsWith('/contributions/upload/source?')
            ? response({ message: 'Storage is full.' }, 507)
            : undefined,
      },
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    await ui.findByTestId('camera-contribution-status-failed');
    expect(requestsTo(api.request, 'POST', /^\/contributions\/upload\?/)).toHaveLength(0);
    expect(ui.queryByTestId('camera-contribution-status-sealed')).toBeNull();
  });
});

describe('Your moments and delete and replace', () => {
  const sealedLedger = () => ledger(entry('sealed'), allowance(1));

  it('shows the latest moment and lets the person delete it by id, then replaces it on the next seal', async () => {
    let replaced = false;
    const { ui, api } = await open(
      { allowance: allowance(1) },
      {
        ledger: sealedLedger(),
        router: (path, init) => {
          if (init?.method === 'DELETE' && path.startsWith('/contributions/contribution-1')) {
            replaced = true;
            return response({ deleted: true });
          }
          if (replaced && path.startsWith('/contributions?'))
            return response(ledger(null, allowance(0)));
          return undefined;
        },
      },
    );
    await fireEvent.press(await ui.findByRole('button', { name: 'Your moments: 1 sealed' }));
    const dialog = within(await ui.findByTestId('camera-moments-dialog'));
    expect(dialog.getByText('Moment sealed')).toBeTruthy();
    await fireEvent.press(dialog.getByRole('button', { name: 'Delete and replace' }));
    expect(
      await ui.findByText(
        'Contribution deleted. Your weekly allowance is restored for a replacement.',
      ),
    ).toBeTruthy();
    expect(
      requestsTo(api.request, 'DELETE', /^\/contributions\/contribution-1\?groupId=group-1$/),
    ).toHaveLength(1);
    expect(ui.queryByTestId('camera-moments-dialog')).toBeNull();

    await fireEvent.press(await ui.findByRole('button', { name: 'Start recording' }));
    await ui.findByTestId('video-review');
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    await ui.findByTestId('camera-contribution-status-sealed');
    const [register] = requestsTo(api.request, 'POST', /^\/contributions\/upload\?/);
    expect(bodyOf(register).replacesContributionId).toBe('contribution-1');
  });

  it('keeps the moment, and says why, when the delete is refused', async () => {
    const { ui } = await open(
      { allowance: allowance(1) },
      {
        ledger: sealedLedger(),
        router: (path, init) =>
          init?.method === 'DELETE' && path.startsWith('/contributions/contribution-1')
            ? response(
                { error: 'contribution_deletion_used', message: 'Deletion already used.' },
                409,
              )
            : undefined,
      },
    );
    await fireEvent.press(await ui.findByRole('button', { name: 'Your moments: 1 sealed' }));
    await fireEvent.press(
      within(await ui.findByTestId('camera-moments-dialog')).getByRole('button', {
        name: 'Delete and replace',
      }),
    );
    expect(
      await ui.findByText('The contribution could not be deleted. Deletion already used.'),
    ).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Your moments: 1 sealed' })).toBeTruthy();
  });
});
