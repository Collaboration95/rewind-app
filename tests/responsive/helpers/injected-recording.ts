import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { expect, type Page, type TestInfo } from '@playwright/test';

declare global {
  interface Window {
    __injectedCapture: {
      installation: {
        devices: MediaDevices;
        getUserMedia: MediaDevices['getUserMedia'];
      } | null;
      shape: 'portrait' | 'landscape';
      delayDurationStop: boolean;
      playbackAudio: AudioContext[];
      playbackProbe: {
        source: MediaElementAudioSourceNode;
        analyser: AnalyserNode;
      } | null;
      sources: {
        stream: MediaStream;
        tracks: MediaStreamTrack[];
        audio: AudioContext;
        frames: number;
      }[];
      blobs: {
        url: string;
        blob: Blob | null;
        revoked: boolean;
        playerAttachedAtRevoke: boolean;
      }[];
    };
  }
}

/** Inject the device boundary only. Never replace MediaRecorder, metadata or playback. */
export async function injectRecordingSource(page: Page) {
  await page.addInitScript(() => {
    const state: Window['__injectedCapture'] = {
      installation: null,
      shape: 'portrait',
      delayDurationStop: false,
      playbackAudio: [],
      playbackProbe: null,
      sources: [],
      blobs: [],
    };
    window.__injectedCapture = state;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      if (object instanceof Blob && object.type.startsWith('video/')) {
        state.blobs.push({ url, blob: object, revoked: false, playerAttachedAtRevoke: false });
      }
      return url;
    };
    URL.revokeObjectURL = (url) => {
      const entry = state.blobs.find((item) => item.url === url);
      if (entry) {
        entry.revoked = true;
        entry.playerAttachedAtRevoke = Array.from(document.querySelectorAll('video')).some(
          (video) => video.currentSrc === url || video.src === url,
        );
      }
      revoke(url);
    };
    // Fault injection: let the REAL recording exceed 15s, as a late event-loop timer
    // could. Date, intervals, metadata, encoded duration and all other timers stay real.
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      schedule(
        handler,
        state.delayDurationStop && delay === 15_000 ? 16_500 : delay,
        ...args,
      )) as typeof window.setTimeout;
    // WebKit can discard expandos on an unretained native MediaDevices wrapper.
    // Pin the patched object on navigator so every application lookup uses it.
    const devices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { value: devices });
    const getUserMedia = async (constraints: MediaStreamConstraints) => {
      if (!constraints.audio || !constraints.video) throw new Error('Expected audio + video');
      const canvas = document.createElement('canvas');
      canvas.width = state.shape === 'portrait' ? 360 : 640;
      canvas.height = state.shape === 'portrait' ? 640 : 360;
      const drawing = canvas.getContext('2d')!;
      const audio = new AudioContext();
      await audio.resume();
      const oscillator = audio.createOscillator();
      oscillator.frequency.value = 440;
      const gain = audio.createGain();
      gain.gain.value = 0.25;
      const destination = audio.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      // The generator has no connection to hardware audio output.
      const stream = new MediaStream([
        ...canvas.captureStream(30).getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);
      // Retain native track wrappers for the lifetime of the source too. WebKit
      // can otherwise discard their stop observers during a longer recording.
      const tracks = stream.getTracks();
      const source = { stream, tracks, audio, frames: 0 };
      state.sources.push(source);
      const draw = () => {
        source.frames++;
        drawing.fillStyle = `hsl(${(source.frames * 7) % 360}, 90%, 50%)`;
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.fillStyle = 'white';
        drawing.fillRect((source.frames * 9) % canvas.width, 40, 40, 120);
      };
      draw();
      const interval = setInterval(draw, 1000 / 30);
      for (const track of tracks) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          if (tracks.every((item) => item.readyState === 'ended') && audio.state !== 'closed') {
            clearInterval(interval);
            oscillator.stop();
            void audio.close();
          }
        };
      }
      // A running WebKit context can still have an unstarted audio clock.
      // Make the synthetic device provide rendered audio before returning it,
      // so a short recovery recording does not lose its tone to fixture startup.
      const readyDeadline = performance.now() + 3000;
      while (audio.currentTime < 0.2 && performance.now() < readyDeadline) {
        await new Promise((resolve) => schedule(resolve, 50));
      }
      if (audio.currentTime < 0.2) {
        tracks.forEach((track) => track.stop());
        throw new Error('The synthetic audio source did not start');
      }
      return stream;
    };
    Object.defineProperty(devices, 'getUserMedia', { value: getUserMedia });
    // Publish the marker only after both immutable overrides have succeeded.
    state.installation = { devices, getUserMedia };
  });
}

export async function expectInjectedSourceInstalled(page: Page) {
  const installed = await page.evaluate(() => {
    const installation = window.__injectedCapture?.installation;
    return !!(
      installation &&
      navigator.mediaDevices === installation.devices &&
      navigator.mediaDevices.getUserMedia === installation.getUserMedia &&
      Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')?.configurable === false &&
      Object.getOwnPropertyDescriptor(installation.devices, 'getUserMedia')?.writable === false
    );
  });
  expect(installed, 'Synthetic device injection is absent; refusing native device access').toBe(
    true,
  );
}

export async function recordingSupport(page: Page, testInfo: TestInfo) {
  await page.goto('/');
  await expectInjectedSourceInstalled(page);
  const support = await page.evaluate(() => ({
    agent: navigator.userAgent,
    types: [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp4',
    ].filter((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)),
  }));
  await testInfo.attach('real-recorder-capability', {
    body: JSON.stringify(support, null, 2),
    contentType: 'application/json',
  });
  return support.types.length > 0;
}

/** From the signed-in group's Home (see recordingSupport), open real video capture. */
export async function openInjectedCapture(page: Page) {
  await expect(page.getByTestId('real-group-home')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('real-group-capture-action').click();
  await page.getByTestId('camera-record-clip').click();
}

export async function allowInjectedSource(page: Page) {
  await expectInjectedSourceInstalled(page);
  await expect(page.getByTestId('video-permission')).toBeVisible();
  expect(await page.evaluate(() => window.__injectedCapture.sources.length)).toBe(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('video-live-preview')).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId('video-live-preview')
        .evaluate((video: HTMLVideoElement) => video.readyState),
    )
    .toBeGreaterThanOrEqual(2);
}

export async function recordFor(page: Page, seconds = 6) {
  await page.getByTestId('video-record').click();
  await expect(page.getByTestId('video-recording')).toBeVisible();
  await page.waitForTimeout(seconds * 1000);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
}

export async function restoreInjectedPreview(page: Page) {
  await expectInjectedSourceInstalled(page);
  await page.getByTestId('video-preview-recovery').click();
  await expect
    .poll(() =>
      page
        .getByTestId('video-live-preview')
        .evaluate(
          (video: HTMLVideoElement) =>
            video.srcObject instanceof MediaStream &&
            video.srcObject.getTracks().every((track) => track.readyState === 'live') &&
            video.readyState >= 2,
        ),
    )
    .toBe(true);
  await expect(page.getByTestId('video-record')).toBeVisible();
}

export async function expectSourceStopped(page: Page, index: number) {
  await expect
    .poll(() =>
      page.evaluate((sourceIndex) => {
        const source = window.__injectedCapture.sources[sourceIndex];
        return (
          source.stream.getTracks().every((track) => track.readyState === 'ended') &&
          source.audio.state === 'closed'
        );
      }, index),
    )
    .toBe(true);
  const frames = await page.evaluate((i) => window.__injectedCapture.sources[i].frames, index);
  await page.waitForTimeout(120);
  expect(await page.evaluate((i) => window.__injectedCapture.sources[i].frames, index)).toBe(
    frames,
  );
}

/** Inspect actual recorder bytes independently of app metadata and browser playback. */
export async function inspectRecording(page: Page, testInfo: TestInfo, index: number) {
  const dataUrl = await page.evaluate(async (i) => {
    const entry = window.__injectedCapture.blobs[i];
    if (!entry?.blob) throw new Error('No encoded recorder blob');
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(entry.blob!);
    });
    // Observer releases its own reference; the application owns the live blob URL.
    entry.blob = null;
    return data;
  }, index);
  const path = testInfo.outputPath(`recording-${index}.mp4`);
  // MediaRecorder MIME types can contain commas in their codec list.
  writeFileSync(path, Buffer.from(dataUrl.slice(dataUrl.indexOf(';base64,') + 8), 'base64'));
  const metadata = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], {
      encoding: 'utf8',
    }),
  ) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
    format: { duration: string };
  };
  const pcm = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  // Avoid codec priming: measure 0.5..1.5s and count positive zero crossings.
  let squares = 0;
  let crossings = 0;
  expect(pcm.byteLength).toBeGreaterThanOrEqual(72_000 * 4);
  for (let i = 24_000; i < 72_000; i++) {
    const value = pcm.readFloatLE(i * 4);
    squares += value * value;
    if (value >= 0 && pcm.readFloatLE((i - 1) * 4) < 0) crossings++;
  }
  const rms = Math.sqrt(squares / 48_000);
  expect(rms).toBeGreaterThan(0.1);
  expect(rms).toBeLessThan(0.3);
  expect(crossings).toBeGreaterThan(430);
  expect(crossings).toBeLessThan(450);
  // Safari and Chrome record H.264/AAC; open-source Chromium (CI) has neither
  // encoder and records VP9/Opus in MP4. The server re-encodes to H.264/AAC
  // either way; the tone check above proves the audio.
  expect(['aac', 'opus']).toContain(
    metadata.streams.find((stream) => stream.codec_type === 'audio')?.codec_name,
  );
  expect(['h264', 'vp9']).toContain(
    metadata.streams.find((stream) => stream.codec_type === 'video')?.codec_name,
  );
  const evidence = { ...metadata, decodedAudio: { rms, positiveCrossingsPerSecond: crossings } };
  await testInfo.attach(`encoded-media-${index}`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach(`recording-${index}`, { path, contentType: 'video/mp4' });
  return metadata;
}

export async function expectRevoked(page: Page, index: number) {
  await expect
    .poll(() => page.evaluate((i) => window.__injectedCapture.blobs[i].revoked, index))
    .toBe(true);
  expect(
    await page.evaluate((i) => window.__injectedCapture.blobs[i].playerAttachedAtRevoke, index),
  ).toBe(false);
  expect(
    await page.evaluate(async (i) => {
      try {
        await fetch(window.__injectedCapture.blobs[i].url);
        return true;
      } catch {
        return false;
      }
    }, index),
  ).toBe(false);
}

/**
 * Move a trim handle with the keyboard, half a second per arrow press, to the
 * nearest step of `seconds` (a recorded end is not on the half-second grid).
 */
export async function setTrim(page: Page, handle: 'start' | 'end', seconds: number) {
  const control = page.getByTestId(`video-trim-${handle}`);
  await control.focus();
  const read = async () =>
    Number.parseFloat((await control.getAttribute('aria-valuetext')) ?? 'NaN');
  for (let step = 0; step < 40; step += 1) {
    const current = await read();
    if (Math.abs(current - seconds) < 0.05) break;
    const key = current < seconds ? 'ArrowRight' : 'ArrowLeft';
    // Finish at the requested tenth, rather than accepting a different trim
    // within 0.25s and later asserting playback against the requested value.
    await page.keyboard.press(Math.abs(current - seconds) < 0.5 ? `Shift+${key}` : key);
  }
  expect(Math.abs((await read()) - seconds)).toBeLessThanOrEqual(0.25);
  expect(await read()).toBeCloseTo(seconds, 1);
}
