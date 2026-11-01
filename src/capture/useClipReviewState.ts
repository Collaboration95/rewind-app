import { useMemo, useState } from 'react';

import { DEFAULT_CAPTURE_MODE, type CaptureMode, type RecordedClip } from '../domain/video';
import { ClipReviewSession, InMemoryPendingClipMetadataStore } from './video-review';

/** The recorded clip under review: its session, trim window, look and panel size. */
export function useClipReviewState() {
  const reviewStore = useMemo(() => new InMemoryPendingClipMetadataStore(), []);
  const [clip, setClip] = useState<RecordedClip | null>(null);
  const [review, setReview] = useState<ClipReviewSession | null>(null);
  const [reviewPanelHeight, setReviewPanelHeight] = useState(280);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [mode, setMode] = useState<CaptureMode>(DEFAULT_CAPTURE_MODE);

  const changeTrim = (start: number, end: number) => {
    if (!review || !review.setTrim(start, end).ok) return;
    setTrimStart(start);
    setTrimEnd(end);
  };

  return {
    changeTrim,
    clip,
    mode,
    review,
    reviewPanelHeight,
    reviewStore,
    setClip,
    setMode,
    setReview,
    setReviewPanelHeight,
    setTrimEnd,
    setTrimStart,
    trimEnd,
    trimStart,
  };
}
