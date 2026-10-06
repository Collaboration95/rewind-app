import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { CaptureMode } from '../domain/video';
import { MAX_RETRO_PHOTO_EDGE } from './retro-browser';
import {
  createRandom,
  fillNoise,
  fitWithin,
  FLASH_BLOOM,
  FLASH_LEAK,
  lookPreviewStyle,
  NOISE_TILE_SIZE,
  RETRO_LOOKS,
  SCANLINE_ALPHA,
  scanlineStep,
  VIGNETTE_INNER,
} from './retro-looks';

interface Size {
  width: number;
  height: number;
}

let grainTile: string | null | undefined;

/** The same grey noise the sealing canvas uses, built once as a CSS tile. */
function grainImage(): string | null {
  if (grainTile !== undefined) return grainTile;
  grainTile = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = NOISE_TILE_SIZE;
    canvas.height = NOISE_TILE_SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const image = ctx.createImageData(NOISE_TILE_SIZE, NOISE_TILE_SIZE);
      fillNoise(image.data, createRandom(1));
      ctx.putImageData(image, 0, 0);
      grainTile = `url("${canvas.toDataURL('image/png')}")`;
    }
  } catch {
    // No canvas (tests, very old browsers): the preview simply has no grain.
  }
  return grainTile;
}

/** Where the media is drawn inside the frame, so overlays use the sealed photo's geometry. */
export function mediaBox(frame: Size, media: Size | null, fit: 'cover' | 'contain') {
  if (!media || !(media.width > 0) || !(media.height > 0)) {
    return { left: 0, top: 0, ...frame };
  }
  const scale = (fit === 'cover' ? Math.max : Math.min)(
    frame.width / media.width,
    frame.height / media.height,
  );
  const width = media.width * scale;
  const height = media.height * scale;
  return { left: (frame.width - width) / 2, top: (frame.height - height) / 2, width, height };
}

function intrinsicSize(root: HTMLElement): Size | null {
  const media = root.querySelector('video, img');
  if (media instanceof HTMLVideoElement && media.videoWidth > 0) {
    return { width: media.videoWidth, height: media.videoHeight };
  }
  if (media instanceof HTMLImageElement && media.naturalWidth > 0) {
    return { width: media.naturalWidth, height: media.naturalHeight };
  }
  return null;
}

/** CSS layers that mirror `drawRetroFrame`'s overlays for a box of `width`×`height`. */
export function lookOverlays(mode: CaptureMode, box: Size, source: Size) {
  const spec = RETRO_LOOKS[mode];
  const { width, height } = box;
  const layers: { key: string; style: Record<string, unknown>; rw?: string }[] = [];
  if (spec.tint) {
    layers.push({
      key: 'tint',
      style: {
        backgroundColor: spec.tint.color,
        opacity: spec.tint.alpha,
        mixBlendMode: spec.tint.op,
      },
    });
  }
  if (mode === 'disposable-flash') {
    const stops = (list: readonly (readonly [number, string])[]) =>
      list.map(([offset, color]) => `${color} ${offset * 100}%`).join(', ');
    const radius = Math.max(width, height) * FLASH_BLOOM.radius;
    layers.push({
      key: 'bloom',
      style: {
        background: `radial-gradient(circle ${radius}px at 50% ${FLASH_BLOOM.centerY * 100}%, ${stops(
          FLASH_BLOOM.stops,
        )})`,
        mixBlendMode: 'screen',
      },
    });
    layers.push({
      key: 'leak',
      style: {
        background: `linear-gradient(to left, ${stops(
          FLASH_LEAK.stops.map(([offset, color]) => [offset * FLASH_LEAK.width, color] as const),
        )})`,
        mixBlendMode: 'screen',
      },
    });
  }
  if (mode === 'vhs') {
    const step = (scanlineStep(source.height) * height) / source.height;
    layers.push({
      key: 'scanlines',
      style: {
        background: `repeating-linear-gradient(to bottom, rgba(0,0,0,${SCANLINE_ALPHA}) 0 ${step}px, transparent ${step}px ${step * 2}px)`,
      },
    });
  }
  if (spec.vignette > 0) {
    layers.push({
      key: 'vignette',
      style: {
        background: `radial-gradient(circle farthest-corner at 50% 50%, rgba(0,0,0,0) ${
          VIGNETTE_INNER * 100
        }%, rgba(0,0,0,${spec.vignette}) 100%)`,
      },
    });
  }
  const tile = (NOISE_TILE_SIZE * width) / source.width;
  layers.push({
    key: 'grain',
    rw: 'look-grain',
    style: {
      backgroundImage: grainImage() ?? 'none',
      backgroundRepeat: 'repeat',
      backgroundSize: `${tile}px ${tile}px`,
      opacity: spec.grain,
      mixBlendMode: 'overlay',
    },
  });
  return layers;
}

/** Web presentation only; the original captured bytes stay owned by the screen. */
export function LookPreview({
  mode,
  children,
  fit = 'cover',
  testID,
}: {
  mode: CaptureMode;
  children: ReactNode;
  /** How the child media fills this frame (its CSS object-fit). */
  fit?: 'cover' | 'contain';
  testID?: string;
}) {
  const ref = useRef<View>(null);
  const [frame, setFrame] = useState<Size>({ width: 0, height: 0 });
  const [media, setMedia] = useState<Size | null>(null);
  const web = Platform.OS === 'web';

  useEffect(() => {
    const root = ref.current as unknown as HTMLElement | null;
    if (!web || !root?.querySelector) return;
    const update = () => {
      const next = intrinsicSize(root);
      setMedia((current) =>
        current?.width === next?.width && current?.height === next?.height ? current : next,
      );
    };
    update();
    // Media events do not bubble, but they do pass through capture listeners.
    const events = ['loadedmetadata', 'resize', 'load'];
    for (const name of events) root.addEventListener(name, update, true);
    return () => {
      for (const name of events) root.removeEventListener(name, update, true);
    };
  }, [web]);

  if (!web) return <>{children}</>;
  const box = mediaBox(frame, media, fit);
  // The sealed photo is graded at its own size; scale per-pixel details from it.
  const source = media ? fitWithin(media.width, media.height, MAX_RETRO_PHOTO_EDGE) : box;
  const overlay = { position: 'absolute' as const, inset: 0, pointerEvents: 'none' as const };
  return (
    <View
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setFrame((current) =>
          current.width === width && current.height === height ? current : { width, height },
        );
      }}
      pointerEvents="box-none"
      ref={ref}
      // Clip without a stacking context, so overlay blend modes still reach the media.
      style={[StyleSheet.absoluteFill, styles.clip]}
      testID={testID}
    >
      <View style={[StyleSheet.absoluteFill, lookPreviewStyle(mode)]}>{children}</View>
      {box.width > 0 && box.height > 0
        ? createElement(
            'div',
            {
              'aria-hidden': true,
              style: {
                pointerEvents: 'none',
                position: 'absolute',
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              },
            },
            lookOverlays(mode, box, source).map((layer) =>
              createElement('div', {
                key: layer.key,
                'data-rw': layer.rw,
                style: { ...overlay, ...layer.style },
              }),
            ),
          )
        : null}
    </View>
  );
}

const styles = StyleSheet.create({ clip: { overflow: 'hidden' } });
