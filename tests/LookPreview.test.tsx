import { createElement, type ReactElement } from 'react';
import { Platform } from 'react-native';
import { CAPTURE_MODES } from '../src/domain/video';
import { LookPreview } from '../src/capture/LookPreview';
import { RETRO_LOOKS } from '../src/capture/retro-looks';

type Layer = ReactElement<{
  children?: unknown;
  style: Record<string, unknown> | Record<string, unknown>[];
  'aria-hidden'?: boolean;
  'data-rw'?: string;
}>;

afterEach(() => jest.restoreAllMocks());

it.each(CAPTURE_MODES)('maps every %s preview layer to its grading spec', (mode) => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const source = createElement('video');
  const preview = LookPreview({ mode, children: source }) as ReactElement<{ children: Layer[] }>;
  const [media, tint, vignette, grain] = preview.props.children;
  const spec = RETRO_LOOKS[mode];

  expect(media.props.children).toBe(source);
  expect(media.props.style).toContainEqual({ filter: spec.filter });
  expect(tint.props.style).toMatchObject({
    backgroundColor: spec.tint!.color,
    opacity: spec.tint!.alpha,
    mixBlendMode: spec.tint!.op,
  });
  expect(vignette.props.style).toMatchObject({
    background: `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${spec.vignette}) 100%)`,
  });
  expect(grain.props.style).toMatchObject({ opacity: spec.grain, mixBlendMode: 'overlay' });
  expect(grain.props['data-rw']).toBe('look-grain');
  for (const layer of [tint, vignette, grain]) {
    expect(layer.props['aria-hidden']).toBe(true);
    expect(layer.props.style).toMatchObject({ pointerEvents: 'none' });
  }
});

it('keeps the owned native camera surface intact', () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  const source = createElement('CameraView');
  const preview = LookPreview({ mode: 'ccd', children: source });
  expect(preview.props.children).toBe(source);
});
