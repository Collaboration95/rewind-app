import { act, renderHook } from '@testing-library/react-native';
import * as ExpoNetwork from 'expo-network';
import { Platform } from 'react-native';

import { useNetworkOnline } from '../src/chat/use-network-online';

// jest.config.cjs maps `expo-network` to tests/mocks/expo-network.ts.
const network = ExpoNetwork as typeof ExpoNetwork & {
  __setNetworkState(state: { isConnected: boolean; isInternetReachable: boolean }): void;
};
const originalOS = Platform.OS;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const onlineState = { isConnected: true, isInternetReachable: true };

function setPlatform(os: string) {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os, writable: true });
}

function setNavigatorOnline(value: boolean | undefined) {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value });
}

afterEach(() => {
  setPlatform(originalOS);
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
  network.__setNetworkState(onlineState);
  jest.restoreAllMocks();
});

describe('useNetworkOnline on native platforms', () => {
  beforeEach(() => setPlatform('ios'));

  it('starts from the platform reachability state', async () => {
    network.__setNetworkState({ isConnected: false, isInternetReachable: false });
    const { result, unmount } = await renderHook(() => useNetworkOnline());

    expect(result.current).toBe(false);
    await unmount();
  });

  it('follows live connectivity changes, including connected-but-unreachable', async () => {
    const { result, unmount } = await renderHook(() => useNetworkOnline());
    expect(result.current).toBe(true);

    await act(async () =>
      network.__setNetworkState({ isConnected: false, isInternetReachable: false }),
    );
    expect(result.current).toBe(false);

    // Wi-Fi joined but captive portal / no route: still treated as offline.
    await act(async () =>
      network.__setNetworkState({ isConnected: true, isInternetReachable: false }),
    );
    expect(result.current).toBe(false);

    await act(async () => network.__setNetworkState(onlineState));
    expect(result.current).toBe(true);
    await unmount();
  });

  it('treats an unknown reachability value as online', async () => {
    jest
      .spyOn(ExpoNetwork, 'getNetworkStateAsync')
      .mockResolvedValue({ isConnected: undefined, isInternetReachable: undefined } as never);
    const { result, unmount } = await renderHook(() => useNetworkOnline());

    expect(result.current).toBe(true);
    await unmount();
  });

  it('assumes online when the initial reachability query fails', async () => {
    jest.spyOn(ExpoNetwork, 'getNetworkStateAsync').mockRejectedValue(new Error('unsupported'));
    const { result, unmount } = await renderHook(() => useNetworkOnline());

    expect(result.current).toBe(true);
    await unmount();
  });

  it('ignores a late reachability answer after unmount and removes its subscription', async () => {
    let resolveState!: (state: { isConnected: boolean; isInternetReachable: boolean }) => void;
    jest.spyOn(ExpoNetwork, 'getNetworkStateAsync').mockReturnValue(
      new Promise((resolve) => {
        resolveState = resolve;
      }) as never,
    );
    const remove = jest.fn();
    const addListener = jest
      .spyOn(ExpoNetwork, 'addNetworkStateListener')
      .mockReturnValue({ remove } as never);
    const { result, unmount } = await renderHook(() => useNetworkOnline());
    expect(addListener).toHaveBeenCalledTimes(1);

    await unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    await act(async () => resolveState({ isConnected: false, isInternetReachable: false }));

    expect(result.current).toBe(true);
  });

  it('tolerates a subscription object without remove()', async () => {
    jest.spyOn(ExpoNetwork, 'addNetworkStateListener').mockReturnValue(undefined as never);
    const { unmount } = await renderHook(() => useNetworkOnline());

    await expect(unmount()).resolves.toBeUndefined();
  });
});

/** Minimal window double: the jest-expo environment has no DOM. */
function installWindow() {
  const handlers = new Map<string, Set<() => void>>();
  const fakeWindow = {
    addEventListener: jest.fn((name: string, handler: () => void) => {
      handlers.set(name, (handlers.get(name) ?? new Set()).add(handler));
    }),
    removeEventListener: jest.fn((name: string, handler: () => void) => {
      handlers.get(name)?.delete(handler);
    }),
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  return {
    fakeWindow,
    emit: (name: string) => handlers.get(name)?.forEach((handler) => handler()),
    count: (name: string) => handlers.get(name)?.size ?? 0,
  };
}

describe('useNetworkOnline on web', () => {
  beforeEach(() => setPlatform('web'));
  afterEach(() => setNavigatorOnline(true));

  it('reads navigator.onLine and reacts to window online/offline events', async () => {
    const win = installWindow();
    setNavigatorOnline(false);
    const { result, unmount } = await renderHook(() => useNetworkOnline());
    expect(result.current).toBe(false);

    setNavigatorOnline(true);
    await act(async () => win.emit('online'));
    expect(result.current).toBe(true);

    setNavigatorOnline(false);
    await act(async () => win.emit('offline'));
    expect(result.current).toBe(false);
    await unmount();
  });

  it('treats an unknown navigator.onLine as online', async () => {
    installWindow();
    setNavigatorOnline(undefined);
    const { result, unmount } = await renderHook(() => useNetworkOnline());

    expect(result.current).toBe(true);
    await unmount();
  });

  it('removes its window listeners on unmount and stops updating', async () => {
    const win = installWindow();
    const { result, unmount } = await renderHook(() => useNetworkOnline());
    expect(win.count('online')).toBe(1);
    expect(win.count('offline')).toBe(1);

    await unmount();

    expect(win.count('online')).toBe(0);
    expect(win.count('offline')).toBe(0);
    setNavigatorOnline(false);
    win.emit('offline');
    expect(result.current).toBe(true);
  });

  it('does not consult the native network module', async () => {
    installWindow();
    const native = jest.spyOn(ExpoNetwork, 'getNetworkStateAsync');
    const { unmount } = await renderHook(() => useNetworkOnline());

    expect(native).not.toHaveBeenCalled();
    await unmount();
  });

  it('skips subscription when the window has no event API', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const native = jest.spyOn(ExpoNetwork, 'getNetworkStateAsync');
    const { result, unmount } = await renderHook(() => useNetworkOnline());

    expect(result.current).toBe(true);
    expect(native).not.toHaveBeenCalled();
    await unmount();
  });
});
