import { useEffect, useMemo, useRef } from 'react';
import { useWindowDimensions } from 'react-native';

/**
 * The camera sensor (and a captured still) is a fixed ratio; stretching it to
 * the full screen width would distort it or, once maxHeight kicks in on a
 * wide screen, leave the box off its true ratio. Computing width and height
 * together — capped by both the available width and maxHeight — keeps the
 * frame accurate and, sized smaller than the screen, centered by its parent.
 *
 * `horizontalPadding` is the calling screen's own side padding, so the frame
 * never exceeds the width the screen actually lays it out in.
 */
export function usePreviewFrameSize({
  aspectRatio,
  horizontalPadding,
  maxHeight,
}: {
  aspectRatio: number;
  horizontalPadding: number;
  maxHeight: number;
}): { width: number; height: number } {
  const { width: windowWidth } = useWindowDimensions();
  return useMemo(() => {
    const availableWidth = Math.max(0, windowWidth - horizontalPadding * 2);
    const height = Math.min(maxHeight, availableWidth / aspectRatio);
    return { width: height * aspectRatio, height };
  }, [aspectRatio, horizontalPadding, maxHeight, windowWidth]);
}

/**
 * Asks for camera and microphone access once, as soon as a capture screen
 * finds them undecided, so the first visit shows the system prompt directly.
 * The screen's in-app "Allow" panel remains the retry path after a dismissal.
 */
export function useAutoRequestPermission(
  enabled: boolean,
  undecided: boolean,
  requestAccess: () => unknown,
): void {
  const requested = useRef(false);
  useEffect(() => {
    if (!enabled || requested.current || !undecided) return;
    requested.current = true;
    // Defer so the system prompt is requested after this render commits.
    void Promise.resolve().then(requestAccess);
  }, [enabled, requestAccess, undecided]);
}
