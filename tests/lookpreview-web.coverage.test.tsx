import { createElement, createRef } from 'react';
import { Platform, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

import { LookPreview } from '../src/capture/LookPreview';

/** The class the jest View mock renders; instances are what `ref.current` points at. */
async function hostClass(): Promise<{ prototype: Record<string, unknown> }> {
  const ref = createRef<object>();
  await render(<View ref={ref as never} />);
  return (ref.current as object).constructor as unknown as { prototype: Record<string, unknown> };
}

describe('LookPreview media measurement on web', () => {
  let host: Awaited<ReturnType<typeof hostClass>>;
  let media: unknown;
  const listeners = new Map<string, Set<() => void>>();
  const querySelector = jest.fn(() => media);
  const addEventListener = jest.fn((name: string, listener: () => void, capture: boolean) => {
    expect(capture).toBe(true);
    listeners.set(name, (listeners.get(name) ?? new Set()).add(listener));
  });
  const removeEventListener = jest.fn((name: string, listener: () => void) => {
    listeners.get(name)?.delete(listener);
  });
  const originalVideo = globalThis.HTMLVideoElement;
  const originalImage = globalThis.HTMLImageElement;

  class FakeVideo {
    constructor(
      public videoWidth: number,
      public videoHeight: number,
    ) {}
  }
  class FakeImage {
    constructor(
      public naturalWidth: number,
      public naturalHeight: number,
    ) {}
  }

  beforeAll(async () => {
    host = await hostClass();
  });

  beforeEach(() => {
    listeners.clear();
    media = null;
    Object.assign(host.prototype, { querySelector, addEventListener, removeEventListener });
    Object.defineProperty(globalThis, 'HTMLVideoElement', { configurable: true, value: FakeVideo });
    Object.defineProperty(globalThis, 'HTMLImageElement', { configurable: true, value: FakeImage });
    jest.replaceProperty(Platform, 'OS', 'web');
  });

  afterEach(async () => {
    // Unmount while the fake DOM methods still exist; the effect cleanup calls them.
    await mounted?.unmount();
    mounted = undefined;
    for (const key of ['querySelector', 'addEventListener', 'removeEventListener']) {
      Reflect.deleteProperty(host.prototype, key);
    }
    Object.defineProperty(globalThis, 'HTMLVideoElement', {
      configurable: true,
      value: originalVideo,
    });
    Object.defineProperty(globalThis, 'HTMLImageElement', {
      configurable: true,
      value: originalImage,
    });
    jest.restoreAllMocks();
  });

  let mounted: Awaited<ReturnType<typeof render>> | undefined;

  async function mount() {
    const view = await render(
      <LookPreview fit="cover" mode="ccd" testID="look">
        {createElement('video', { testID: 'media' })}
      </LookPreview>,
    );
    await fireEvent(view.getByTestId('look'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 800 } },
    });
    mounted = view;
    return view;
  }

  const overlayStyle = (view: Awaited<ReturnType<typeof mount>>) => {
    const root = view.toJSON() as unknown as { children: { type: string; props: any }[] };
    return root.children.find((child) => child.type === 'div')?.props.style as
      Record<string, number> | undefined;
  };

  it('sizes the overlay to the video as drawn once its metadata is known', async () => {
    media = new FakeVideo(1000, 500); // landscape in a portrait frame, covered
    const view = await mount();

    // cover: scale = max(400/1000, 800/500) = 1.6 -> 1600 x 800, centred horizontally.
    expect(overlayStyle(view)).toMatchObject({ left: -600, top: 0, width: 1600, height: 800 });
  });

  it('sizes the overlay to a still image from its natural size', async () => {
    media = new FakeImage(400, 200);
    const view = await mount();

    expect(overlayStyle(view)).toMatchObject({ width: 1600, height: 800 });
  });

  it('falls back to the whole frame while the media has no dimensions', async () => {
    media = new FakeVideo(0, 0);
    const view = await mount();
    expect(overlayStyle(view)).toMatchObject({ left: 0, top: 0, width: 400, height: 800 });

    media = null; // no media element at all
    await act(async () => listeners.get('loadedmetadata')!.forEach((listener) => listener()));
    expect(overlayStyle(view)).toMatchObject({ left: 0, top: 0, width: 400, height: 800 });

    media = {}; // some other element type
    await act(async () => listeners.get('load')!.forEach((listener) => listener()));
    expect(overlayStyle(view)).toMatchObject({ width: 400, height: 800 });
  });

  it('re-measures when the video reports metadata or resizes', async () => {
    media = new FakeVideo(0, 0);
    const view = await mount();
    expect([...listeners.keys()].sort()).toEqual(['load', 'loadedmetadata', 'resize']);

    media = new FakeVideo(400, 800);
    await act(async () => listeners.get('loadedmetadata')!.forEach((listener) => listener()));
    expect(overlayStyle(view)).toMatchObject({ left: 0, top: 0, width: 400, height: 800 });

    media = new FakeVideo(800, 800);
    await act(async () => listeners.get('resize')!.forEach((listener) => listener()));
    expect(overlayStyle(view)).toMatchObject({ left: -200, width: 800, height: 800 });
  });

  it('stops listening for media events on unmount', async () => {
    const view = await mount();
    expect(listeners.get('resize')!.size).toBe(1);

    mounted = undefined;
    await view.unmount();

    expect(removeEventListener).toHaveBeenCalledTimes(3);
    for (const names of listeners.values()) expect(names.size).toBe(0);
  });

  it('does not touch the DOM on native', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await render(<LookPreview mode="vhs">{createElement('CameraView')}</LookPreview>);
    expect(querySelector).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
