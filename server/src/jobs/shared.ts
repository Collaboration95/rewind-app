// Constants and types shared by the clip and film job modules.

export type WorkerWorkObserver = () => void;

/** A worker claim is recoverable after a process dies without completing it. */
export const PROCESSING_CLAIM_LEASE_MS = 15 * 60 * 1000;
