import type { CaptureMode } from '../domain/video';

/**
 * Pure drawing logic for the four original retro looks. It only issues 2D
 * canvas calls on the context it is given, so the same code grades a still
 * photo once and every frame of a video, and unit tests can drive it with a
 * recording fake. The browser pipeline lives in `retro-browser.ts`.
 */

type Composite = GlobalCompositeOperation;

interface ColorWash {
  op: Composite;
  color: string;
  alpha: number;
}

export interface RetroLookSpec {
  /** CSS filter used when the canvas supports `ctx.filter`. */
  filter: string;
  /** Blend-mode approximation of `filter` for canvases without `ctx.filter`. */
  fallback: readonly ColorWash[];
  /** Colour cast applied on top of either grading path. */
  tint: ColorWash | null;
  /** Opacity of the film-grain tile (0 disables it). */
  grain: number;
  /** Darkness of the corner vignette (0 disables it). */
  vignette: number;
}

export const RETRO_LOOKS: Readonly<Record<CaptureMode, RetroLookSpec>> = {
  'disposable-flash': {
    filter: 'contrast(1.25) saturate(1.3) brightness(1.08)',
    fallback: [
      { op: 'soft-light', color: '#ffffff', alpha: 0.35 },
      { op: 'screen', color: '#2a1a10', alpha: 0.5 },
    ],
    tint: { op: 'soft-light', color: '#ffb070', alpha: 0.18 },
    grain: 0.12,
    vignette: 0.55,
  },
  ccd: {
    filter: 'contrast(1.1) saturate(1.15) brightness(1.05)',
    fallback: [{ op: 'soft-light', color: '#ffffff', alpha: 0.18 }],
    tint: { op: 'soft-light', color: '#6fa8ff', alpha: 0.16 },
    grain: 0.05,
    vignette: 0.15,
  },
  '8mm': {
    filter: 'sepia(0.55) contrast(1.15) saturate(0.8) brightness(0.95)',
    fallback: [
      { op: 'saturation', color: '#808080', alpha: 0.45 },
      { op: 'color', color: '#a0703c', alpha: 0.35 },
    ],
    tint: { op: 'soft-light', color: '#ffcc80', alpha: 0.2 },
    grain: 0.18,
    vignette: 0.6,
  },
  vhs: {
    filter: 'saturate(1.35) contrast(1.05) blur(0.6px)',
    fallback: [{ op: 'saturation', color: '#ff0000', alpha: 0.12 }],
    tint: { op: 'soft-light', color: '#3050ff', alpha: 0.08 },
    grain: 0.1,
    vignette: 0.2,
  },
};

/** The grain tile edge, in pixels. */
export const NOISE_TILE_SIZE = 128;

export interface RetroFrame {
  width: number;
  height: number;
  /** Seconds since the start of the (trimmed) clip; 0 for a photo. */
  time: number;
  /** Seeded so a retried photo produces the same bytes. */
  random: () => number;
  capturedAt: Date;
  /** Whether `ctx.filter` is supported (iPhone Safari before 18 lacks it). */
  supportsFilter: boolean;
  /** True for video frames: enables flicker, gate weave and tracking noise. */
  moving: boolean;
  /** Optional grain tile produced with `fillNoise`. */
  noise?: CanvasImageSource | null;
  /** Optional same-size scratch context, used for the VHS chroma offset. */
  scratch?: CanvasRenderingContext2D | null;
}

/** Scale `width`×`height` down (never up) to fit both limits, as even integers. */
export function fitWithin(
  width: number,
  height: number,
  maxLongEdge: number,
  maxShortEdge = maxLongEdge,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new Error('The media has no usable size.');
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const scale = Math.min(1, maxLongEdge / long, maxShortEdge / short);
  const even = (value: number) => Math.max(2, Math.floor((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Small deterministic PRNG (mulberry32); returns values in [0, 1). */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

/** Fill RGBA pixels with neutral-centred grey noise for an `overlay` grain tile. */
export function fillNoise(data: Uint8ClampedArray, random: () => number): void {
  for (let index = 0; index + 3 < data.length; index += 4) {
    const value = Math.round(128 + (random() - 0.5) * 200);
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (value: number) => String(value).padStart(2, '0');

/** Compact-camera date imprint, e.g. `'26 10 04`. */
export function formatCcdDateStamp(date: Date): string {
  return `'${pad(date.getFullYear() % 100)} ${pad(date.getMonth() + 1)} ${pad(date.getDate())}`;
}

/** Camcorder date line, e.g. `OCT. 04 2026`. */
export function formatVhsDate(date: Date): string {
  return `${MONTHS[date.getMonth()]}. ${pad(date.getDate())} ${date.getFullYear()}`;
}

/** Camcorder clock line, e.g. `PM 3:07:09`. */
export function formatVhsTime(date: Date): string {
  const hours = date.getHours();
  return `${hours < 12 ? 'AM' : 'PM'} ${hours % 12 || 12}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}`;
}

function wash(ctx: CanvasRenderingContext2D, item: ColorWash, width: number, height: number) {
  ctx.save();
  ctx.globalCompositeOperation = item.op;
  ctx.globalAlpha = item.alpha;
  ctx.fillStyle = item.color;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function vignette(ctx: CanvasRenderingContext2D, strength: number, width: number, height: number) {
  const radius = Math.hypot(width, height) / 2;
  const gradient = ctx.createRadialGradient(
    width / 2,
    height / 2,
    radius * 0.45,
    width / 2,
    height / 2,
    radius,
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function grain(ctx: CanvasRenderingContext2D, frame: RetroFrame, alpha: number) {
  if (!frame.noise || alpha <= 0) return;
  const offsetX = Math.floor(frame.random() * NOISE_TILE_SIZE);
  const offsetY = Math.floor(frame.random() * NOISE_TILE_SIZE);
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = alpha;
  for (let y = -offsetY; y < frame.height; y += NOISE_TILE_SIZE) {
    for (let x = -offsetX; x < frame.width; x += NOISE_TILE_SIZE) {
      ctx.drawImage(frame.noise, x, y, NOISE_TILE_SIZE, NOISE_TILE_SIZE);
    }
  }
  ctx.restore();
}

function stampText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  glow: string,
  align: CanvasTextAlign,
) {
  ctx.save();
  ctx.font = `bold ${size}px "Courier New", ui-monospace, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = glow;
  ctx.shadowBlur = Math.max(2, size * 0.35);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function chromaOffset(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  frame: RetroFrame,
): void {
  const scratch = frame.scratch;
  if (!scratch) return;
  const shift = Math.max(2, Math.round(frame.width / 240));
  for (const [color, dx] of [
    ['#ff0000', shift],
    ['#0000ff', -shift],
  ] as const) {
    scratch.save();
    scratch.globalCompositeOperation = 'source-over';
    scratch.drawImage(source, 0, 0, frame.width, frame.height);
    scratch.globalCompositeOperation = 'multiply';
    scratch.fillStyle = color;
    scratch.fillRect(0, 0, frame.width, frame.height);
    scratch.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'lighten';
    ctx.globalAlpha = 0.55;
    ctx.drawImage(scratch.canvas, dx, 0, frame.width, frame.height);
    ctx.restore();
  }
}

function scanlines(ctx: CanvasRenderingContext2D, frame: RetroFrame) {
  const step = Math.max(2, Math.round(frame.height / 360));
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#000000';
  for (let y = 0; y < frame.height; y += step * 2) ctx.fillRect(0, y, frame.width, step);
  ctx.restore();
}

function trackingBand(ctx: CanvasRenderingContext2D, frame: RetroFrame) {
  const bandHeight = Math.max(4, Math.round(frame.height * 0.035));
  const y = Math.floor((frame.time * 0.35 * frame.height) % frame.height);
  ctx.save();
  ctx.globalAlpha = 0.08 + frame.random() * 0.08;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, y, frame.width, bandHeight);
  ctx.restore();
}

function dust(ctx: CanvasRenderingContext2D, frame: RetroFrame) {
  const unit = Math.max(1, Math.min(frame.width, frame.height) / 400);
  const specks = Math.floor(frame.random() * (frame.moving ? 5 : 9));
  ctx.save();
  for (let index = 0; index < specks; index += 1) {
    ctx.globalAlpha = 0.35 + frame.random() * 0.4;
    ctx.fillStyle = frame.random() < 0.7 ? '#140d06' : '#fff6e0';
    ctx.beginPath();
    ctx.arc(
      frame.random() * frame.width,
      frame.random() * frame.height,
      unit * (0.6 + frame.random() * 2),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  if (frame.random() < 0.18) {
    // A stray hair across the gate.
    const x = frame.random() * frame.width;
    const y = frame.random() * frame.height;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#140d06';
    ctx.lineWidth = unit;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + unit * 30 * (frame.random() - 0.5),
      y + unit * 25,
      x + unit * 20 * (frame.random() - 0.5),
      y + unit * 50,
    );
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw `source` onto `ctx` with the chosen look (one photo or one video frame). */
export function drawRetroFrame(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  mode: CaptureMode,
  frame: RetroFrame,
): void {
  const look = RETRO_LOOKS[mode];
  const { width, height } = frame;
  // 8mm film weaves slightly in the gate.
  const weave = mode === '8mm' && frame.moving ? (frame.random() - 0.5) * height * 0.006 : 0;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  if (frame.supportsFilter) ctx.filter = look.filter;
  ctx.drawImage(source, 0, weave, width, height);
  if (frame.supportsFilter) ctx.filter = 'none';
  ctx.restore();
  if (!frame.supportsFilter) for (const item of look.fallback) wash(ctx, item, width, height);

  if (mode === 'vhs') chromaOffset(ctx, source, frame);
  if (look.tint) wash(ctx, look.tint, width, height);

  if (mode === 'disposable-flash') {
    // Direct on-camera flash: a hot centre that falls off fast, plus a warm leak.
    const radius = Math.max(width, height) * 0.6;
    const bloom = ctx.createRadialGradient(
      width / 2,
      height * 0.45,
      0,
      width / 2,
      height * 0.45,
      radius,
    );
    bloom.addColorStop(0, 'rgba(255,255,255,0.32)');
    bloom.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    bloom.addColorStop(1, 'rgba(255,255,255,0)');
    const leak = ctx.createLinearGradient(width, 0, width * 0.7, 0);
    leak.addColorStop(0, 'rgba(255,110,40,0.35)');
    leak.addColorStop(1, 'rgba(255,110,40,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = leak;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  if (mode === '8mm') {
    if (frame.moving) {
      // Projector flicker.
      ctx.save();
      ctx.globalAlpha = frame.random() * 0.08;
      ctx.fillStyle = frame.random() < 0.5 ? '#ffffff' : '#000000';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    dust(ctx, frame);
  }

  if (mode === 'vhs') {
    scanlines(ctx, frame);
    if (frame.moving) trackingBand(ctx, frame);
  }

  if (look.vignette > 0) vignette(ctx, look.vignette, width, height);
  grain(ctx, frame, look.grain);

  const size = Math.max(12, Math.round(Math.min(width, height) * 0.045));
  const margin = Math.round(size * 1.2);
  if (mode === 'ccd') {
    stampText(
      ctx,
      formatCcdDateStamp(frame.capturedAt),
      width - margin,
      height - margin,
      size,
      '#ff9a2e',
      '#ff5a00',
      'right',
    );
  }
  if (mode === 'vhs') {
    const clock = new Date(frame.capturedAt.getTime() + frame.time * 1000);
    const white = '#f4f4f4';
    const shadow = '#000000';
    stampText(ctx, 'PLAY ▶', margin, margin + size, size, white, shadow, 'left');
    stampText(ctx, 'SP', width - margin, margin + size, size, white, shadow, 'right');
    stampText(
      ctx,
      formatVhsTime(clock),
      margin,
      height - margin - size * 1.3,
      size,
      white,
      shadow,
      'left',
    );
    stampText(ctx, formatVhsDate(clock), margin, height - margin, size, white, shadow, 'left');
  }
}
