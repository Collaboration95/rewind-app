import { createElement, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { CaptureMode } from '../domain/video';
import { lookPreviewStyle, RETRO_LOOKS } from './retro-looks';

// A fixed noise tile keeps the preview light: CSS moves it, with no frame loop.
const grainTile = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="3" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)" opacity=".8"/></svg>',
)}")`;

/** Web presentation only; the original captured bytes stay owned by the screen. */
export function LookPreview({
  mode,
  children,
  testID,
}: {
  mode: CaptureMode;
  children: ReactNode;
  testID?: string;
}) {
  if (Platform.OS !== 'web') return <>{children}</>;
  const spec = RETRO_LOOKS[mode];
  const overlay = {
    position: 'absolute' as const,
    inset: 0,
    pointerEvents: 'none' as const,
  };
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID={testID}>
      <View style={[StyleSheet.absoluteFill, lookPreviewStyle(mode)]}>{children}</View>
      {spec.tint
        ? createElement('div', {
            'aria-hidden': true,
            style: {
              ...overlay,
              backgroundColor: spec.tint.color,
              opacity: spec.tint.alpha,
              mixBlendMode: spec.tint.op,
            },
          })
        : null}
      {createElement('div', {
        'aria-hidden': true,
        style: {
          ...overlay,
          background: `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${spec.vignette}) 100%)`,
        },
      })}
      {createElement('div', {
        'aria-hidden': true,
        'data-rw': 'look-grain',
        style: {
          ...overlay,
          backgroundImage: grainTile,
          backgroundRepeat: 'repeat',
          opacity: spec.grain,
          mixBlendMode: 'overlay',
        },
      })}
    </View>
  );
}
