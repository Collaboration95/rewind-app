import { createElement } from 'react';
import { Platform } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { CAPTURE_MODES } from '../src/domain/video';
import { LookPreview, lookOverlays, mediaBox } from '../src/capture/LookPreview';
import { FLASH_BLOOM, RETRO_LOOKS, VIGNETTE_INNER } from '../src/capture/retro-looks';

afterEach(() => jest.restoreAllMocks());

const box = { width: 400, height: 800 };
const source = { width: 720, height: 1440 };

it.each(CAPTURE_MODES)('maps every %s preview layer to its grading spec', (mode) => {
  const spec = RETRO_LOOKS[mode];
  const layers = Object.fromEntries(
    lookOverlays(mode, box, source).map((layer) => [layer.key, layer]),
  );
  expect(layers.tint.style).toMatchObject({
    backgroundColor: spec.tint!.color,
    opacity: spec.tint!.alpha,
    mixBlendMode: spec.tint!.op,
  });
  expect(layers.vignette.style).toMatchObject({
    background: `radial-gradient(circle farthest-corner at 50% 50%, rgba(0,0,0,0) ${
      VIGNETTE_INNER * 100
    }%, rgba(0,0,0,${spec.vignette}) 100%)`,
  });
  expect(layers.grain.style).toMatchObject({
    opacity: spec.grain,
    mixBlendMode: 'overlay',
    // The 128 px tile is scaled from the sealed photo to the displayed box.
    backgroundSize: `${(128 * 400) / 720}px ${(128 * 400) / 720}px`,
  });
  expect(layers.grain.rw).toBe('look-grain');
  expect(Boolean(layers.bloom && layers.leak)).toBe(mode === 'disposable-flash');
  expect(Boolean(layers.scanlines)).toBe(mode === 'vhs');
});

it('draws the flash bloom and VHS scanlines at the sealed photo geometry', () => {
  const flash = lookOverlays('disposable-flash', box, source);
  expect(flash.find((layer) => layer.key === 'bloom')!.style.background).toBe(
    `radial-gradient(circle ${800 * FLASH_BLOOM.radius}px at 50% 45%, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0) 100%)`,
  );
  expect(flash.find((layer) => layer.key === 'leak')!.style.background).toBe(
    'linear-gradient(to left, rgba(255,110,40,0.35) 0%, rgba(255,110,40,0) 30%)',
  );
  // 1440 px photo: 4 px lines every 8 px, shown at 800/1440 scale.
  const step = (4 * 800) / 1440;
  expect(
    lookOverlays('vhs', box, source).find((layer) => layer.key === 'scanlines')!.style.background,
  ).toBe(
    `repeating-linear-gradient(to bottom, rgba(0,0,0,0.16) 0 ${step}px, transparent ${step}px ${step * 2}px)`,
  );
});

it('places overlays over the covered or contained media, not the whole frame', () => {
  const frame = { width: 402, height: 874 };
  const media = { width: 720, height: 1280 };
  const cover = mediaBox(frame, media, 'cover');
  expect(cover.height).toBe(874);
  expect(cover.width).toBeCloseTo(491.625);
  expect(cover.left).toBeCloseTo(-44.8125);
  const contain = mediaBox(frame, media, 'contain');
  expect(contain).toMatchObject({ left: 0, width: 402 });
  expect(contain.top).toBeCloseTo((874 - 714.667) / 2, 2);
  expect(mediaBox(frame, null, 'cover')).toEqual({ left: 0, top: 0, ...frame });
});

it('grades only the media layer and keeps overlays hidden from input and screen readers', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const view = await render(
    <LookPreview mode="vhs" testID="look">
      {createElement('video', { testID: 'media' })}
    </LookPreview>,
  );
  await fireEvent(view.getByTestId('look'), 'layout', {
    nativeEvent: { layout: { width: 402, height: 874 } },
  });
  const media = view.getByTestId('media').parent!;
  expect(media.props.style).toContainEqual({ filter: RETRO_LOOKS.vhs.filter });
  type Node = { type: string; props: Record<string, unknown>; children: Node[] | null };
  const divs: Node[] = [];
  const walk = (node: Node | string) => {
    if (typeof node === 'string') return;
    if (node.type === 'div') divs.push(node);
    node.children?.forEach(walk);
  };
  walk(view.toJSON() as unknown as Node);
  const [overlay, ...layers] = divs;
  expect(overlay.props['aria-hidden']).toBe(true);
  expect(overlay.props.style).toMatchObject({ pointerEvents: 'none', width: 402 });
  expect(layers.map((layer) => layer.props['data-rw'] ?? null)).toEqual([
    null,
    null,
    null,
    'look-grain',
  ]);
  for (const layer of layers) expect(layer.props.style).toMatchObject({ pointerEvents: 'none' });
});

it('keeps the owned native camera surface intact', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  const view = await render(<LookPreview mode="ccd">{createElement('CameraView')}</LookPreview>);
  expect(view.toJSON()).toMatchObject({ type: 'CameraView' });
});
