/**
 * Characterisation of how RealAccountGroupExperience wires the two capture
 * screens: the props it passes to them and the HTTP its photo-submit and
 * photo-delete callbacks send. The screens are replaced by doubles that expose
 * the props they were given, so this file pins the glue in the experience
 * itself; the screens' own behaviour is pinned in camera-capture.* and
 * video-capture.* characterisation tests.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountGroupExperience } from '../src/groups/RealAccountGroupExperience';
import { ToastProvider } from '../src/ui/primitives';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));
jest.mock('../src/chat/native-event-source', () => ({
  createRuntimeEventSource: () => ({
    addEventListener: jest.fn(),
    close: jest.fn(),
    onerror: null,
    onopen: null,
    removeEventListener: jest.fn(),
  }),
}));

const seen: { camera: any; video: any } = { camera: null, video: null };
jest.mock('../src/capture/CameraCaptureScreen', () => ({
  CameraCaptureScreen: (props: Record<string, unknown>) => {
    const { Pressable, Text, View } = jest.requireActual('react-native');
    seen.camera = props;
    return (
      <View testID="camera-screen">
        <Pressable onPress={props.onBack as () => void} testID="camera-double-back">
          <Text>Close</Text>
        </Pressable>
        <Pressable onPress={props.onRecordClip as () => void} testID="camera-double-video">
          <Text>Video</Text>
        </Pressable>
      </View>
    );
  },
}));
jest.mock('../src/capture/VideoCaptureScreen', () => ({
  VideoCaptureScreen: (props: Record<string, unknown>) => {
    const { Pressable, Text, View } = jest.requireActual('react-native');
    seen.video = props;
    return (
      <View testID="video-capture-screen">
        <Pressable onPress={props.onBack as () => void} testID="video-double-photo">
          <Text>Photo</Text>
        </Pressable>
        <Pressable onPress={props.onClose as () => void} testID="video-double-close">
          <Text>Close</Text>
        </Pressable>
      </View>
    );
  },
}));

const response = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const DAY = 86_400_000;
const group = {
  memberId: 'profile-a',
  group: { id: 'group-a', name: 'Saturday table', role: 'owner', maxMembers: 4 },
  cycle: {
    id: 'cycle-a',
    prompt: 'A small good thing',
    startsAt: new Date(Date.now() - 3 * DAY).toISOString(),
    endsAt: new Date(Date.now() + 20 * DAY).toISOString(),
    quota: { maxCount: 5, maxSeconds: 30 },
    contributionUsage: { countUsed: 0, secondsUsed: 0 },
    contributionCount: 0,
  },
};
const ledger = (countUsed: number) => ({
  cycleId: 'cycle-a',
  memberId: 'profile-a',
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
const photoUpload = {
  contribution: {
    id: 'contribution-photo',
    cycleId: 'cycle-a',
    groupId: 'group-a',
    memberId: 'profile-a',
    durationSeconds: 3,
    createdAt: '2026-10-01T08:00:00.000Z',
  },
  existing: false,
  job: {
    id: 'job-photo',
    contributionId: 'contribution-photo',
    groupId: 'group-a',
    kind: 'clip',
    status: 'pending',
    createdAt: '2026-10-01T08:00:00.000Z',
  },
};
const metadata = {
  id: 'capture-1',
  capturedAt: '2026-10-01T08:00:00.000Z',
  format: 'jpg' as const,
  mimeType: 'image/jpeg' as const,
  width: 1200,
  height: 900,
  byteLength: 3,
  source: 'camera' as const,
};

function setup(
  options: {
    used?: () => number;
    override?: (path: string, init?: RequestInit) => Response | undefined;
  } = {},
) {
  const request = jest.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const overridden = options.override?.(path, init);
    if (overridden) return overridden;
    if (path === '/real/groups/current') return response({ group });
    if (path === '/real/groups') return response({ groups: [group] });
    if (path === '/real/groups/group-a/members')
      return response({
        group: { id: 'group-a', name: 'Saturday table' },
        members: [],
        pendingInviteCount: 0,
      });
    if (path === '/real/media/config?uploadProtocol=2') return response({ directTransfer: false });
    if (/\/reminders/.test(path)) return response({ destinations: [] });
    if (path.startsWith('/realtime/groups/'))
      return response({ events: [], nextCursor: null, watermarkEventId: 0, hasMore: false });
    if (path.startsWith('/contributions/upload/source?'))
      return response({ source: { uri: 'staged://photo-source', byteLength: 3 } }, 201);
    if (path.startsWith('/contributions/upload?')) return response({ upload: photoUpload }, 201);
    if (/^\/contributions\/jobs\/[^/]+\/process\?/.test(path))
      return response({ job: { ...photoUpload.job, status: 'ready' } });
    if (method === 'DELETE' && path.startsWith('/contributions/'))
      return response({ deleted: true });
    if (path.startsWith('/contributions?')) return response(ledger(options.used?.() ?? 0));
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  const auth = {
    authenticatedRequest: request,
    baseUrl: 'https://api.example.test',
    notice: null,
    pending: false,
    realtimeAuthorizationHeader: () => 'Bearer token',
    session: { account: { id: 'account-1', username: 'ada', displayName: 'Ada' } },
    signOut: jest.fn(),
  };
  (useRealAccount as jest.Mock).mockReturnValue(auth);
  return { request, auth };
}

async function openCamera() {
  const ui = await render(
    <ToastProvider>
      <RealAccountGroupExperience displayName="Ada" />
    </ToastProvider>,
  );
  await ui.findByTestId('real-group-home');
  await waitFor(() =>
    expect(ui.getByTestId('real-group-capture-action').props.accessibilityLabel).toMatch(/left$/),
  );
  await fireEvent.press(ui.getByTestId('real-group-capture-action'));
  await ui.findByTestId('camera-screen');
  return ui;
}
const calls = (request: jest.Mock, method: string, pattern: RegExp) =>
  request.mock.calls.filter(
    ([path, init]) => (init?.method ?? 'GET') === method && pattern.test(String(path)),
  );
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  jest.clearAllMocks();
  seen.camera = null;
  seen.video = null;
});

describe('props given to the capture screens', () => {
  it('gives the camera the group name, the ledger allowance and the three callbacks', async () => {
    setup({ used: () => 2 });
    await openCamera();
    await waitFor(() => expect(seen.camera.allowance?.countUsed).toBe(2));
    expect(seen.camera.groupName).toBe('Saturday table');
    expect(seen.camera.allowance).toEqual({
      maxCount: 5,
      maxSeconds: 30,
      countUsed: 2,
      secondsUsed: 6,
      deletionsUsed: 0,
      deletionAvailability: 'available',
    });
    for (const callback of ['onBack', 'onRecordClip', 'onSubmitPhoto', 'onDeletePhotoContribution'])
      expect(typeof seen.camera[callback]).toBe('function');
    // Nothing else is configured by the caller: the screen builds its own platform and stores.
    expect(Object.keys(seen.camera).sort()).toEqual([
      'allowance',
      'groupName',
      'onBack',
      'onDeletePhotoContribution',
      'onRecordClip',
      'onSubmitPhoto',
    ]);
  });

  it('gives the video screen the group id, the authenticated request and the transfer mode', async () => {
    const { auth } = setup();
    const ui = await openCamera();
    await fireEvent.press(ui.getByTestId('camera-double-video'));
    expect(await ui.findByTestId('video-capture-screen')).toBeTruthy();
    expect(ui.queryByTestId('camera-screen')).toBeNull();
    expect(seen.video.realAccount).toEqual({
      groupId: 'group-a',
      authenticatedRequest: auth.authenticatedRequest,
      transferMode: 'server',
    });
    expect(Object.keys(seen.video).sort()).toEqual([
      'allowance',
      'onBack',
      'onClose',
      'realAccount',
    ]);
    expect(seen.video.allowance).toMatchObject({ maxCount: 5, maxSeconds: 30 });
  });

  it('passes "direct" to the video screen when the server enables direct transfer', async () => {
    const { request } = setup({
      override: (path) =>
        path === '/real/media/config?uploadProtocol=2'
          ? response({ directTransfer: true })
          : undefined,
    });
    const ui = await openCamera();
    await fireEvent.press(ui.getByTestId('camera-double-video'));
    await ui.findByTestId('video-capture-screen');
    expect(seen.video.realAccount.transferMode).toBe('direct');
    expect(calls(request, 'GET', /^\/real\/media\/config/)).toHaveLength(1);
  });

  it('switches Photo ↔ Video inside Capture, and closes Capture from either screen', async () => {
    setup();
    const ui = await openCamera();
    await fireEvent.press(ui.getByTestId('camera-double-video'));
    await ui.findByTestId('video-capture-screen');
    await fireEvent.press(ui.getByTestId('video-double-photo'));
    expect(await ui.findByTestId('camera-screen')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('camera-double-video'));
    await ui.findByTestId('video-capture-screen');
    await fireEvent.press(ui.getByTestId('video-double-close'));
    expect(await ui.findByTestId('real-group-home')).toBeTruthy();
    expect(ui.queryByTestId('video-capture-screen')).toBeNull();

    // The last mode is remembered while the group screen stays mounted.
    await fireEvent.press(ui.getByTestId('real-group-capture-action'));
    expect(await ui.findByTestId('video-capture-screen')).toBeTruthy();
  });
});

describe('closing Capture', () => {
  it('re-reads the group and the ledger, and flashes "Sealed" on the shutter when a moment was added', async () => {
    let used = 0;
    const { request } = setup({ used: () => used });
    const ui = await openCamera();
    const before = calls(request, 'GET', /^\/contributions\?/).length;
    const groupReads = calls(request, 'GET', /^\/real\/groups\/current$/).length;
    used = 1;
    await fireEvent.press(ui.getByTestId('camera-double-back'));
    expect(await ui.findByTestId('real-group-home')).toBeTruthy();
    await waitFor(() =>
      expect(calls(request, 'GET', /^\/contributions\?/).length).toBeGreaterThan(before),
    );
    await waitFor(() =>
      expect(calls(request, 'GET', /^\/real\/groups\/current$/).length).toBeGreaterThan(groupReads),
    );
    expect(await ui.findByText('Sealed')).toBeTruthy();
    await waitFor(() =>
      expect(ui.getByTestId('real-group-capture-action').props.accessibilityLabel).toBe(
        'Add a moment · 4 of 5 left',
      ),
    );
  });
});

describe('submitting a photo from the camera', () => {
  const submit = (look?: { mode: string; clientProcessed: boolean }, replaces?: string) => {
    const progress = jest.fn();
    const result = seen.camera.onSubmitPhoto(metadata, 'AQID', progress, replaces, look);
    return { progress, result: result as Promise<Record<string, unknown>> };
  };

  it('stages the bytes, registers a 3 s photo, processes the job and reports a sealed status', async () => {
    const { request } = setup();
    await openCamera();
    const { progress, result } = submit();
    await expect(result).resolves.toEqual({
      state: 'sealed',
      contributionId: 'contribution-photo',
      jobId: 'job-photo',
      durationSeconds: 3,
      createdAt: '2026-10-01T08:00:00.000Z',
      retryable: false,
    });
    const writes = request.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(
      writes.map(([path]) => String(path)).filter((path) => path.startsWith('/contributions')),
    ).toEqual([
      '/contributions/upload/source?groupId=group-a&idempotencyKey=capture-1',
      '/contributions/upload?groupId=group-a',
      '/contributions/jobs/job-photo/process?groupId=group-a',
    ]);
    const [stage] = calls(request, 'POST', /\/upload\/source\?/);
    expect((stage[1] as RequestInit).headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(Array.from((stage[1] as RequestInit).body as unknown as Uint8Array)).toEqual([1, 2, 3]);
    expect(bodyOf(calls(request, 'POST', /\/contributions\/upload\?/)[0])).toEqual({
      mediaType: 'photo',
      idempotencyKey: 'capture-1',
      sourceUri: 'staged://photo-source',
      mimeType: 'image/jpeg',
      byteLength: 3,
      durationSeconds: 3,
      width: 1200,
      height: 900,
      hasAudio: true,
      mode: 'ccd',
      trimStartSeconds: 0,
      trimEndSeconds: 3,
    });
    // Progress is reported as queued, then processing, then the final status.
    expect(progress.mock.calls.map(([status]) => status.state)).toEqual([
      'queued',
      'processing',
      'sealed',
    ]);
    expect(progress.mock.calls[0][0]).toMatchObject({
      contributionId: 'contribution-photo',
      jobId: 'job-photo',
      durationSeconds: 3,
      retryable: true,
    });
  });

  it('keys a client-graded photo by look, and sends the look and the clientProcessed flag', async () => {
    const { request } = setup();
    await openCamera();
    await submit({ mode: 'vhs', clientProcessed: true }).result;
    expect(String(calls(request, 'POST', /\/upload\/source\?/)[0][0])).toContain(
      'idempotencyKey=capture-1-vhs',
    );
    expect(bodyOf(calls(request, 'POST', /\/contributions\/upload\?/)[0])).toMatchObject({
      idempotencyKey: 'capture-1-vhs',
      mode: 'vhs',
      clientProcessed: true,
    });
  });

  it('keeps the plain capture key for a server-graded look', async () => {
    const { request } = setup();
    await openCamera();
    await submit({ mode: '8mm', clientProcessed: false }).result;
    const body = bodyOf(calls(request, 'POST', /\/contributions\/upload\?/)[0]);
    expect(body).toMatchObject({ idempotencyKey: 'capture-1', mode: '8mm' });
    expect(body).not.toHaveProperty('clientProcessed');
  });

  it('asks the server to replace the deleted contribution when one is given', async () => {
    const { request } = setup();
    await openCamera();
    await submit(undefined, 'contribution-old').result;
    expect(bodyOf(calls(request, 'POST', /\/contributions\/upload\?/)[0])).toMatchObject({
      replacesContributionId: 'contribution-old',
    });
  });

  it('rejects with a retry message, after reporting a failed status, when the job fails', async () => {
    setup({
      override: (path) =>
        /\/process\?/.test(path)
          ? response({ job: { ...photoUpload.job, status: 'failed' } })
          : undefined,
    });
    await openCamera();
    const { progress, result } = submit();
    await expect(result).rejects.toThrow(
      'The photo could not be processed. Retry this contribution.',
    );
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'The photo could not be processed. Retry this contribution.',
    });
  });

  it('reports a processing job as still processing, without failing', async () => {
    setup({
      override: (path) =>
        /\/process\?/.test(path)
          ? response({ job: { ...photoUpload.job, status: 'processing' } })
          : undefined,
    });
    await openCamera();
    const { result } = submit();
    await expect(result).resolves.toMatchObject({ state: 'processing', retryable: false });
  });

  it('fails the submit, and registers nothing, when staging the bytes is refused', async () => {
    const { request } = setup({
      override: (path) =>
        path.startsWith('/contributions/upload/source?')
          ? response({ message: 'Storage is full.' }, 507)
          : undefined,
    });
    await openCamera();
    await expect(submit().result).rejects.toThrow('Storage is full.');
    expect(calls(request, 'POST', /\/contributions\/upload\?/)).toHaveLength(0);
  });

  it('deletes a photo contribution by id for the selected group', async () => {
    const { request } = setup();
    await openCamera();
    await act(async () => {
      await seen.camera.onDeletePhotoContribution('contribution-old');
    });
    expect(
      calls(request, 'DELETE', /^\/contributions\/contribution-old\?groupId=group-a$/),
    ).toHaveLength(1);
  });

  it('surfaces a refused delete to the camera screen', async () => {
    setup({
      override: (path, init) =>
        init?.method === 'DELETE'
          ? response({ message: 'Deletion already used.' }, 409)
          : undefined,
    });
    await openCamera();
    await expect(seen.camera.onDeletePhotoContribution('contribution-old')).rejects.toThrow(
      'Deletion already used.',
    );
  });
});
