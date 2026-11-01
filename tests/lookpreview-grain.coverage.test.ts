type LookModule = typeof import('../src/capture/LookPreview');

const box = { width: 300, height: 600 };
const source = { width: 600, height: 1200 };

/** Loads a fresh copy of the module, because the grain tile is cached per module. */
function freshModule(): LookModule {
  let loaded!: LookModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs require
    loaded = require('../src/capture/LookPreview') as LookModule;
  });
  return loaded;
}

const grainBackground = (module: LookModule) =>
  module.lookOverlays('ccd', box, source).find((layer) => layer.key === 'grain')!.style
    .backgroundImage;

function installCanvas(
  options: { context?: ReturnType<typeof makeContext> | null; throws?: boolean } = {},
) {
  const context = options.context === undefined ? makeContext() : options.context;
  const canvas = {
    width: 0,
    height: 0,
    getContext: jest.fn(() => context),
    toDataURL: jest.fn((type: string) => {
      if (options.throws) throw new Error('tainted canvas');
      return `data:${type};base64,R1JBSU4=`;
    }),
  };
  const createElement = jest.fn(() => canvas);
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement } });
  return { canvas, context, createElement };
}

function makeContext() {
  return {
    createImageData: jest.fn((width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    })),
    putImageData: jest.fn(),
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

describe('LookPreview grain tile', () => {
  it('builds the same 128 px grey noise tile the sealed photo uses, as a CSS image', () => {
    const { canvas, context } = installCanvas();

    const background = grainBackground(freshModule());

    expect(background).toBe('url("data:image/png;base64,R1JBSU4=")');
    expect(canvas.width).toBe(128);
    expect(canvas.height).toBe(128);
    expect(context!.createImageData).toHaveBeenCalledWith(128, 128);
    const [image] = context!.putImageData.mock.calls[0];
    const grey = image.data[0];
    expect(grey).toBeGreaterThanOrEqual(28);
    expect(grey).toBeLessThanOrEqual(228);
    expect(image.data[3]).toBe(255);
  });

  it('draws the tile once and reuses it for every later overlay', () => {
    const { createElement } = installCanvas();
    const module = freshModule();

    const first = grainBackground(module);
    const second = grainBackground(module);

    expect(second).toBe(first);
    expect(createElement).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the canvas has no 2D context', () => installCanvas({ context: null })],
    ['the canvas cannot be exported', () => installCanvas({ throws: true })],
    [
      'there is no canvas support at all',
      () => {
        Object.defineProperty(globalThis, 'document', {
          configurable: true,
          value: {
            createElement: () => {
              throw new Error('unsupported');
            },
          },
        });
      },
    ],
  ])('leaves the preview without grain when %s', (_name, setup) => {
    setup();
    const module = freshModule();

    expect(grainBackground(module)).toBe('none');
    // The failure is remembered rather than retried on every render.
    const retry = installCanvas();
    expect(grainBackground(module)).toBe('none');
    expect(retry.createElement).not.toHaveBeenCalled();
  });
});
