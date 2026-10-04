import { act, fireEvent, render } from '@testing-library/react-native';
import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountGroupExperience } from '../src/groups/RealAccountGroupExperience';
import * as runtime from '../src/capture/real-account-video-runtime';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));
jest.mock('../src/capture/CameraCaptureScreen', () => ({
  CameraCaptureScreen: ({ onRecordClip }: { onRecordClip: () => void }) => {
    const { View, Pressable, Text } = jest.requireActual('react-native');
    return (
      <View testID="camera-screen">
        <Pressable onPress={onRecordClip} testID="open-video">
          <Text>Video</Text>
        </Pressable>
      </View>
    );
  },
}));
jest.mock('../src/capture/VideoCaptureScreen', () => ({
  VideoCaptureScreen: ({ realAccount }: { realAccount: { transferMode: string } }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text testID="video-transfer-mode">{realAccount.transferMode}</Text>;
  },
}));

const group = {
  memberId: 'profile-1',
  group: { id: 'group-1', name: 'Test group', role: 'owner', maxMembers: 5 },
  cycle: {
    id: 'cycle-1',
    prompt: 'Weekly moment',
    startsAt: '2026-09-28T00:00:00Z',
    endsAt: '2026-10-26T00:00:00Z',
    quota: { maxCount: 5, maxSeconds: 30 },
    contributionUsage: { countUsed: 0, secondsUsed: 0 },
    contributionCount: 0,
  },
};
const response = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;
function setup(discovery: () => Promise<Response>) {
  const request = jest.fn(async (path: string) => {
    if (path === '/real/groups/current') return response({ group });
    if (path === '/real/groups') return response({ groups: [group] });
    if (path.endsWith('/members'))
      return response({ group: group.group, members: [], pendingInviteCount: 0 });
    if (path === '/real/media/config?uploadProtocol=2') return discovery();
    return response({}, 404);
  });
  (useRealAccount as jest.Mock).mockReturnValue({
    authenticatedRequest: request,
    session: { account: { id: 'account-1' } },
    signOut: jest.fn(),
  });
  return request;
}
afterEach(() => jest.restoreAllMocks());

it.each([true, false])(
  'discovers mode only on Capture and propagates direct=%s to both media adapters',
  async (directTransfer) => {
    const request = setup(async () => response({ directTransfer }));
    const factory = jest.spyOn(runtime, 'createRealAccountVideoRuntimeClient');
    const view = await render(<RealAccountGroupExperience displayName="Owner" />);
    await view.findByTestId('real-group-home');
    expect(
      request.mock.calls.some(([path]) => path === '/real/media/config?uploadProtocol=2'),
    ).toBe(false);
    await fireEvent.press(view.getByTestId('real-group-capture-action'));
    await view.findByTestId('camera-screen');
    const transferMode = directTransfer ? 'direct' : 'server';
    expect(factory).toHaveBeenLastCalledWith(request, { transferMode });
    await fireEvent.press(view.getByTestId('open-video'));
    expect(view.getByTestId('video-transfer-mode').props.children).toBe(transferMode);
    await view.unmount();
  },
);

it('an older server without mode discovery retains the staged upload adapter', async () => {
  setup(async () => response({}, 404));
  const factory = jest.spyOn(runtime, 'createRealAccountVideoRuntimeClient');
  const view = await render(<RealAccountGroupExperience displayName="Owner" />);
  await view.findByTestId('real-group-home');
  await fireEvent.press(view.getByTestId('real-group-capture-action'));
  await view.findByTestId('camera-screen');
  expect(factory.mock.calls.at(-1)?.[1]).toEqual({ transferMode: 'server' });
});

it('late discovery after leaving the account cannot activate or retain a direct adapter', async () => {
  let resolve!: (value: Response) => void;
  setup(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const factory = jest.spyOn(runtime, 'createRealAccountVideoRuntimeClient');
  const view = await render(<RealAccountGroupExperience displayName="Owner" />);
  await view.findByTestId('real-group-home');
  await fireEvent.press(view.getByTestId('real-group-capture-action'));
  await view.unmount();
  await act(async () => resolve(response({ directTransfer: true })));
  expect(factory.mock.calls.some(([, options]) => options?.transferMode === 'direct')).toBe(false);
});

it('unauthorized discovery never silently activates capture or direct upload', async () => {
  setup(async () => response({}, 401));
  const view = await render(<RealAccountGroupExperience displayName="Owner" />);
  await view.findByTestId('real-group-home');
  await fireEvent.press(view.getByTestId('real-group-capture-action'));
  await view.findByText(
    'Capture settings are unavailable. Reconnect or sign in again, then retry.',
  );
  expect(view.queryByTestId('camera-screen')).toBeNull();
});
