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
      actionLabel: 'Open Archive',
      body: 'Media stays hidden until the film is released.',
      title: 'Sealed until reveal',
    },
    delayed: {
      actionLabel: 'Open Archive',
      body: 'Check Archive again later.',
      title: 'Reveal delayed',
    },
    processing: {
      actionLabel: 'Open Archive',
      body: 'Processing. Playback is unavailable.',
      title: 'Preparing the group film',
    },
    released: {
      actionLabel: 'Watch in Archive',
      body: 'Open Archive to watch.',
      title: 'Your group film is ready',
    },
  },
  capture: {
    locked: {
      actionLabel: 'Open Archive',
      body: 'Media stays hidden until the film is released.',
      title: 'Sealed until reveal',
    },
    delayed: {
      actionLabel: 'Open Archive',
      body: 'Check Archive again later.',
      title: 'Reveal delayed',
    },
    processing: {
      actionLabel: 'Open Archive',
      body: 'Processing. Playback is unavailable.',
      title: 'Preparing the group film',
    },
    released: {
      actionLabel: 'Watch in Archive',
      body: 'Open Archive to watch.',
      title: 'Your group film is ready',
    },
  },
  archive: {
    locked: {
      actionLabel: 'Check premiere again',
      body: 'Media stays hidden until the film is released.',
      title: 'Sealed until reveal',
    },
    delayed: {
      actionLabel: 'Check premiere again',
      body: 'Processing needs attention. No playback or download yet.',
      title: 'Reveal delayed',
    },
    processing: {
      actionLabel: 'Check premiere again',
      body: 'Processing. Playback is unavailable.',
      title: 'Preparing the group film',
    },
    released: {
      actionLabel: 'Play group film',
      body: 'Released for this group. Play it when you are ready.',
      title: 'Your group film is ready',
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
