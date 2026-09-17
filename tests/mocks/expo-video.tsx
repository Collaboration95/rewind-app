import type { ComponentProps } from 'react';
import { View } from 'react-native';

type MockVideoViewProps = ComponentProps<typeof View> & { testID?: string };

/** Native playback is exercised on-device; Jest only needs an inspectable view. */
export function VideoView({ testID, ...props }: MockVideoViewProps) {
  return <View {...props} testID={testID} />;
}

export function useVideoPlayer(source: string) {
  return { source, loop: false };
}
