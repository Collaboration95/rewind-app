import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOrientation,
  assertTargets,
  FILM_PROFILE,
  measureOrientations,
  PROTOCOL,
  summarize,
} from './measure-real-group-performance.mjs';

function passingReport() {
  return {
    api: Array.from({ length: 3 }, () => ({
      warmupElapsedMs: PROTOCOL.warmupMs,
      samples: ['group', 'prompt', 'budget', 'chat'].flatMap((operation) =>
        Array.from({ length: 100 }, () => ({ operation, ms: 20, ok: true })),
      ),
    })),
    films: Array.from({ length: 3 }, () => ({
      inputCount: 25,
      inputSeconds: 150,
      inputs: Array.from({ length: 25 }, (_, index) => ({
        index,
        width: 720,
        height: 1280,
        frameRates: { nominal: `${index % 2 ? 30 : 24}/1` },
      })),
      metadata: {
        width: 720,
        height: 1280,
        hasAudio: true,
        frameRates: { nominal: '30/1' },
      },
      queueMs: 1,
      workerMs: 5000,
      endToEndMs: 5001,
      completedCount: 25,
      playable: true,
      chronologicalFrames: 25,
      loudnessLufs: -16,
    })),
    orientation: [
      {
        name: 'portrait',
        processed: { width: 1080, height: 1920, hasAudio: true },
        film: { width: 720, height: 1280, hasAudio: true, topEdgeBlack: false, centerBlack: false },
      },
      {
        name: 'landscape',
        processed: { width: 1920, height: 1080, hasAudio: true },
        film: { width: 720, height: 1280, hasAudio: true, topEdgeBlack: true, centerBlack: false },
      },
    ],
  };
}

test('nearest-rank statistics retain slow failures and reject unusable observations', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ ms: i + 1, ok: i < 94 }));
  assert.deepEqual(summarize(samples), { count: 100, errors: 6, p50Ms: 50, p95Ms: 95, maxMs: 100 });
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([{ ms: NaN, ok: true }]));
  assert.throws(() => summarize([{ ms: -1, ok: true }]));
});

test('targets apply per operation and repetition, never hide misses in averages', () => {
  const report = passingReport();
  assert.doesNotThrow(() => assertTargets(report));
  for (const mutation of [
    (r) => {
      r.films[0].inputs[0].width = 180;
    },
    (r) => {
      r.films[0].inputs[0].frameRates.nominal = '12/1';
    },
    (r) => {
      r.films[0].metadata.width = 180;
      r.films[0].metadata.height = 320;
    },
    (r) => {
      r.films[0].metadata.width = 1280;
      r.films[0].metadata.height = 720;
    },
    (r) => {
      r.films[0].metadata.height = 1279;
    },
    (r) => {
      r.films[0].metadata.frameRates.nominal = '12/1';
    },
    (r) => {
      r.films[0].metadata.hasAudio = false;
    },
    (r) => {
      r.orientation[0].processed.width = 720;
    },
    (r) => {
      r.orientation[1].processed.hasAudio = false;
    },
    (r) => {
      r.orientation[1].film.width = 1920;
    },
    (r) => {
      r.orientation[1].film.topEdgeBlack = false;
    },
    (r) => {
      r.orientation.pop();
    },
    (r) => {
      r.api[2].samples
        .filter((s) => s.operation === 'prompt')
        .slice(0, 6)
        .forEach((s) => {
          s.ms = 2001;
        });
    },
    (r) => {
      r.api[0].samples[0].ok = false;
    },
    (r) => {
      r.api[1].warmupElapsedMs = 29_999;
    },
    (r) => {
      r.api[0].samples.pop();
    },
    (r) => {
      r.films[1].endToEndMs = 600_001;
    },
    (r) => {
      r.films[0].inputSeconds = 149;
    },
    (r) => {
      r.films[0].completedCount = 24;
    },
    (r) => {
      r.films[0].chronologicalFrames = 24;
    },
    (r) => {
      r.films[0].loudnessLufs = -30;
    },
    (r) => {
      r.films[0].playable = false;
    },
    (r) => {
      r.films[0].queueMs = -1;
    },
    (r) => {
      r.films[0].endToEndMs = 2;
    },
    (r) => {
      r.films.pop();
    },
  ]) {
    const invalid = passingReport();
    mutation(invalid);
    assert.throws(() => assertTargets(invalid));
  }
});

test('film contract is the current 720x1280 at 30 fps', () => {
  assert.deepEqual({ ...FILM_PROFILE }, { width: 720, height: 1280, frameRate: '30/1' });
});

test('generated 1080p portrait and landscape sources: clips keep size, films are 720x1280', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rewind-perf-526-'));
  try {
    const results = await measureOrientations(directory);
    assert.doesNotThrow(() => assertOrientation(results));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI refuses a supplied URL before importing the runtime or starting fixtures', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./measure-real-group-performance.mjs', import.meta.url)),
      'https://example.invalid',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No arguments supported; this runner never accepts a hosted URL/);
});
