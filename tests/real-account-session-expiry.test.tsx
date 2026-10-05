import { act, fireEvent, render } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';

import { RealAccountProvider, useRealAccount } from '../src/auth/RealAccountProvider';
import { AuthRequestError } from '../src/auth/real-account-client';

const mockClient = {
  restore: jest.fn(),
  login: jest.fn(),
  request: jest.fn(),
  logout: jest.fn().mockResolvedValue(undefined),
  clearStoredToken: jest.fn().mockResolvedValue(undefined),
  canConnectSecurely: () => true,
  realtimeAuthorizationHeader: () => undefined,
};
jest.mock('../src/auth/real-account-client', () => ({
  ...jest.requireActual('../src/auth/real-account-client'),
  RealAccountClient: jest.fn(() => mockClient),
}));
jest.mock('../src/auth/sign-out-marker', () => ({
  signOutMarkerStore: {
    read: async () => null,
    write: async () => undefined,
    clear: async () => undefined,
  },
}));
const account = {
  id: 'one',
  username: 'one',
  displayName: 'One',
  createdAt: 'time',
  updatedAt: 'time',
};
function Probe() {
  const auth = useRealAccount();
  return (
    <View>
      <Text testID="state">{auth.state}</Text>
      <Pressable testID="sign-in" onPress={() => void auth.signIn('one', 'password')}>
        <Text>Sign in</Text>
      </Pressable>
      <Pressable
        testID="request"
        onPress={() => void auth.authenticatedRequest('/real/groups').catch(() => undefined)}
      >
        <Text>Request</Text>
      </Pressable>
    </View>
  );
}
async function mount() {
  const result = await render(
    <RealAccountProvider baseUrl="https://rewind.example">
      <Probe />
    </RealAccountProvider>,
  );
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  return result;
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockClient.request.mockResolvedValue({ status: 200, ok: true });
});
afterEach(() => jest.useRealTimers());

test('successful requests keep a restored session active beyond its initial idle expiry', async () => {
  mockClient.restore.mockResolvedValue({
    account,
    idleExpiresAt: new Date(Date.now() + 1000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 100_000).toISOString(),
  });
  const result = await mount();
  await fireEvent.press(result.getByTestId('request'));
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  await fireEvent.press(result.getByTestId('request'));
  expect(result.getByTestId('state').props.children).toBe('active');
  expect(mockClient.request).toHaveBeenCalledTimes(2);
  expect(mockClient.logout).not.toHaveBeenCalled();
  mockClient.request.mockRejectedValue(new AuthRequestError(401, 'expired'));
  await fireEvent.press(result.getByTestId('request'));
  expect(result.getByTestId('state').props.children).toBe('entry');
});

test('login idle expiry is not invented as an absolute expiry', async () => {
  mockClient.restore.mockResolvedValue(null);
  mockClient.login.mockResolvedValue({
    account,
    token: 't'.repeat(43),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  });
  const result = await mount();
  await fireEvent.press(result.getByTestId('sign-in'));
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  await fireEvent.press(result.getByTestId('request'));
  expect(result.getByTestId('state').props.children).toBe('active');
  expect(mockClient.logout).not.toHaveBeenCalled();
});

test('a supplied absolute expiry still ends the session', async () => {
  mockClient.restore.mockResolvedValue({
    account,
    idleExpiresAt: new Date(Date.now() + 1000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 3000).toISOString(),
  });
  const result = await mount();
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(result.getByTestId('state').props.children).toBe('entry');
});

test('absolute expiries beyond the JS timer range are scheduled in bounded steps', async () => {
  const lifetime = 30 * 24 * 60 * 60 * 1000;
  mockClient.restore.mockResolvedValue({
    account,
    idleExpiresAt: new Date(Date.now() + 1000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + lifetime).toISOString(),
  });
  const result = await mount();
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(result.getByTestId('state').props.children).toBe('active');
  await act(async () => {
    jest.advanceTimersByTime(lifetime - 2000);
  });
  expect(result.getByTestId('state').props.children).toBe('entry');
});
