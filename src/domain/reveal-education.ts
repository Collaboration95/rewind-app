import type { Cycle } from './cycles';
import type { Premiere } from './premiere';

export type RevealEducationState = 'locked' | 'processing' | 'delayed' | 'released';
export type RevealEducationSurface = 'home' | 'capture' | 'archive';

export interface RevealEducationCopy {
  actionLabel: string;
  body: string;
  title: string;
}

const COPY: Record<RevealEducationSurface, Record<RevealEducationState, RevealEducationCopy>> = {
  home: {
    locked: {
      actionLabel: 'Add a moment',
      body: 'Contributions are collecting and locked. Add a moment now; everyone sees media only after the group reveal.',
      title: 'Sealed until reveal',
    },
    delayed: {
      actionLabel: 'Open Archive',
      body: 'The group film is delayed while processing is resolved. Check Archive for the latest release state.',
      title: 'Reveal delayed',
    },
    processing: {
      actionLabel: 'Open Archive',
      body: 'The group film is being prepared. Open Archive to check again after processing completes.',
      title: 'Preparing the reveal',
    },
    released: {
      actionLabel: 'Open Archive',
      body: 'The group film is released. Open Archive to watch the published result.',
      title: 'Film released',
    },
  },
  capture: {
    locked: {
      actionLabel: 'Take a still image',
      body: 'Your next moment can be captured now, but its media stays sealed until the group reveal.',
      title: 'Capture now, reveal later',
    },
    delayed: {
      actionLabel: 'Open Archive',
      body: 'The group film is delayed. You can still submit a moment; check Archive for release progress.',
      title: 'Reveal delayed',
    },
    processing: {
      actionLabel: 'Open Archive',
      body: 'The group film is being prepared. Open Archive to check release progress.',
      title: 'Preparing the reveal',
    },
    released: {
      actionLabel: 'Open Archive',
      body: 'This cycle is released. Open Archive to watch the published group film.',
      title: 'Film released',
    },
  },
  archive: {
    locked: {
      actionLabel: 'Check premiere again',
      body: 'The group film has not been released. Playback and media links remain unavailable until reveal.',
      title: 'Sealed until reveal',
    },
    delayed: {
      actionLabel: 'Check premiere again',
      body: 'The group film is delayed while processing is resolved. No playback or download is available yet.',
      title: 'Film delayed',
    },
    processing: {
      actionLabel: 'Check premiere again',
      body: 'Your accepted moments are compiling. Playback and downloads appear only after release is published.',
      title: 'Preparing your group film',
    },
    released: {
      actionLabel: 'Play group film',
      body: 'The released group film is ready above. Start playback when you are ready.',
      title: 'Film released',
    },
  },
};

export function getRevealEducationCopy(
  surface: RevealEducationSurface,
  state: RevealEducationState,
): RevealEducationCopy {
  return { ...COPY[surface][state] };
}

export function revealStateForCycle(cycle: Cycle): RevealEducationState {
  if (cycle.status === 'archived' && cycle.lockState === 'unlocked') return 'released';
  if (cycle.status === 'revealing') return 'processing';
  return 'locked';
}

export function revealStateForPremiere(premiere: Premiere): RevealEducationState {
  if (premiere.state === 'ready') return 'released';
  if (premiere.state === 'delayed') return 'delayed';
  if (premiere.state === 'processing') return 'processing';
  return 'locked';
}
