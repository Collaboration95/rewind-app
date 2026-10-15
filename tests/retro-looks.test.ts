import { CAPTURE_MODES, type CaptureMode } from '../src/domain/video';
import {
  RETRO_LOOKS,
  lookPreviewStyle,
  createRandom,
  drawRetroFrame,
  fillNoise,
  fitWithin,
  formatCcdDateStamp,
  formatVhsDate,
  formatVhsTime,
  seedFromString,
  type RetroFrame,
} from '../src/capture/retro-looks';

interface Call {
  method: string;
  args: unknown[];
  state: { filter: string; fillStyle: unknown; composite: string; alpha: number };
}

/** Records every 2D call with the drawing state it was made under. */
function recordingContext(withFilter = true) {
  const calls: Call[] = [];
  const state = {
    filter: 'none',
    fillStyle: '#000' as unknown,
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
  };
  const stack: (typeof state)[] = [];
  const gradient = () => ({ addColorStop: jest.fn() });
  const target: Record<string, unknown> = {
    canvas: { tag: 'scratch-canvas' },
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    createRadialGradient: gradient,
    createLinearGradient: gradient,
  };
  const ctx = new Proxy(target, {
    get(object, key: string) {
      if (key in object) return object[key];
      if (key === 'filter') return withFilter ? state.filter : undefined;
      if (key in state) return state[key as keyof typeof state];
      return (...args: unknown[]) =>
        calls.push({
          method: key,
          args,
          state: {
            filter: state.filter,
            fillStyle: state.fillStyle,
            composite: state.globalCompositeOperation,
            alpha: state.globalAlpha,
          },
        });
    },
    set(_object, key: string, value) {
      if (key === 'filter' && !withFilter) return true;
      (state as Record<string, unknown>)[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function frame(overrides: Partial<RetroFrame> = {}): RetroFrame {
  return {
    width: 720,
    height: 1280,
    time: 0,
    random: createRandom(7),
    capturedAt: new Date(2026, 9, 4, 15, 7, 9),
    supportsFilter: true,
    moving: false,
    noise: { tag: 'noise' } as unknown as CanvasImageSource,
    ...overrides,
  };
}

const source = { tag: 'source' } as unknown as CanvasImageSource;

describe('retro looks', () => {
  it('defines four distinct original looks', () => {
    expect(Object.keys(RETRO_LOOKS).sort()).toEqual([...CAPTURE_MODES].sort());
    const filters = new Set(CAPTURE_MODES.map((mode) => RETRO_LOOKS[mode].filter));
    expect(filters.size).toBe(4);
  });

  it('caps size without upscaling and keeps even dimensions', () => {
    expect(fitWithin(4032, 3024, 2160)).toEqual({ width: 2160, height: 1620 });
    expect(fitWithin(1080, 1920, 1920, 1080)).toEqual({ width: 1080, height: 1920 });
    expect(fitWithin(2160, 3840, 1920, 1080)).toEqual({ width: 1080, height: 1920 });
    expect(fitWithin(3840, 2160, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithin(361, 641, 2160)).toEqual({ width: 360, height: 640 });
    expect(() => fitWithin(0, 10, 100)).toThrow();
  });

  it('uses a deterministic seeded random source and neutral grain', () => {
    const first = createRandom(seedFromString('capture-1|ccd'));
    const second = createRandom(seedFromString('capture-1|ccd'));
    const values = Array.from({ length: 5 }, first);
    expect(Array.from({ length: 5 }, second)).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(seedFromString('a')).not.toBe(seedFromString('b'));
    const data = new Uint8ClampedArray(4 * 500);
    fillNoise(data, createRandom(1));
    const greys = Array.from({ length: 500 }, (_, index) => data[index * 4]);
    expect(Math.min(...greys)).toBeGreaterThanOrEqual(28);
    expect(Math.max(...greys)).toBeLessThanOrEqual(228);
    const mean = greys.reduce((sum, value) => sum + value, 0) / greys.length;
    expect(Math.abs(mean - 128)).toBeLessThan(10);
    expect(data[3]).toBe(255);
    expect(data[1]).toBe(data[0]);
  });

  it('formats period date imprints', () => {
    const date = new Date(2026, 9, 4, 15, 7, 9);
    expect(formatCcdDateStamp(date)).toBe("'26 10 04");
    expect(formatVhsDate(date)).toBe('OCT. 04 2026');
    expect(formatVhsTime(date)).toBe('PM 3:07:09');
    expect(formatVhsTime(new Date(2026, 0, 1, 0, 5, 0))).toBe('AM 12:05:00');
  });

  it.each(CAPTURE_MODES)('%s grades the source through ctx.filter and adds grain', (mode) => {
    const { ctx, calls } = recordingContext();
    drawRetroFrame(ctx, source, mode, frame());
    const sourceDraw = calls.find((call) => call.method === 'drawImage' && call.args[0] === source);
    expect(sourceDraw?.state.filter).toBe(RETRO_LOOKS[mode].filter);
    expect(
      calls.some(
        (call) =>
          call.method === 'drawImage' &&
          (call.args[0] as { tag?: string }).tag === 'noise' &&
          call.state.composite === 'overlay',
      ),
    ).toBe(true);
    // The filter never leaks into the overlays drawn afterwards.
    const later = calls.slice(calls.indexOf(sourceDraw!) + 1);
    expect(later.every((call) => call.state.filter === 'none')).toBe(true);
  });

  it('falls back to blend-mode washes where ctx.filter is unsupported', () => {
    const { ctx, calls } = recordingContext(false);
    drawRetroFrame(ctx, source, '8mm', frame({ supportsFilter: false }));
    const washes = calls.filter(
      (call) =>
        call.method === 'fillRect' && ['saturation', 'color'].includes(call.state.composite),
    );
    expect(washes.map((call) => call.state.composite)).toEqual(['saturation', 'color']);
  });

  const texts = (mode: CaptureMode, overrides: Partial<RetroFrame> = {}) => {
    const { ctx, calls } = recordingContext();
    drawRetroFrame(ctx, source, mode, frame(overrides));
    return calls.filter((call) => call.method === 'fillText');
  };

  it('stamps an orange date only on the compact-digital look', () => {
    const [stamp, ...rest] = texts('ccd');
    expect(rest).toHaveLength(0);
    expect(stamp.args[0]).toBe("'26 10 04");
    expect(stamp.state.fillStyle).toBe('#ff9a2e');
    expect(texts('disposable-flash')).toHaveLength(0);
    expect(texts('8mm')).toHaveLength(0);
  });

  it('draws a running camcorder clock, scanlines and chroma fringes for VHS', () => {
    const scratch = recordingContext();
    const { ctx, calls } = recordingContext();
    drawRetroFrame(ctx, source, 'vhs', frame({ moving: true, time: 2, scratch: scratch.ctx }));
    expect(calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])).toEqual([
      'PLAY ▶',
      'SP',
      'PM 3:07:11',
      'OCT. 04 2026',
    ]);
    const scanlines = calls.filter(
      (call) =>
        call.method === 'fillRect' &&
        call.state.fillStyle === '#000000' &&
        call.state.alpha === 0.16,
    );
    expect(scanlines.length).toBeGreaterThan(100);
    const fringes = calls.filter(
      (call) => call.method === 'drawImage' && call.state.composite === 'lighten',
    );
    expect(fringes.map((call) => call.args[1])).toEqual([3, -3]);
    expect(
      scratch.calls
        .filter((call) => call.method === 'fillRect')
        .map((call) => call.state.fillStyle),
    ).toEqual(['#ff0000', '#0000ff']);
  });

  it('adds a flash bloom and light leak for the disposable look', () => {
    const { ctx, calls } = recordingContext();
    drawRetroFrame(ctx, source, 'disposable-flash', frame());
    expect(
      calls.filter((call) => call.method === 'fillRect' && call.state.composite === 'screen'),
    ).toHaveLength(2);
  });

  it('adds dust and, for moving film, flicker and gate weave on 8mm', () => {
    const still = recordingContext();
    drawRetroFrame(still.ctx, source, '8mm', frame({ random: () => 0.5 }));
    expect(still.calls.filter((call) => call.method === 'arc')).not.toHaveLength(0);
    const moving = recordingContext();
    drawRetroFrame(moving.ctx, source, '8mm', frame({ moving: true, random: () => 0.9 }));
    const draw = moving.calls.find(
      (call) => call.method === 'drawImage' && call.args[0] === source,
    );
    expect(draw?.args[2]).not.toBe(0);
  });
});

it.each(CAPTURE_MODES)('live %s grading uses the final-file spec', (mode) => {
  expect(lookPreviewStyle(mode)).toEqual({ filter: RETRO_LOOKS[mode].filter });
});
