import { StyleSheet } from 'react-native';

import { FONT } from '../ui/tokens';

export const styles = StyleSheet.create({
  // A web <video> keeps its intrinsic size inside absolute insets; size it explicitly.
  fillVideo: {
    bottom: 0,
    height: '100%',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    width: '100%',
  },
  timer: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  dot: { backgroundColor: '#ff5a4a', borderRadius: 4, height: 8, opacity: 0.35, width: 8 },
  dotOn: { opacity: 1 },
  timerText: {
    color: '#fff',
    fontFamily: FONT.monoMedium,
    fontSize: 15,
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowRadius: 6,
  },
  caption: {
    color: 'rgba(255, 255, 255, 0.86)',
    fontFamily: FONT.body,
    fontSize: 13,
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowRadius: 6,
  },
  playerArea: { position: 'absolute', top: 92, left: 0, right: 0, justifyContent: 'center' },
  landscapeMedia: { width: '100%', maxHeight: '72%', flexShrink: 1, position: 'relative' },
  portraitMedia: { flex: 1, position: 'relative' },
  portraitPlayback: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  playLayer: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 22,
    backgroundColor: 'rgba(8,5,4,.82)',
  },
  playRow: { alignItems: 'center', flexDirection: 'row', gap: 22 },
  playbackTime: {
    color: '#fff',
    fontFamily: FONT.monoMedium,
    fontSize: 13,
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowRadius: 6,
  },
  retake: { flex: 1 },
  seal: { flex: 1.6 },
});
