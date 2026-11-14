/**
 * Characterisation of src/capture/CameraCaptureScreen.tsx with the props
 * RealAccountGroupExperience actually passes (allowance, groupName, onBack,
 * onRecordClip, onSubmitPhoto, onDeletePhotoContribution) inside a
 * ContributionStatusProvider scoped to the group. The platform, file store and
 * metadata store are injected test doubles from tests/mocks/capture-doubles.ts.
 * Not covered here because CameraCaptureScreen.test.tsx already pins it:
 * stale captures after backgrounding, live-preview readiness gating.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import type { ReactElement } from 'react';

import { CameraCaptureScreen } from '../src/capture/CameraCaptureScreen';
import { ContributionStatusProvider } from '../src/capture/contribution-status';
import type { ContributionStatus } from '../src/capture/contribution-status';
import type { ContributionLedgerPage } from '../src/domain/contributions';
import {
  GRANTED,
  MemoryFileStore,
  MemoryMetadataStore,
  STILL,
  createStillPlatform,
} from './mocks/capture-doubles';

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
type Props = Parameters<typeof CameraCaptureScreen>[0];

const allowance = (countUsed = 0, secondsUsed = countUsed * 3) => ({
  maxCount: 5,
  maxSeconds: 30,
  countUsed,
  secondsUsed,
  deletionsUsed: 0,
  deletionAvailability: 'available' as const,
});
const page = (
  overrides: Partial<ContributionLedgerPage> = {},
  usage = allowance(),
): ContributionLedgerPage => ({
  cycleId: 'cycle-1',
  memberId: 'member-1',
  allowance: usage,
  latestContribution: null,
  entries: [],
  pagination: { limit: 50, hasMore: false, nextCursor: null },
  ...overrides,
});
const sealedEntry = {
  contributionId: 'contribution-1',
  jobId: 'job-1',
  state: 'sealed' as const,
  durationSeconds: 3,
  mediaType: 'photo' as const,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  attempts: 1,
  progress: 100,
  failureCategory: null,
  retryable: false,
  replaced: false,
  restored: null,
};

const sealedStatus = (): ContributionStatus => ({
  state: 'sealed',
  createdAt: '2026-10-01T00:00:00.000Z',
  retryable: false,
});

function setup(
  props: Partial<Props> = {},
  options: {
    platform?: ReturnType<typeof createStillPlatform>;
    files?: MemoryFileStore;
    metadata?: MemoryMetadataStore;
    ledger?: () => Promise<ContributionLedgerPage>;
  } = {},
) {
  const platform = options.platform ?? createStillPlatform();
  const files = options.files ?? new MemoryFileStore();
  const metadata = options.metadata ?? new MemoryMetadataStore();
  const loadStatus = jest.fn(options.ledger ?? (async () => page()));
  let captureNumber = 0;
  const onBack = jest.fn();
  const onRecordClip = jest.fn();
  const onSubmitPhoto = jest.fn(async (..._args: unknown[]): Promise<ContributionStatus> =>
    sealedStatus(),
  );
  const onDeletePhotoContribution = jest.fn(async (_id: string) => undefined);
  const tree = (): ReactElement => (
    <ContributionStatusProvider
      loadStatus={loadStatus}
      scope={{ sessionId: 'real-account-session', groupId: 'group-1', memberId: 'account-1' }}
    >
      <CameraCaptureScreen
        allowance={allowance()}
        createCaptureId={() => `capture-${++captureNumber}`}
        fileStore={files}
        groupName="Saturday table"
        metadataStore={metadata}
        now={() => new Date('2026-10-01T08:00:00.000Z')}
        onBack={onBack}
        onDeletePhotoContribution={onDeletePhotoContribution}
        onRecordClip={onRecordClip}
        onSubmitPhoto={onSubmitPhoto}
        platform={platform}
        {...props}
      />
    </ContributionStatusProvider>
  );
  return {
    platform,
    files,
    metadata,
    loadStatus,
    onBack,
    onRecordClip,
    onSubmitPhoto,
    onDeletePhotoContribution,
    tree,
  };
}

async function open(...args: Parameters<typeof setup>) {
  const harness = setup(...args);
  const ui = await render(harness.tree());
  return { ui, ...harness };
}
async function openToReview(...args: Parameters<typeof setup>) {
  const opened = await open(...args);
  await fireEvent.press(await opened.ui.findByRole('button', { name: 'Take photo' }));
  await opened.ui.findByTestId('camera-preview-panel');
  return opened;
}
const looks = (ui: Screen) => within(ui.getByLabelText('Look'));
const checkedLook = (ui: Screen) =>
  looks(ui)
    .getAllByRole('radio')
    .filter((radio) => radio.props.accessibilityState.checked)
    .map((radio) => within(radio).getByText(/./).props.children);

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('opening the camera', () => {
  it('shows the viewfinder with the group, the allowance left and an enabled shutter', async () => {
    const { ui, platform } = await open();
    const shutter = await ui.findByRole('button', { name: 'Take photo' });
    expect(shutter).toBeEnabled();
    expect(shutter.props.accessibilityHint).toBe('Takes one still image and opens a preview');
    expect(ui.getByRole('header', { name: 'Add a moment' })).toBeTruthy();
    expect(ui.getByTestId('camera-group-context')).toHaveTextContent('Group · Saturday table');
    expect(ui.getByTestId('camera-allowance')).toHaveTextContent('5 left · 30 s');
    expect(ui.getByTestId('camera-allowance').props.accessibilityLabel).toBe(
      '5 moments and 30 seconds left this week',
    );
    expect(ui.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(platform.getCapabilities).toHaveBeenCalled();
    expect(platform.getPermissions).toHaveBeenCalled();
    expect(platform.requestPermissions).not.toHaveBeenCalled();
    expect(platform.captureStill).not.toHaveBeenCalled();
  });

  it('offers the Photo/Video tabs with Photo selected, and Video calls onRecordClip', async () => {
    const { ui, onRecordClip } = await open();
    await ui.findByRole('button', { name: 'Take photo' });
    const tabs = within(ui.getByLabelText('Capture mode'));
    expect(tabs.getByRole('tab', { name: 'Photo' }).props.accessibilityState.selected).toBe(true);
    expect(tabs.getByRole('tab', { name: 'Video' }).props.accessibilityState.selected).toBe(false);
    await fireEvent.press(tabs.getByRole('tab', { name: 'Photo' }));
    expect(onRecordClip).not.toHaveBeenCalled();
    await fireEvent.press(tabs.getByRole('tab', { name: 'Video' }));
    expect(onRecordClip).toHaveBeenCalledTimes(1);
  });

  it('closes through the × button', async () => {
    const { ui, onBack } = await open();
    await fireEvent.press(await ui.findByRole('button', { name: 'Close' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('lets the person choose a retro look before shooting, Compact Digital first', async () => {
    const { ui } = await open();
    await ui.findByRole('button', { name: 'Take photo' });
    expect(looks(ui).getAllByRole('radio')).toHaveLength(4);
    expect(checkedLook(ui)).toEqual(['Compact Digital']);
    await fireEvent.press(looks(ui).getByRole('radio', { name: 'VHS Camcorder' }));
    expect(checkedLook(ui)).toEqual(['VHS Camcorder']);
  });
});

describe('camera access states', () => {
  it('asks for permission only when the person continues, then opens the viewfinder', async () => {
    const platform = createStillPlatform({
      getPermissions: jest.fn(async () => ({ camera: 'undetermined', microphone: 'undetermined' })),
    });
    const { ui } = await open({}, { platform });
    const card = await ui.findByTestId('camera-permission-undecided');
    expect(within(card).getByText('Allow the camera')).toBeTruthy();
    expect(within(card).getByText('Rewind needs the camera to take a photo.')).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Take photo' })).toBeNull();
    expect(platform.requestPermissions).not.toHaveBeenCalled();
    await fireEvent.press(ui.getByRole('button', { name: 'Continue' }));
    expect(await ui.findByRole('button', { name: 'Take photo' })).toBeEnabled();
    expect(platform.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('keeps the card when the person declines the system prompt', async () => {
    const platform = createStillPlatform({
      getPermissions: jest.fn(async () => ({ camera: 'undetermined', microphone: 'granted' })),
      requestPermissions: jest.fn(async () => ({ camera: 'denied', microphone: 'granted' })),
    });
    const { ui } = await open({}, { platform });
    await fireEvent.press(await ui.findByRole('button', { name: 'Continue' }));
    const card = await ui.findByTestId('camera-permission-denied');
    expect(within(card).getByText('The camera is off')).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Take photo' })).toBeNull();
  });

  it('sends a denied person to Settings or to ask again, and re-checks after Settings', async () => {
    const platform = createStillPlatform({
      getPermissions: jest
        .fn()
        .mockResolvedValueOnce({ camera: 'denied', microphone: 'granted' })
        .mockResolvedValue(GRANTED),
    });
    const { ui } = await open({}, { platform });
    const card = await ui.findByTestId('camera-permission-denied');
    expect(
      within(card).getByText(
        'Turn Camera on for Rewind in your phone’s Settings, then come back. Nothing was recorded.',
      ),
    ).toBeTruthy();
    await fireEvent.press(ui.getByRole('button', { name: 'Open Settings' }));
    expect(platform.openSettings).toHaveBeenCalledTimes(1);
    expect(await ui.findByRole('button', { name: 'Take photo' })).toBeEnabled();
  });

  it('asks again from "Check again" when denied, but only re-reads when blocked', async () => {
    const denied = createStillPlatform({
      getPermissions: jest.fn(async () => ({ camera: 'denied', microphone: 'granted' })),
      requestPermissions: jest.fn(async () => ({ camera: 'denied', microphone: 'granted' })),
    });
    const first = await open({}, { platform: denied });
    await fireEvent.press(await first.ui.findByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(denied.requestPermissions).toHaveBeenCalledTimes(1));
    await first.ui.unmount();

    const blocked = createStillPlatform({
      getPermissions: jest.fn(async () => ({ camera: 'blocked', microphone: 'granted' })),
    });
    const second = await open({}, { platform: blocked });
    await second.ui.findByTestId('camera-permission-blocked');
    const reads = blocked.getPermissions.mock.calls.length;
    await fireEvent.press(second.ui.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(blocked.getPermissions.mock.calls.length).toBeGreaterThan(reads));
    expect(blocked.requestPermissions).not.toHaveBeenCalled();
  });

  it('shows why Settings could not be opened', async () => {
    const platform = createStillPlatform({
      getPermissions: jest.fn(async () => ({ camera: 'blocked', microphone: 'granted' })),
      openSettings: jest.fn(async () => {
        throw new Error('Use your browser’s site settings to allow the camera.');
      }),
    });
    const { ui } = await open({}, { platform });
    await fireEvent.press(await ui.findByRole('button', { name: 'Open Settings' }));
    expect(
      await ui.findByText('Use your browser’s site settings to allow the camera.'),
    ).toBeTruthy();
  });

  it('says plainly that an unsupported device cannot take a still', async () => {
    const platform = createStillPlatform({
      getCapabilities: jest.fn(async () => ({ camera: 'unsupported', microphone: 'supported' })),
    });
    const { ui } = await open({}, { platform });
    const card = await ui.findByTestId('camera-unsupported');
    expect(within(card).getByText('Camera capture is not supported here')).toBeTruthy();
    expect(
      within(card).getByText(
        'This device cannot provide the camera needed for a still moment. Use a physical device with camera access.',
      ),
    ).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Take photo' })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Choose an image file' })).toBeNull();
    // The way out stays available.
    expect(ui.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('offers a file chooser, labelled as a file, when the platform has a file fallback', async () => {
    const pickStillFile = jest.fn(async () => ({
      sourceUri: 'blob:picked',
      format: 'jpg' as const,
      width: 800,
      height: 600,
      source: 'file' as const,
    }));
    const platform = createStillPlatform({
      getCapabilities: jest.fn(async () => ({ camera: 'unsupported', microphone: 'supported' })),
      pickStillFile,
      supportsFileFallback: true,
    });
    const { ui } = await open({}, { platform });
    expect((await ui.findByTestId('camera-unsupported')).props.children).toBeTruthy();
    expect(
      ui.getByText(
        'Live camera capture is not supported here. Choose an image file instead; it remains labelled as a file contribution.',
      ),
    ).toBeTruthy();
    await fireEvent.press(ui.getByRole('button', { name: 'Choose an image file' }));
    await ui.findByTestId('camera-preview-panel');
    expect(ui.getByText('Chosen from a file')).toBeTruthy();
    expect(pickStillFile).toHaveBeenCalledTimes(1);
    expect(platform.captureStill).not.toHaveBeenCalled();
  });

  it('shows a temporarily-unavailable card, with Check again, when capability is undecided', async () => {
    const platform = createStillPlatform({
      getCapabilities: jest
        .fn()
        .mockResolvedValueOnce({ camera: 'undecided', microphone: 'supported' })
        .mockResolvedValue({ camera: 'supported', microphone: 'supported' }),
    });
    const { ui } = await open({}, { platform });
    const card = await ui.findByTestId('camera-temporarily-unavailable');
    expect(within(card).getByText('Camera is temporarily unavailable')).toBeTruthy();
    await fireEvent.press(ui.getByRole('button', { name: 'Check again' }));
    expect(await ui.findByRole('button', { name: 'Take photo' })).toBeEnabled();
  });

  it('reports a failed capability check in the same card', async () => {
    const platform = createStillPlatform({
      getCapabilities: jest.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { ui } = await open({}, { platform });
    await ui.findByTestId('camera-temporarily-unavailable');
    expect(ui.getByText('We could not check this device yet. Try again.')).toBeTruthy();
  });
});

describe('taking and reviewing a photo', () => {
  it('turns a shot into a review with the still, the cost, the looks, and Retake / Seal only', async () => {
    const { ui, files, platform } = await openToReview();
    expect(platform.captureStill).toHaveBeenCalledTimes(1);
    expect(ui.getByLabelText('Captured still preview').props.source.uri).toBe(
      'memory://stills/capture-1.jpg',
    );
    expect(files.size).toBe(1);
    expect(ui.getByText('Counts as one moment · 3 s in the film')).toBeTruthy();
    expect(checkedLook(ui)).toEqual(['Compact Digital']);
    expect(ui.getByRole('button', { name: 'Retake' })).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Seal' })).toBeEnabled();
    // The local-only save flow is not part of the group flow.
    expect(ui.queryByRole('button', { name: 'Use this still' })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Discard' })).toBeNull();
    // The shutter and mode tabs leave the screen while reviewing.
    expect(ui.queryByRole('button', { name: 'Take photo' })).toBeNull();
    expect(ui.queryByLabelText('Capture mode')).toBeNull();
    expect(ui.getByTestId('camera-group-context')).toHaveTextContent('Group · Saturday table');
  });

  it('retakes: drops the still and its file and returns to the viewfinder for another', async () => {
    const { ui, files, platform } = await openToReview();
    await fireEvent.press(ui.getByRole('button', { name: 'Retake' }));
    expect(await ui.findByRole('button', { name: 'Take photo' })).toBeEnabled();
    expect(ui.queryByTestId('camera-preview-panel')).toBeNull();
    expect(files.size).toBe(0);
    await fireEvent.press(ui.getByRole('button', { name: 'Take photo' }));
    await ui.findByTestId('camera-preview-panel');
    expect(platform.captureStill).toHaveBeenCalledTimes(2);
    expect(ui.getByLabelText('Captured still preview').props.source.uri).toBe(
      'memory://stills/capture-2.jpg',
    );
    expect(files.size).toBe(1);
  });

  it('replaces the viewfinder with a "Capture failed" card that gives the reason', async () => {
    const platform = createStillPlatform({
      captureStill: jest.fn().mockRejectedValue(new Error('camera warm-up failed')),
    });
    const { ui, files } = await open({}, { platform });
    await fireEvent.press(await ui.findByRole('button', { name: 'Take photo' }));
    const card = await ui.findByTestId('camera-capture-failed');
    expect(within(card).getByText('Capture failed')).toBeTruthy();
    expect(within(card).getByText('camera warm-up failed')).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Take photo' })).toBeNull();
    expect(ui.queryByTestId('camera-preview-panel')).toBeNull();
    expect(files.size).toBe(0);
    expect(platform.captureStill).toHaveBeenCalledTimes(1);
    expect(ui.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('Try again after a failed capture returns to the viewfinder for a fresh capture', async () => {
    const platform = createStillPlatform({
      captureStill: jest
        .fn()
        .mockRejectedValueOnce(new Error('camera warm-up failed'))
        .mockResolvedValue(STILL),
    });
    const { ui, files } = await open({}, { platform });
    await fireEvent.press(await ui.findByRole('button', { name: 'Take photo' }));
    await ui.findByTestId('camera-capture-failed');
    await fireEvent.press(ui.getByRole('button', { name: 'Try again' }));
    await fireEvent.press(await ui.findByRole('button', { name: 'Take photo' }));
    await ui.findByTestId('camera-preview-panel');
    expect(platform.captureStill).toHaveBeenCalledTimes(2);
    expect(files.size).toBe(1);
  });

  it('shows "Local save failed" when the copy cannot be verified, and Try again re-checks access', async () => {
    const files = new MemoryFileStore();
    jest.spyOn(files, 'exists').mockResolvedValueOnce(false);
    const { ui } = await open({}, { files });
    await fireEvent.press(await ui.findByRole('button', { name: 'Take photo' }));
    const card = await ui.findByTestId('camera-write-failed');
    expect(within(card).getByText('Local save failed')).toBeTruthy();
    expect(
      within(card).getByText(
        'The captured image could not be verified in app storage. Try taking it again.',
      ),
    ).toBeTruthy();
    expect(files.size).toBe(0);
    await fireEvent.press(ui.getByRole('button', { name: 'Try again' }));
    expect(await ui.findByRole('button', { name: 'Take photo' })).toBeEnabled();
  });

  it('turns the shutter off, and says why, when less than 3 s are left this week', async () => {
    const { ui } = await open({ allowance: allowance(4, 28) });
    const shutter = await ui.findByRole('button', { name: 'Take photo' });
    expect(shutter).toBeDisabled();
    expect(ui.getByText('A photo needs 3 s; you have 2 s left this week.')).toBeTruthy();
    expect(ui.getByTestId('camera-allowance')).toHaveTextContent('1 left · 2 s');
  });

  it('shows the moments count button only once the ledger knows a contribution', async () => {
    const empty = await open();
    await empty.ui.findByRole('button', { name: 'Take photo' });
    expect(empty.ui.queryByTestId('camera-your-moments')).toBeNull();
    await empty.ui.unmount();

    const withOne = await open(
      { allowance: allowance(1) },
      {
        ledger: async () =>
          page({ latestContribution: sealedEntry, entries: [sealedEntry] }, allowance(1)),
      },
    );
    expect(await withOne.ui.findByRole('button', { name: 'Your moments: 1 sealed' })).toBeTruthy();
  });
});

describe('sealing a photo', () => {
  it('hands the metadata, the bytes and the chosen look to onSubmitPhoto, then shows Sealed', async () => {
    const { ui, onSubmitPhoto, onBack, files, metadata } = await openToReview();
    await fireEvent.press(looks(ui).getByRole('radio', { name: 'VHS Camcorder' }));
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    await ui.findByTestId('camera-sealed');
    expect(onSubmitPhoto).toHaveBeenCalledTimes(1);
    const [meta, base64, onProgress, replaces, look] = onSubmitPhoto.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
      unknown,
      unknown,
      unknown,
    ];
    expect(meta).toEqual({
      id: 'capture-1',
      capturedAt: '2026-10-01T08:00:00.000Z',
      format: 'jpg',
      mimeType: 'image/jpeg',
      width: 1200,
      height: 900,
      byteLength: 3,
      source: 'camera',
    });
    expect(base64).toBe('AQID');
    expect(typeof onProgress).toBe('function');
    expect(replaces).toBeUndefined();
    expect(look).toEqual({ mode: 'vhs', clientProcessed: false });
    // Sealed: a single Done, the remaining allowance, and no local leftovers.
    expect(ui.getByRole('header', { name: 'Sealed' })).toBeTruthy();
    expect(ui.getByText('Nobody sees it before the film, not even you.')).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(files.size).toBe(0);
    expect(await metadata.list()).toEqual([]);
    await fireEvent.press(ui.getByRole('button', { name: 'Done' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(ui.queryByTestId('camera-sealed')).toBeNull();
  });

  it('sends the default look when none is chosen', async () => {
    const { ui, onSubmitPhoto } = await openToReview();
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    await ui.findByTestId('camera-sealed');
    expect(onSubmitPhoto.mock.calls[0][4]).toEqual({ mode: 'ccd', clientProcessed: false });
  });

  it('shows an Uploading… progress bar and no Seal while the upload is in flight', async () => {
    let finish!: (status: ContributionStatus) => void;
    const { ui, onSubmitPhoto } = await openToReview();
    onSubmitPhoto.mockImplementationOnce(
      () =>
        new Promise<ContributionStatus>((resolve) => {
          finish = resolve;
        }),
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    const progress = await ui.findByLabelText('Uploading…');
    expect(progress.props.accessibilityRole).toBe('progressbar');
    expect(ui.getByTestId('camera-uploading')).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Seal' })).toBeNull();
    // A photo upload has no cancel control.
    expect(ui.queryByRole('button', { name: /Cancel/ })).toBeNull();
    expect(ui.queryByTestId('camera-sealed')).toBeNull();
    await act(async () => {
      finish(sealedStatus());
    });
    expect(await ui.findByTestId('camera-sealed')).toBeTruthy();
  });

  it('keeps the photo on the phone and offers Retry / Back to review when the upload fails', async () => {
    const { ui, onSubmitPhoto, files } = await openToReview();
    onSubmitPhoto.mockRejectedValueOnce(
      new Error('Photo contribution upload is unavailable. Retry shortly.'),
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    const failed = await ui.findByTestId('camera-upload-failed');
    expect(within(failed).getByText('Couldn’t upload')).toBeTruthy();
    expect(
      within(failed).getByText(
        'Photo contribution upload is unavailable. Retry shortly. It’s kept on this phone and doesn’t count until it’s sealed.',
      ),
    ).toBeTruthy();
    expect(files.size).toBe(1);
    expect(ui.queryByTestId('camera-sealed')).toBeNull();

    // Back to review shows the review again, with Seal available.
    await fireEvent.press(ui.getByRole('button', { name: 'Back to review' }));
    expect(ui.queryByTestId('camera-upload-failed')).toBeNull();
    expect(ui.getByRole('button', { name: 'Seal' })).toBeEnabled();

    // Sealing again reuses the same photo and succeeds.
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    await ui.findByTestId('camera-sealed');
    expect(onSubmitPhoto).toHaveBeenCalledTimes(2);
    expect((onSubmitPhoto.mock.calls[1][0] as { id: string }).id).toBe('capture-1');
  });

  it('retries from the failure panel with the same photo', async () => {
    const { ui, onSubmitPhoto } = await openToReview();
    onSubmitPhoto.mockRejectedValueOnce(new Error('offline'));
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    await ui.findByTestId('camera-upload-failed');
    await fireEvent.press(ui.getByRole('button', { name: 'Retry photo upload' }));
    await ui.findByTestId('camera-sealed');
    expect(onSubmitPhoto).toHaveBeenCalledTimes(2);
  });

  it('does not upload a photo over 10 MiB and says so', async () => {
    const { ui, onSubmitPhoto } = await openToReview(
      {},
      { files: new MemoryFileStore({ byteLength: 10 * 1024 * 1024 + 1 }) },
    );
    await fireEvent.press(ui.getByRole('button', { name: 'Seal' }));
    const failed = await ui.findByTestId('camera-upload-failed');
    expect(
      within(failed).getByText(/^Choose a valid JPEG or PNG photo no larger than 10 MiB\./),
    ).toBeTruthy();
    expect(onSubmitPhoto).not.toHaveBeenCalled();
  });

  it('restores an unsent photo as the review when the camera is opened again', async () => {
    const files = new MemoryFileStore();
    const metadata = new MemoryMetadataStore();
    const first = await open({}, { files, metadata });
    await fireEvent.press(await first.ui.findByRole('button', { name: 'Take photo' }));
    await first.ui.findByTestId('camera-preview-panel');
    first.onSubmitPhoto.mockRejectedValueOnce(new Error('offline'));
    await fireEvent.press(first.ui.getByRole('button', { name: 'Seal' }));
    await first.ui.findByTestId('camera-upload-failed');
    await first.ui.unmount();
    expect(files.size).toBe(1);

    const second = await open({}, { files, metadata });
    await second.ui.findByTestId('camera-preview-panel');
    expect(second.ui.getByLabelText('Captured still preview').props.source.uri).toBe(
      'memory://stills/capture-1.jpg',
    );
    await fireEvent.press(second.ui.getByRole('button', { name: 'Seal' }));
    await second.ui.findByTestId('camera-sealed');
    expect((second.onSubmitPhoto.mock.calls[0][0] as { id: string }).id).toBe('capture-1');
  });
});

describe('delete and replace', () => {
  const ledgerWithSealed = async () =>
    page({ latestContribution: sealedEntry, entries: [sealedEntry] }, allowance(1));

  async function openMoments(opened: Awaited<ReturnType<typeof open>>) {
    await fireEvent.press(await opened.ui.findByRole('button', { name: 'Your moments: 1 sealed' }));
    return within(await opened.ui.findByTestId('camera-moments-dialog'));
  }

  it('shows the latest moment in "Your moments" with its allowance and a Delete and replace action', async () => {
    const opened = await open({ allowance: allowance(1) }, { ledger: ledgerWithSealed });
    const dialog = await openMoments(opened);
    expect(dialog.getByText('Moment sealed')).toBeTruthy();
    expect(dialog.getByText('It will appear in the group film when the cycle ends.')).toBeTruthy();
    expect(dialog.getByText('1 of 5 contributions · 3 of 30 seconds used')).toBeTruthy();
    expect(dialog.getByRole('button', { name: 'Delete and replace' })).toBeTruthy();
    await fireEvent.press(dialog.getByRole('button', { name: 'Close' }));
    expect(opened.ui.queryByTestId('camera-moments-dialog')).toBeNull();
  });

  it('deletes the contribution, closes the dialog and makes the next seal replace it', async () => {
    let deleted = false;
    const opened = await open(
      { allowance: allowance(1) },
      {
        ledger: async () => (deleted ? page({}, allowance(0)) : await ledgerWithSealed()),
      },
    );
    opened.onDeletePhotoContribution.mockImplementationOnce(async () => {
      deleted = true;
    });
    const dialog = await openMoments(opened);
    await fireEvent.press(dialog.getByRole('button', { name: 'Delete and replace' }));
    await waitFor(() => expect(opened.ui.queryByTestId('camera-moments-dialog')).toBeNull());
    expect(opened.onDeletePhotoContribution).toHaveBeenCalledWith('contribution-1');
    await waitFor(() => expect(opened.ui.queryByTestId('camera-your-moments')).toBeNull());

    await fireEvent.press(opened.ui.getByRole('button', { name: 'Take photo' }));
    await opened.ui.findByTestId('camera-preview-panel');
    await fireEvent.press(opened.ui.getByRole('button', { name: 'Seal' }));
    await opened.ui.findByTestId('camera-sealed');
    expect(opened.onSubmitPhoto.mock.calls[0][3]).toBe('contribution-1');
  });

  it('keeps the dialog and the moment when the delete is refused', async () => {
    const opened = await open({ allowance: allowance(1) }, { ledger: ledgerWithSealed });
    opened.onDeletePhotoContribution.mockRejectedValueOnce(new Error('Already used this week.'));
    const dialog = await openMoments(opened);
    await fireEvent.press(dialog.getByRole('button', { name: 'Delete and replace' }));
    await waitFor(() => expect(opened.onDeletePhotoContribution).toHaveBeenCalledTimes(1));
    expect(opened.ui.getByTestId('camera-moments-dialog')).toBeTruthy();
    expect(opened.ui.getByRole('button', { name: 'Your moments: 1 sealed' })).toBeTruthy();
  });
});
