import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import { createArchiveDownloadQueue } from '../archive/archive-download';
import type { RealAccountArchiveClient, RealArchiveClip } from '../auth/real-account-client';
import type { FilmSegment } from '../domain/premiere';
import { Icon } from '../ui/Icon';
import {
  Button,
  Dialog,
  IconButton,
  TextLink,
  rw,
  useScreenInsets,
  useToast,
} from '../ui/primitives';
import { FONT, serif } from '../ui/tokens';
import { ReportSheet } from './ReportSheet';
import { createFilmPlayback } from './film-playback';
import { reportContent } from './safety';

type Request = (path: string, init?: RequestInit) => Promise<Response>;

/** The segment playing at `time`, by index into `segments`. */
export function segmentAt(segments: FilmSegment[], time: number): number {
  for (let index = segments.length - 1; index >= 0; index -= 1)
    if (time >= segments[index].startSeconds - 0.05) return index;
  return 0;
}

/** F1, F3, F4: the film full screen, its end card and reporting a moment. */
export function FilmScreen({
  client,
  request,
  groupId,
  cycleId,
  label,
  isOwner,
  onClose,
  onChat,
}: {
  client: RealAccountArchiveClient;
  request: Request;
  groupId: string;
  cycleId: string;
  /** "Premiere · 18 h left" or "Released 5 Oct". */
  label: string;
  isOwner: boolean;
  onClose: () => void;
  onChat: () => void;
}) {
  const insets = useScreenInsets();
  const toast = useToast();
  const player = useVideoPlayer(null, (instance) => {
    instance.loop = false;
    instance.muted = false;
    instance.timeUpdateEventInterval = 0.25;
  });
  const [step, setStep] = useState<'loading' | 'play' | 'end' | 'error'>('loading');
  const [filmId, setFilmId] = useState<string | null>(null);
  const [segments, setSegments] = useState<FilmSegment[] | null>(null);
  const [time, setTime] = useState(0);
  // Paused until the player reports that it is playing.
  const [paused, setPaused] = useState(true);
  const [reporting, setReporting] = useState<FilmSegment | null>(null);
  const [removing, setRemoving] = useState<FilmSegment | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [ownClips, setOwnClips] = useState<RealArchiveClip[]>([]);
  const downloads = useRef(createArchiveDownloadQueue()).current;
  const alive = useRef(true);
  const videoView = useRef<VideoView>(null);
  const getWebVideo = useCallback(
    () => (videoView.current?.nativeRef.current as HTMLVideoElement | null) ?? null,
    [],
  );
  const onPlaybackBlocked = useCallback(() => {
    if (alive.current) setPaused(true);
  }, []);
  const onPlaybackError = useCallback(() => {
    if (alive.current) {
      setPaused(true);
      setStep('error');
    }
  }, []);
  const playback = useMemo(() => createFilmPlayback(player), [player]);
  useEffect(() => {
    alive.current = true;
    playback.connect(
      Platform.OS === 'web' ? getWebVideo : undefined,
      onPlaybackBlocked,
      onPlaybackError,
    );
    return () => {
      alive.current = false;
      playback.dispose();
    };
  }, [getWebVideo, onPlaybackBlocked, onPlaybackError, playback]);

  const open = useCallback(async () => {
    setStep('loading');
    try {
      const premiere = await client.getPremiere(groupId, cycleId);
      if (!alive.current) return;
      if (premiere.state !== 'ready') {
        setStep('error');
        return;
      }
      setFilmId(premiere.filmId);
      // Your own released moments from this cycle, for "Save your own moments".
      void client
        .getArchivePage(groupId, { limit: 50 })
        .then((page) => {
          if (alive.current)
            setOwnClips(page.archive.clips.filter((clip) => clip.cycleId === cycleId));
        })
        .catch(() => undefined);
      setSegments(premiere.segments ?? null);
      await playback.replaceAsync(premiere.playbackUrl);
      if (!alive.current) return;
      setTime(0);
      setStep('play');
      playback.play();
    } catch {
      if (alive.current) setStep('error');
    }
  }, [client, cycleId, groupId, playback]);
  useEffect(() => {
    void Promise.resolve().then(open);
  }, [open]);

  const visible = useMemo(() => (segments ?? []).filter((segment) => !segment.hidden), [segments]);
  const end = useCallback(() => {
    playback.pause();
    setStep('end');
  }, [playback]);
  const seekTo = useCallback(
    (seconds: number) => {
      player.seekBy(seconds - player.currentTime);
      setTime(seconds);
    },
    [player],
  );

  useEffect(() => {
    const onTime = player.addListener('timeUpdate', ({ currentTime }: { currentTime: number }) => {
      setTime(currentTime);
      if (!segments) return;
      // Hidden moments (blocked, reported or removed) are skipped for this viewer.
      const index = segmentAt(segments, currentTime);
      const current = segments[index];
      if (current?.hidden) {
        const next = segments.slice(index + 1).find((segment) => !segment.hidden);
        if (next) seekTo(next.startSeconds);
        else end();
      }
    });
    const onEnd = player.addListener('playToEnd', end);
    // Follow the player, not our request: a browser that blocks autoplay leaves
    // the film paused, so the button must offer Play.
    const onPlaying = player.addListener('playingChange', ({ isPlaying }: { isPlaying: boolean }) =>
      setPaused(!isPlaying),
    );
    return () => {
      onTime.remove();
      onEnd.remove();
      onPlaying.remove();
    };
  }, [end, player, seekTo, segments]);

  const currentIndex = segments ? segmentAt(segments, time) : 0;
  const current = segments?.[currentIndex] ?? null;
  const visibleIndex = current ? visible.indexOf(current) : -1;
  const skip = (direction: 1 | -1) => {
    if (!visible.length) return;
    const target = visible[visibleIndex + direction];
    if (target) seekTo(target.startSeconds);
    else if (direction === 1) end();
    else seekTo(visible[0].startSeconds);
  };
  const togglePause = () => {
    if (paused) playback.play();
    else playback.pause();
  };
  // The end card reports the last moment someone else made (not your own).
  const others = visible.filter((segment) => !segment.mine);
  const lastVisible =
    (visibleIndex >= 0
      ? others
          .filter((segment) => segment.startSeconds <= visible[visibleIndex].startSeconds)
          .at(-1)
      : others.at(-1)) ?? null;

  const saveFilm = async () => {
    if (!filmId) return;
    try {
      const fresh = await client.getFreshArchiveMedia(groupId, { id: filmId });
      await downloads(fresh);
      toast('Saved.');
    } catch {
      toast('The film could not be saved. Try again when connected.');
    }
  };
  const saveMine = async () => {
    try {
      for (const clip of ownClips)
        await downloads(
          await client.getFreshArchiveMedia(groupId, {
            id: clip.id,
            contributionId: clip.contributionId,
          }),
        );
      toast('Saved.');
    } catch {
      toast('Your moments could not be saved. Try again when connected.');
    }
  };
  const remove = async () => {
    if (!removing) return;
    setRemovePending(true);
    try {
      const response = await request(
        `/real/groups/${encodeURIComponent(groupId)}/contributions/${encodeURIComponent(removing.contributionId)}/remove`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!response.ok) throw new Error('remove');
      const id = removing.contributionId;
      setSegments(
        (list) =>
          list?.map((segment) =>
            segment.contributionId === id ? { ...segment, hidden: true } : segment,
          ) ?? null,
      );
      setRemoving(null);
      toast('Removed. Nobody sees this moment any more.');
    } catch {
      toast('The moment could not be removed. Try again.');
    } finally {
      setRemovePending(false);
    }
  };

  return (
    <View style={styles.screen} testID="real-film" {...rw('film-end')}>
      <VideoView
        ref={videoView}
        accessibilityLabel="Group film"
        contentFit="contain"
        nativeControls={false}
        player={player}
        style={[styles.fillVideo, step === 'end' && styles.dimmed]}
        testID="real-film-video"
      />
      {step === 'play' ? (
        <View style={StyleSheet.absoluteFill}>
          <Pressable
            accessibilityLabel="Previous moment"
            onPress={() => skip(-1)}
            style={styles.zoneLeft}
            testID="real-film-back"
          />
          <Pressable
            accessibilityLabel="Next moment"
            onPress={() => skip(1)}
            style={styles.zoneRight}
            testID="real-film-next"
          />
        </View>
      ) : null}
      <View style={[styles.top, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
        <View accessibilityElementsHidden style={styles.bar}>
          {(visible.length ? visible : [null]).map((segment, index) => {
            const done = segment ? visibleIndex > index || step === 'end' : step === 'end';
            const now = segment ? visibleIndex === index && step === 'play' : step === 'play';
            const fill = !segment
              ? player.duration > 0
                ? Math.min(1, time / player.duration)
                : 0
              : Math.min(1, Math.max(0, (time - segment.startSeconds) / segment.durationSeconds));
            return (
              <View
                key={segment?.contributionId ?? 'film'}
                style={[styles.seg, segment && { flex: segment.durationSeconds }]}
              >
                <View
                  style={[styles.segFill, { width: `${(done ? 1 : now ? fill : 0) * 100}%` }]}
                />
              </View>
            );
          })}
        </View>
        <View style={styles.topRow}>
          <Text style={styles.label}>{label}</Text>
          <IconButton
            dark
            icon="close"
            label="Close film"
            onPress={() => {
              playback.pause();
              onClose();
            }}
            testID="real-film-close"
          />
        </View>
      </View>
      {step === 'loading' ? <Text style={styles.status}>Opening the film…</Text> : null}
      {step === 'error' ? (
        <View style={styles.center}>
          <Text accessibilityRole="header" style={styles.endTitle}>
            Couldn’t open the film
          </Text>
          <Button label="Try again" onPress={() => void open()} testID="real-film-retry" />
        </View>
      ) : null}
      {step === 'play' ? (
        <View
          style={[styles.controls, { paddingBottom: insets.bottom + 10 }]}
          pointerEvents="box-none"
        >
          {current && !current.hidden && !current.mine ? (
            <View style={styles.moment}>
              <TextLink
                color="#fff"
                label="Report"
                onPress={() => {
                  playback.pause();
                  setPaused(true);
                  setReporting(current);
                }}
                testID="real-film-report"
              />
              {isOwner ? (
                <TextLink
                  color="#fff"
                  label="Remove this moment"
                  onPress={() => {
                    playback.pause();
                    setPaused(true);
                    setRemoving(current);
                  }}
                  testID="real-film-remove"
                />
              ) : null}
            </View>
          ) : (
            <View />
          )}
          <IconButton
            dark
            icon={paused ? 'play' : 'pause'}
            label={paused ? 'Play' : 'Pause'}
            onPress={togglePause}
            size={52}
            testID="real-film-pause"
          />
        </View>
      ) : null}
      {step === 'end' ? (
        <View style={[styles.end, { paddingBottom: insets.bottom + 16 }]} testID="real-film-end">
          <Text accessibilityRole="header" style={styles.endTitle}>
            The end
          </Text>
          <Text style={styles.endNote}>{label}</Text>
          <Button
            icon="chat"
            label="Talk about it in Chat"
            onPress={onChat}
            testID="real-film-chat"
            variant="primary"
          />
          <View style={styles.two}>
            <Button
              icon="replay"
              label="Replay"
              onPress={() => void open()}
              style={styles.half}
              testID="real-film-replay"
              variant="glass"
            />
            <Button
              icon="save"
              label="Save film"
              onPress={() => void saveFilm()}
              style={styles.half}
              testID="real-film-save"
              variant="glass"
            />
          </View>
          {ownClips.length ? (
            <TextLink
              color="#fff"
              label="Save your own moments"
              onPress={() => void saveMine()}
              testID="real-film-save-mine"
            />
          ) : null}
          {lastVisible ? (
            <TextLink
              color="#fff"
              label="Report a moment"
              onPress={() => setReporting(lastVisible)}
              testID="real-film-report-end"
            />
          ) : null}
        </View>
      ) : null}
      {reporting ? (
        <ReportSheet
          onCancel={() => setReporting(null)}
          onSend={async (reason) => {
            try {
              await reportContent(
                request,
                groupId,
                { contributionId: reporting.contributionId },
                reason,
              );
              const id = reporting.contributionId;
              // A reported moment is hidden for the reporter straight away.
              setSegments(
                (list) =>
                  list?.map((segment) =>
                    segment.contributionId === id ? { ...segment, hidden: true } : segment,
                  ) ?? null,
              );
              setReporting(null);
              toast('Thanks. The Rewind team reviews reports within 24 hours.');
              return null;
            } catch (failure) {
              return failure instanceof Error
                ? failure.message
                : 'The report could not be sent. Try again.';
            }
          }}
          what="moment"
        />
      ) : null}
      {removing ? (
        <Dialog
          body="It’s hidden from the film for everyone in the group. The person who took it isn’t told."
          label="Remove moment confirmation"
          onDismiss={removePending ? undefined : () => setRemoving(null)}
          testID="real-film-remove-dialog"
          title="Remove this moment?"
        >
          <Button disabled={removePending} label="Keep it" onPress={() => setRemoving(null)} />
          <Button
            busy={removePending}
            busyLabel="Removing…"
            label="Remove"
            onPress={() => void remove()}
            testID="real-film-remove-confirm"
            variant="danger"
          />
        </Dialog>
      ) : null}
      {step === 'play' && paused ? (
        <View pointerEvents="none" style={styles.pausedBadge}>
          <Icon color="#fff" name="pause" size={28} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#0f0a07', flex: 1, overflow: 'hidden' },
  // A web <video> keeps its intrinsic size inside absolute insets; size it explicitly.
  fillVideo: {
    bottom: 0,
    height: '100%',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    width: '100%',
  },

  dimmed: { opacity: 0.25 },
  zoneLeft: { bottom: 120, left: 0, position: 'absolute', top: 90, width: '33%' },
  zoneRight: { bottom: 120, position: 'absolute', right: 0, top: 90, width: '67%' },
  top: { left: 0, paddingHorizontal: 14, position: 'absolute', right: 0, top: 0 },
  bar: { flexDirection: 'row', gap: 3, height: 3 },
  seg: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 2,
    flex: 1,
    overflow: 'hidden',
  },
  segFill: { backgroundColor: '#fff', height: '100%' },
  topRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  label: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontFamily: FONT.body,
    fontSize: 13,
    fontWeight: '500',
  },
  status: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontFamily: FONT.body,
    fontSize: 14,
    marginTop: '80%',
    textAlign: 'center',
  },
  center: {
    alignItems: 'center',
    gap: 16,
    justifyContent: 'center',
    marginTop: '70%',
    paddingHorizontal: 32,
  },
  controls: {
    alignItems: 'flex-end',
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: 18,
    position: 'absolute',
    right: 0,
  },
  moment: { alignItems: 'flex-start', gap: 4 },
  end: {
    backgroundColor: 'rgba(15, 10, 7, 0.92)',
    bottom: 0,
    gap: 12,
    left: 0,
    paddingHorizontal: 22,
    paddingTop: 24,
    position: 'absolute',
    right: 0,
  },
  endTitle: { color: '#fff', textAlign: 'center', ...serif(34) },
  endNote: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontFamily: FONT.body,
    fontSize: 13,
    marginBottom: 8,
    textAlign: 'center',
  },
  two: { flexDirection: 'row', gap: 10 },
  half: { flex: 1, width: undefined },
  pausedBadge: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    borderRadius: 32,
    height: 64,
    justifyContent: 'center',
    position: 'absolute',
    top: '45%',
    width: 64,
  },
});
