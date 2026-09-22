import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The original capture modes supported by the client and local worker. */
export const SUPPORTED_CAPTURE_MODES = ['soft-focus', 'high-contrast'] as const;
export type CaptureMode = (typeof SUPPORTED_CAPTURE_MODES)[number];

export interface FfmpegProcessInput {
  inputPath: string;
  outputPath: string;
  trimStartSeconds: number;
  trimEndSeconds: number;
  mode: CaptureMode;
}

export interface FfmpegProcessResult {
  outputPath: string;
  durationSeconds: number;
}

export interface FfmpegFilmCompilationInput {
  /** Already-processed, server-owned portrait clips in chronological order. */
  inputPaths: string[];
  /** The one prior-cycle clip that must be visibly identified, when present. */
  archiveFillerIndex?: number;
  outputPath: string;
}

export interface FfmpegFilmCompilationResult {
  outputPath: string;
  durationSeconds: number;
}

export const ARCHIVE_FILLER_LABEL = 'From the archive';

const ARCHIVE_LABEL_FONT: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
};

/** Build the label without relying on a host font or FFmpeg's optional drawtext filter. */
function archiveLabelPpm(): Buffer {
  const width = 172;
  const height = 48;
  const pixels = Buffer.alloc(width * height * 3);
  const lines = ARCHIVE_FILLER_LABEL.toUpperCase().split(' ');
  const scale = 2;
  const characterAdvance = 12;
  for (const [lineIndex, line] of lines.entries()) {
    const yOffset = 3 + lineIndex * 15;
    for (const [characterIndex, character] of [...line].entries()) {
      const glyph = ARCHIVE_LABEL_FONT[character];
      if (!glyph) continue;
      for (const [glyphY, row] of glyph.entries()) {
        for (const [glyphX, value] of [...row].entries()) {
          if (value !== '1') continue;
          for (let y = 0; y < scale; y += 1) {
            for (let x = 0; x < scale; x += 1) {
              const pixelX = 4 + characterIndex * characterAdvance + glyphX * scale + x;
              const pixelY = yOffset + glyphY * scale + y;
              const offset = (pixelY * width + pixelX) * 3;
              pixels[offset] = 255;
              pixels[offset + 1] = 255;
              pixels[offset + 2] = 255;
            }
          }
        }
      }
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

export interface FfmpegMediaProbeResult {
  mimeType: 'video/mp4';
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** Create a deterministic, non-sensitive portrait source for the local Demo.
 * Callers still must place and stage the result through the normal capability
 * boundary before it can become a contribution. */
export async function generateSyntheticDemoClip(
  ffmpegBin: string,
  outputPath: string,
): Promise<FfmpegMediaProbeResult> {
  try {
    await execFileAsync(ffmpegBin, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=180x320:rate=12:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=44100:duration=2',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      outputPath,
    ]);
    return await probeClipWithFfmpeg(ffmpegBin, outputPath);
  } catch {
    throw new FfmpegProcessingError(
      'process_failed',
      'The synthetic Demo clip could not be prepared.',
    );
  }
}

/**
 * Processing errors intentionally expose no command, source path, or output
 * path. The detailed stderr belongs in neither the database nor an HTTP body.
 */
export class FfmpegProcessingError extends Error {
  readonly code: 'invalid_metadata' | 'source_unavailable' | 'process_failed';

  constructor(code: FfmpegProcessingError['code'], message: string) {
    super(message);
    this.name = 'FfmpegProcessingError';
    this.code = code;
  }
}

export function resolveLocalMediaPath(value: string): string {
  if (value.startsWith('file://')) {
    try {
      return fileURLToPath(new URL(value));
    } catch {
      throw new FfmpegProcessingError(
        'source_unavailable',
        'The temporary media source is unavailable.',
      );
    }
  }
  if (isAbsolute(value)) return value;
  throw new FfmpegProcessingError(
    'source_unavailable',
    'The temporary media source is unavailable.',
  );
}

/**
 * Resolve a source only when it is physically inside server-owned staging.
 * Realpath resolution prevents a symlink in staging from escaping this
 * boundary before FFmpeg reads or cleanup removes the source.
 */
export async function resolveStagedMediaPath(value: string, stagingDir: string): Promise<string> {
  const candidate = resolveLocalMediaPath(value);
  try {
    const [source, staging] = await Promise.all([realpath(candidate), realpath(stagingDir)]);
    const remainder = relative(staging, source);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) {
      throw new FfmpegProcessingError(
        'source_unavailable',
        'The temporary media source is unavailable.',
      );
    }
    return source;
  } catch (error) {
    if (error instanceof FfmpegProcessingError) throw error;
    throw new FfmpegProcessingError(
      'source_unavailable',
      'The temporary media source is unavailable.',
    );
  }
}

function modeFilter(mode: CaptureMode): string {
  return mode === 'high-contrast'
    ? 'eq=contrast=1.18:brightness=0.02:saturation=1.12'
    : 'eq=contrast=0.96:brightness=0.02:saturation=0.9,gblur=sigma=0.35';
}

function validProcessInput(input: FfmpegProcessInput): boolean {
  return (
    Number.isFinite(input.trimStartSeconds) &&
    Number.isFinite(input.trimEndSeconds) &&
    input.trimStartSeconds >= 0 &&
    input.trimEndSeconds > input.trimStartSeconds &&
    input.trimEndSeconds - input.trimStartSeconds <= 15 &&
    input.trimEndSeconds - input.trimStartSeconds >= 0.5 &&
    input.inputPath.length > 0 &&
    input.outputPath.length > 0 &&
    SUPPORTED_CAPTURE_MODES.includes(input.mode)
  );
}

export async function processClipWithFfmpeg(
  ffmpegBin: string,
  input: FfmpegProcessInput,
): Promise<FfmpegProcessResult> {
  if (!validProcessInput(input)) {
    throw new FfmpegProcessingError('invalid_metadata', 'The clip processing metadata is invalid.');
  }
  try {
    // Re-check the immutable source boundary at the worker too. Client trim
    // metadata may not extend past the duration FFprobe observed on the
    // server-owned source, even if intake was interrupted or bypassed.
    const source = await probeClipWithFfmpeg(ffmpegBin, input.inputPath);
    if (input.trimEndSeconds > source.durationSeconds + 0.05) {
      throw new FfmpegProcessingError(
        'invalid_metadata',
        'The clip processing metadata is outside the source duration.',
      );
    }
    const durationSeconds = input.trimEndSeconds - input.trimStartSeconds;
    await execFileAsync(
      ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input.inputPath,
        '-ss',
        String(input.trimStartSeconds),
        '-t',
        String(durationSeconds),
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-vf',
        `${modeFilter(input.mode)},setpts=PTS-STARTPTS`,
        '-af',
        'asetpts=PTS-STARTPTS',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-bf',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        '-avoid_negative_ts',
        'make_zero',
        input.outputPath,
      ],
      { timeout: 60_000, maxBuffer: 2_000_000 },
    );
    return { outputPath: input.outputPath, durationSeconds };
  } catch (error) {
    // Preserve a useful internal cause for diagnostics while returning only a
    // stable, path-free error to callers.
    const detail = error instanceof Error ? error.message.toLowerCase() : '';
    const code =
      detail.includes('no such file') || detail.includes('does not exist')
        ? 'source_unavailable'
        : 'process_failed';
    throw new FfmpegProcessingError(
      code,
      code === 'source_unavailable'
        ? 'The temporary media source is unavailable.'
        : 'FFmpeg could not process the clip. Retry the job.',
    );
  }
}

/**
 * Concatenate retained clips without a shell. Each input is normalized before
 * concat so a valid but differently encoded processed clip cannot make the
 * final MP4 unplayable. Loudness is normalized once across the complete film.
 */
export async function compileFilmWithFfmpeg(
  ffmpegBin: string,
  input: FfmpegFilmCompilationInput,
): Promise<FfmpegFilmCompilationResult> {
  if (
    !input.outputPath ||
    input.inputPaths.length === 0 ||
    input.inputPaths.some((path) => !path) ||
    (input.archiveFillerIndex !== undefined &&
      (!Number.isInteger(input.archiveFillerIndex) ||
        input.archiveFillerIndex < 0 ||
        input.archiveFillerIndex >= input.inputPaths.length))
  ) {
    throw new FfmpegProcessingError(
      'invalid_metadata',
      'The film compilation metadata is invalid.',
    );
  }
  const labelPath =
    input.archiveFillerIndex === undefined ? null : `${input.outputPath}.archive-label.ppm`;
  const videoFilters = input.inputPaths.map((_, index) => {
    const normalized =
      `[${index}:v:0]scale=180:320:force_original_aspect_ratio=decrease,` +
      `pad=180:320:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setpts=PTS-STARTPTS`;
    if (index !== input.archiveFillerIndex) return `${normalized}[v${index}]`;
    const labelInputIndex = input.inputPaths.length;
    return (
      `${normalized}[archiveBase];` +
      `[archiveBase][${labelInputIndex}:v:0]overlay=4:4:shortest=1,` +
      `setpts=PTS-STARTPTS[v${index}]`
    );
  });
  const audioFilters = input.inputPaths.map(
    (_, index) =>
      `[${index}:a:0]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`,
  );
  const concatInputs = input.inputPaths
    .flatMap((_, index) => [`[v${index}]`, `[a${index}]`])
    .join('');
  const filterComplex = [
    ...videoFilters,
    ...audioFilters,
    `${concatInputs}concat=n=${input.inputPaths.length}:v=1:a=1[video][audio]`,
    '[audio]loudnorm=I=-16:TP=-1.5:LRA=11[normalizedAudio]',
  ].join(';');
  try {
    if (labelPath) await writeFile(labelPath, archiveLabelPpm());
    await execFileAsync(
      ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...input.inputPaths.flatMap((path) => ['-i', path]),
        ...(labelPath ? ['-loop', '1', '-framerate', '12', '-i', labelPath] : []),
        '-filter_complex',
        filterComplex,
        '-map',
        '[video]',
        '-map',
        '[normalizedAudio]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-bf',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-movflags',
        '+faststart',
        input.outputPath,
      ],
      { timeout: 120_000, maxBuffer: 2_000_000 },
    );
    const output = await probeClipWithFfmpeg(ffmpegBin, input.outputPath);
    return { outputPath: input.outputPath, durationSeconds: output.durationSeconds };
  } catch (error) {
    if (error instanceof FfmpegProcessingError) throw error;
    throw new FfmpegProcessingError(
      'process_failed',
      'FFmpeg could not compile the film. Retry the job.',
    );
  } finally {
    if (labelPath) await rm(labelPath, { force: true }).catch(() => undefined);
  }
}

export async function probeClipWithFfmpeg(
  ffmpegBin: string,
  inputPath: string,
  stagingDir?: string,
): Promise<FfmpegMediaProbeResult> {
  const ffmpegDirectory = dirname(ffmpegBin);
  const probeBin =
    basename(ffmpegBin).startsWith('ffmpeg') && ffmpegDirectory !== '.'
      ? `${ffmpegDirectory}/ffprobe`
      : 'ffprobe';
  try {
    const safeInputPath = stagingDir
      ? await resolveStagedMediaPath(inputPath, stagingDir)
      : resolveLocalMediaPath(inputPath);
    const [probe, file] = await Promise.all([
      execFileAsync(
        probeBin,
        [
          '-v',
          'error',
          '-show_entries',
          'format=format_name,duration:stream=codec_type,width,height',
          '-of',
          'json',
          safeInputPath,
        ],
        { timeout: 20_000, maxBuffer: 2_000_000 },
      ),
      // Stat the same normalized, boundary-checked path passed to ffprobe.
      // `inputPath` may be a file:// URL, which is not a filesystem path.
      stat(safeInputPath),
    ]);
    const parsed = JSON.parse(probe.stdout) as {
      format?: { format_name?: string; duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const durationSeconds = Number(parsed.format?.duration);
    const width = Number(video?.width);
    const height = Number(video?.height);
    const hasAudio = parsed.streams?.some((stream) => stream.codec_type === 'audio') === true;
    const formatNames = parsed.format?.format_name?.split(',').map((value) => value.trim()) ?? [];
    if (
      !formatNames.includes('mp4') ||
      !Number.isInteger(file.size) ||
      file.size <= 0 ||
      !Number.isFinite(durationSeconds) ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width >= height ||
      !hasAudio
    ) {
      throw new Error('invalid media');
    }
    return {
      mimeType: 'video/mp4',
      byteLength: file.size,
      durationSeconds,
      width,
      height,
      hasAudio,
    };
  } catch {
    throw new FfmpegProcessingError('process_failed', 'The staged media could not be verified.');
  }
}

// Descriptive alias for callers that treat FFmpeg as a generic media adapter.
export const runFfmpegTransform = processClipWithFfmpeg;

export interface FfmpegProbeResult {
  configured: boolean;
  transformSucceeded: boolean;
  deliberateFailureDetected: boolean;
  message: string;
}

export async function runFfmpegProbe(ffmpegBin: string): Promise<FfmpegProbeResult> {
  const workDir = await mkdtemp(`${tmpdir()}/rewind-ffmpeg-`);
  const inputPath = `${workDir}/synthetic.mp4`;
  const outputPath = `${workDir}/transformed.mp4`;
  const missingPath = `${workDir}/missing-input.mp4`;
  try {
    await execFileAsync(ffmpegBin, ['-version'], { timeout: 10_000, maxBuffer: 2_000_000 });
    await execFileAsync(
      ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=160x90:r=12:d=0.5',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        inputPath,
      ],
      { timeout: 20_000, maxBuffer: 2_000_000 },
    );
    await execFileAsync(
      ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-vf',
        'scale=80:46',
        outputPath,
      ],
      { timeout: 20_000, maxBuffer: 2_000_000 },
    );
    let deliberateFailureDetected = false;
    try {
      await execFileAsync(
        ffmpegBin,
        ['-hide_banner', '-loglevel', 'error', '-i', missingPath, '-f', 'null', '-'],
        { timeout: 10_000, maxBuffer: 2_000_000 },
      );
    } catch (error) {
      deliberateFailureDetected = true;
      const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
      if (!stderr && !(error instanceof Error && error.message)) {
        throw new Error('FFmpeg rejected the deliberate failure without an error message.');
      }
    }
    return {
      configured: true,
      transformSucceeded: true,
      deliberateFailureDetected,
      message:
        'Synthetic MP4 transform passed; missing-input failure returned an actionable error.',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      configured: false,
      transformSucceeded: false,
      deliberateFailureDetected: false,
      message: `FFmpeg preflight failed: ${detail}. Set REWIND_FFMPEG_BIN to an installed FFmpeg binary.`,
    };
  } finally {
    await Promise.allSettled([rm(inputPath, { force: true }), rm(outputPath, { force: true })]);
    await rm(workDir, { recursive: true, force: true });
  }
}
