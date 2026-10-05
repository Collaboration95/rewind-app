import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

/** Mobile web keyboards reduce the visual viewport while the layout stays tall. */
export function useComposerKeyboard(active: boolean) {
  const [focused, setFocused] = useState(false);
  const [viewportState, setViewportState] = useState<{ height: number; reduced: boolean } | null>(
    null,
  );
  const fullHeight = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => {
      if (!focused) fullHeight.current = Math.max(window.innerHeight, viewport.height);
      else fullHeight.current = Math.max(fullHeight.current, window.innerHeight);
      setViewportState({
        height: viewport.height,
        reduced: fullHeight.current - viewport.height > 150,
      });
    };
    resize();
    viewport.addEventListener('resize', resize);
    return () => viewport.removeEventListener('resize', resize);
  }, [focused]);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  const keyboardOpen = active && focused && viewportState?.reduced === true;
  return { keyboardOpen, height: viewportState?.height ?? null, onFocus, onBlur };
}
