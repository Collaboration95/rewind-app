import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
