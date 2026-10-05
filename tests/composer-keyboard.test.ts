import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { useComposerKeyboard } from '../src/chat/use-composer-keyboard';

it('requires focus and a height drop over 150 px, follows viewport panning, restores on blur, and cleans up listeners', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalOS = Platform.OS;
  const listeners: Record<string, () => void> = {};
  const windowListeners: Record<string, () => void> = {};
  const viewport = {
    height: 667,
    offsetTop: 0,
    addEventListener: jest.fn((event, listener) => {
      listeners[event] = listener;
    }),
    removeEventListener: jest.fn(),
  };
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerHeight: 667,
      visualViewport: viewport,
      addEventListener: jest.fn((event, listener) => {
        windowListeners[event] = listener;
      }),
      removeEventListener: jest.fn(),
    },
  });
  try {
    const hook = await renderHook<ReturnType<typeof useComposerKeyboard>, { active: boolean }>(
      ({ active }) => useComposerKeyboard(active),
      {
        initialProps: { active: true },
      },
    );
    await act(() => {
      viewport.height = 400;
      listeners.resize();
    });
    expect(hook.result.current.keyboardOpen).toBe(false);
    await act(() => hook.result.current.onFocus());
    expect(hook.result.current.keyboardOpen).toBe(true);
    expect(hook.result.current.height).toBe(400);
    await act(() => {
      viewport.offsetTop = 180;
      listeners.scroll();
    });
    expect(hook.result.current.offsetTop).toBe(180);
    expect(hook.result.current.keyboardOpen).toBe(true);
    await act(() => {
      viewport.offsetTop = 220;
      windowListeners.scroll();
    });
    expect(hook.result.current.offsetTop).toBe(220);
    await act(() => {
      viewport.height = 517;
      listeners.resize();
    });
    expect(hook.result.current.keyboardOpen).toBe(false);
    await act(() => {
      viewport.height = 516;
      listeners.resize();
    });
    expect(hook.result.current.keyboardOpen).toBe(true);
    await hook.rerender({ active: false });
    expect(hook.result.current.keyboardOpen).toBe(false);
    await hook.rerender({ active: true });
    await act(() => hook.result.current.onBlur());
    expect(hook.result.current.keyboardOpen).toBe(false);
    await hook.unmount();
    expect(viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(viewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(window.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  } finally {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});
