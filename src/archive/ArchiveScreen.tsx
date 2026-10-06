import { VideoView, useVideoPlayer } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  AuthRequestError,
  createRealAccountArchiveClient,
  type RealAccountArchiveClient,
  type RealArchiveFilm,
  type RealArchivePage,
} from '../auth/real-account-client';
import { RevealEducationPanel } from '../capsule/RevealEducationPanel';
import type { ReleasedArchive, ReleasedArchiveMedia } from '../domain/archive';
import type { CycleHistoryEntry } from '../domain/cycles';
import type { Premiere } from '../domain/premiere';
import { revealStateForPremiere } from '../domain/reveal-education';
import { Glass } from '../ui/primitives';
import { FONT, WARM, serif } from '../ui/tokens';
import { createArchiveDownloadQueue } from './archive-download';

function ArchiveEntries({
  archive,
  download,
  notice,
  cycles,
  hasMoreCycles,
  loadingMore,
  loadMore,
  playFilm,
}: {
  archive: ReleasedArchive;
  cycles: CycleHistoryEntry[];
  hasMoreCycles: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  download: (media: ReleasedArchiveMedia) => void;
  notice: string | null;
  playFilm?: (film: RealArchiveFilm) => void;
}) {
  const cycleById = new Map(cycles.map((cycle) => [cycle.id, cycle]));
  return (
    <Glass style={styles.panel} testID="archive-released-media">
      <Text style={styles.label}>RELEASED MEDIA</Text>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Your archive
      </Text>
      {archive.films.length === 0 ? (
        <Text style={styles.bodyText} testID="archive-empty-films">
          No released group films yet.
        </Text>
      ) : (
        archive.films.map((film) => (
          <View key={film.id} style={styles.entry}>
            <Text style={styles.entryTitle}>Group film</Text>
            <Text style={styles.entryMeta} testID={`archive-film-cycle-${film.id}`}>
              Cycle: {cycleById.get(film.cycleId)?.prompt ?? 'Previous cycle'}
            </Text>
            <Text style={styles.entryMeta}>
              Released {new Date(film.publishedAt).toLocaleDateString()}
            </Text>
            {playFilm ? (
              <Pressable
                accessibilityLabel="Play released group film with audio"
                accessibilityRole="button"
                onPress={() => playFilm(film as RealArchiveFilm)}
                style={styles.retryButton}
                testID={`archive-play-film-${film.id}`}
              >
                <Text style={styles.retryText}>Play film with audio</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel="Download released group film"
              accessibilityRole="button"
              onPress={() => download(film)}
              style={styles.downloadButton}
            >
              <Text style={styles.downloadText}>Download film</Text>
            </Pressable>
          </View>
        ))
      )}
      <Text style={styles.subhead}>Your released clips</Text>
      {archive.clips.length === 0 ? (
        <Text style={styles.bodyText} testID="archive-empty-clips">
          Your released clips will appear here.
        </Text>
      ) : (
        archive.clips.map((clip) => (
          <View key={clip.id} style={styles.entry}>
            <Text style={styles.entryTitle}>Your clip</Text>
            <Text style={styles.entryMeta} testID={`archive-clip-cycle-${clip.id}`}>
              Cycle: {cycleById.get(clip.cycleId)?.prompt ?? 'Previous cycle'}
            </Text>
            <Pressable
              accessibilityLabel="Download your released clip"
              accessibilityRole="button"
              onPress={() => download(clip)}
              style={styles.downloadButton}
            >
              <Text style={styles.downloadText}>Download clip</Text>
            </Pressable>
          </View>
        ))
      )}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {notice}
        </Text>
      ) : null}
      <Text accessibilityRole="header" style={styles.subhead}>
        Cycle history
      </Text>
      {cycles.map((cycle) => (
        <View key={cycle.id} style={styles.entry} testID={`archive-cycle-${cycle.id}`}>
          <Text style={styles.entryTitle}>{cycle.prompt}</Text>
          <Text style={styles.entryMeta}>
            {new Date(cycle.startsAt).toLocaleDateString()} –{' '}
            {new Date(cycle.endsAt).toLocaleDateString()}
          </Text>
          <Text style={styles.entryMeta}>{cycle.status}</Text>
          {cycle.releaseStatus === 'unpublished' ? (
            <Text style={styles.bodyText} testID={`archive-cycle-locked-${cycle.id}`}>
              This cycle is locked. Only its prompt and dates are available.
            </Text>
          ) : null}
        </View>
      ))}
      {hasMoreCycles ? (
        <Pressable
          accessibilityRole="button"
          disabled={loadingMore}
          onPress={loadMore}
          style={styles.retryButton}
          testID="archive-load-more"
        >
          <Text style={styles.retryText}>
            {loadingMore ? 'Loading…' : 'Load older archive items'}
          </Text>
        </Pressable>
      ) : null}
    </Glass>
  );
}

type PremiereAvailability =
  Exclude<Premiere, { state: 'ready' }> | { state: 'ready'; cycleId: string; filmId: string };

function availabilityForPremiere(premiere: Premiere): PremiereAvailability {
  if (premiere.state === 'ready') {
    return { state: 'ready', cycleId: premiere.cycleId, filmId: premiere.filmId };
  }
  return premiere;
}

function archiveFailureMessage(error: unknown): string {
  if (error instanceof AuthRequestError && error.status === 401) {
    return 'Your sign-in expired. Sign in again to open this group’s archive.';
  }
  if (error instanceof AuthRequestError && error.status === 403) {
    return 'You no longer have access to this group’s archive.';
  }
  if (error instanceof TypeError) {
    return 'The archive connection is unavailable. Reconnect and retry to refresh protected media.';
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'The archive is offline. Reconnect and retry to refresh protected media.';
  }
  return 'The archive could not load. The release may still be processing; retry when connected.';
}

function protectedMediaFailureMessage(error: unknown): string {
  if (error instanceof AuthRequestError && error.status === 401) {
    return 'Your sign-in expired. Sign in again to refresh protected media.';
  }
  if (error instanceof AuthRequestError && error.status === 403) {
    return 'You no longer have access to this group’s protected media.';
  }
  if (error instanceof AuthRequestError && error.status === 404) {
    return 'This media is no longer available to this group.';
  }
  if (
    error instanceof TypeError ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  ) {
    return 'The archive connection is unavailable. Reconnect and retry protected media.';
  }
  return 'The media could not be refreshed. Retry when the service is available.';
}

type RealArchiveViewState =
  | { status: 'loading' }
  | { status: 'unavailable'; message: string }
  | { status: 'ready'; page: RealArchivePage; premiere: PremiereAvailability };

export function RealAccountArchiveScreen({
  baseUrl,
  groupId,
  cycleId,
  authenticatedRequest,
  onBack,
}: {
  baseUrl: string | null;
  groupId: string;
  cycleId: string;
  authenticatedRequest: (path: string, init?: RequestInit) => Promise<Response>;
  onBack: () => void;
}) {
  const client = useMemo(
    () => (baseUrl ? createRealAccountArchiveClient(baseUrl, authenticatedRequest) : null),
    [authenticatedRequest, baseUrl],
  );
  const [state, setState] = useState<RealArchiveViewState>({ status: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [playbackTarget, setPlaybackTarget] = useState<{ cycleId: string; title: string } | null>(
    null,
  );
  const downloadQueue = useRef(createArchiveDownloadQueue()).current;
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    if (!client) {
      setState({ status: 'unavailable', message: 'The real-account archive is unavailable.' });
      return;
    }
    setState({ status: 'loading' });
    setNotice(null);
    try {
      const [page, premiere] = await Promise.all([
        client.getArchivePage(groupId, { limit: 50 }),
        client.getPremiere(groupId, cycleId),
      ]);
      if (version === requestVersion.current)
        setState({ status: 'ready', page, premiere: availabilityForPremiere(premiere) });
    } catch (error) {
      if (version !== requestVersion.current) return;
      setState({
        status: 'unavailable',
        message: archiveFailureMessage(error),
      });
    }
  }, [client, cycleId, groupId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => {
      requestVersion.current += 1;
    };
  }, [load]);

  const loadMore = async () => {
    if (!client || state.status !== 'ready' || loadingMore) return;
    const version = requestVersion.current;
    const previous = state.page;
    if (!previous.pagination.hasMoreFilms && !previous.pagination.hasMoreClips) return;
    setLoadingMore(true);
    try {
      const page = await client.getArchivePage(groupId, {
        filmCursor: previous.pagination.hasMoreFilms ? previous.pagination.filmCursor : null,
        clipCursor: previous.pagination.hasMoreClips ? previous.pagination.clipCursor : null,
        limit: 50,
      });
      if (version !== requestVersion.current) return;
      setState((latest) => {
        if (latest.status !== 'ready') return latest;
        const mergeById = <T extends { id: string }>(left: T[], right: T[]) => {
          const merged = new Map(left.map((entry) => [entry.id, entry]));
          for (const entry of right) merged.set(entry.id, entry);
          return [...merged.values()];
        };
        return {
          ...latest,
          page: {
            archive: {
              films: mergeById(latest.page.archive.films, page.archive.films),
              clips: mergeById(latest.page.archive.clips, page.archive.clips),
            },
            pagination: page.pagination,
          },
        };
      });
    } catch (error) {
      if (version === requestVersion.current) {
        setNotice(archiveFailureMessage(error));
      }
    } finally {
      if (version === requestVersion.current) setLoadingMore(false);
    }
  };

  const download = async (media: ReleasedArchiveMedia) => {
    if (!client || ('contributionId' in media && !media.contributionId)) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setNotice('The archive is offline. Reconnect before downloading this media.');
      return;
    }
    const version = requestVersion.current;
    setNotice('Refreshing access and saving your media…');
    try {
      const fresh = await client.getFreshArchiveMedia(
        groupId,
        'contributionId' in media
          ? { id: media.id, contributionId: media.contributionId }
          : { id: media.id },
      );
      if (version !== requestVersion.current) return;
      const result = await downloadQueue(fresh);
      if (version === requestVersion.current) {
        setNotice(
          result.method === 'browser' ? 'Opened the authorized media.' : 'Saved to this device.',
        );
      }
    } catch (error) {
      if (version !== requestVersion.current) return;
      setNotice(protectedMediaFailureMessage(error));
    }
  };

  if (state.status === 'loading') {
    return (
      <Glass style={styles.panel} testID="real-archive-loading">
        <Text accessibilityRole="header" style={styles.title} testID="route-heading-archive">
          Archive
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.bodyText}>
          Refreshing this group’s releases…
        </Text>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.retryButton}>
          <Text style={styles.retryText}>Back to group</Text>
        </Pressable>
      </Glass>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <Glass style={styles.panel} testID="real-archive-unavailable">
        <Text accessibilityRole="header" style={styles.title} testID="route-heading-archive">
          Archive
        </Text>
        <Text accessibilityRole="alert" style={styles.bodyText}>
          {state.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void load()}
          style={styles.retryButton}
        >
          <Text style={styles.retryText}>Retry archive</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.retryButton}>
          <Text style={styles.retryText}>Back to group</Text>
        </Pressable>
      </Glass>
    );
  }

  const currentPlayer =
    state.premiere.state === 'ready' ? (
      <RealCapabilityPlayer
        client={client!}
        groupId={groupId}
        cycleId={cycleId}
        title="Current group premiere"
        initialAvailability={state.premiere}
      />
    ) : state.premiere.state === 'failed' ? (
      <PremiereStatus
        premiere={state.premiere}
        reload={() => void load()}
        hasOlderReleasedMedia={
          state.page.archive.films.length > 0 || state.page.archive.clips.length > 0
        }
      />
    ) : (
      <PremiereStatus
        premiere={state.premiere}
        reload={() => void load()}
        hasOlderReleasedMedia={
          state.page.archive.films.length > 0 || state.page.archive.clips.length > 0
        }
      />
    );
  const playing = playbackTarget ? (
    <RealCapabilityPlayer
      key={`${groupId}:${playbackTarget.cycleId}`}
      client={client!}
      groupId={groupId}
      cycleId={playbackTarget.cycleId}
      title={playbackTarget.title}
      initiallyReady
      onClose={() => setPlaybackTarget(null)}
    />
  ) : null;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.stack}>
      <View style={styles.archiveHeader}>
        <Text accessibilityRole="header" style={styles.title} testID="route-heading-archive">
          Archive
        </Text>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.retryButton}>
          <Text style={styles.retryText}>Back to group</Text>
        </Pressable>
      </View>
      {playing ?? currentPlayer}
      <ArchiveEntries
        archive={state.page.archive}
        cycles={[]}
        hasMoreCycles={state.page.pagination.hasMoreFilms || state.page.pagination.hasMoreClips}
        loadingMore={loadingMore}
        loadMore={() => void loadMore()}
        download={(media) => void download(media)}
        notice={notice}
        playFilm={(film) =>
          setPlaybackTarget({ cycleId: film.cycleId, title: 'Released group film' })
        }
      />
    </ScrollView>
  );
}

function RealCapabilityPlayer({
  client,
  groupId,
  cycleId,
  title,
  initialAvailability,
  initiallyReady = false,
  onClose,
}: {
  client: RealAccountArchiveClient;
  groupId: string;
  cycleId: string;
  title: string;
  initialAvailability?: PremiereAvailability;
  initiallyReady?: boolean;
  onClose?: () => void;
}) {
  const player = useVideoPlayer(null, (instance) => {
    instance.loop = false;
    instance.muted = false;
    instance.volume = 1;
  });
  const [availability, setAvailability] = useState<PremiereAvailability | null>(
    initialAvailability ?? null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [renewalError, setRenewalError] = useState<string | null>(null);
  const opened = useRef(false);
  const alive = useRef(true);
  const renewSequence = useRef(0);

  useEffect(
    () => () => {
      alive.current = false;
      renewSequence.current += 1;
    },
    [],
  );

  const renewAndPlay = useCallback(
    async (shouldPlay: boolean) => {
      const sequence = ++renewSequence.current;
      const previousPosition = player.currentTime;
      setNotice('Refreshing this film’s playback access…');
      try {
        const fresh = await client.getPremiere(groupId, cycleId);
        if (!alive.current || sequence !== renewSequence.current) return;
        setAvailability(availabilityForPremiere(fresh));
        if (fresh.state !== 'ready') {
          player.pause();
          setRenewalError(null);
          setNotice(null);
          return;
        }
        if (player.playing) player.pause();
        await player.replaceAsync(fresh.playbackUrl);
        if (!alive.current || sequence !== renewSequence.current) return;
        if (
          previousPosition > 0 &&
          (!Number.isFinite(player.duration) ||
            player.duration <= 0 ||
            previousPosition < player.duration)
        ) {
          player.seekBy(previousPosition - player.currentTime);
        }
        setRenewalError(null);
        setNotice(null);
        if (shouldPlay) {
          opened.current = true;
          player.play();
        }
      } catch (error) {
        if (!alive.current || sequence !== renewSequence.current) return;
        player.pause();
        setNotice(null);
        setRenewalError(protectedMediaFailureMessage(error));
      }
    },
    [client, cycleId, groupId, player],
  );

  useEffect(() => {
    let previous = AppState.currentState;
    let resumePlayback = false;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'inactive' || next === 'background') {
        resumePlayback = player.playing;
      }
      if (
        next === 'active' &&
        (previous === 'inactive' || previous === 'background') &&
        opened.current
      ) {
        void renewAndPlay(resumePlayback);
        resumePlayback = false;
      }
      previous = next;
    });
    return () => subscription.remove();
  }, [player, renewAndPlay]);

  const canPlay = !renewalError && (initiallyReady || availability?.state === 'ready');
  return (
    <Glass style={styles.panel} testID="real-archive-player-panel">
      <Text style={styles.label}>GROUP PREMIERE</Text>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {canPlay ? (
        <>
          <Text style={styles.bodyText}>
            Playback refreshes its authorized link before starting.
          </Text>
          <Pressable
            accessibilityLabel="Play group film with audio"
            accessibilityRole="button"
            onPress={() => void renewAndPlay(true)}
            style={styles.downloadButton}
            testID="real-archive-play"
          >
            <Text style={styles.downloadText}>Play with audio</Text>
          </Pressable>
          <VideoView
            accessible
            accessibilityLabel="Group premiere video player with audio"
            contentFit="contain"
            nativeControls
            player={player}
            style={styles.player}
            testID="real-archive-video-player"
          />
        </>
      ) : (
        <>
          <Text style={styles.bodyText}>
            {renewalError ??
              (availability?.state === 'failed'
                ? 'This group film failed processing. No playback or download is available until recovery succeeds.'
                : availability?.state === 'processing'
                  ? 'This group film is still processing.'
                  : availability?.state === 'delayed'
                    ? 'This group film is delayed. Its release will remain here.'
                    : 'This cycle has no released film available yet.')}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void renewAndPlay(false)}
            style={styles.retryButton}
            testID="real-archive-refresh-playback"
          >
            <Text style={styles.retryText}>
              {renewalError ? 'Retry playback access' : 'Check playback availability'}
            </Text>
          </Pressable>
        </>
      )}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {notice}
        </Text>
      ) : null}
      {onClose ? (
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.retryButton}>
          <Text style={styles.retryText}>Close player</Text>
        </Pressable>
      ) : null}
    </Glass>
  );
}

function PremiereStatus({
  premiere,
  reload,
  hasOlderReleasedMedia = false,
}: {
  premiere: Exclude<Premiere, { state: 'ready' }>;
  reload: () => void;
  hasOlderReleasedMedia?: boolean;
}) {
  if (premiere.state === 'failed') {
    return (
      <Glass style={styles.panel} testID="archive-premiere-failed">
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Film processing failed
        </Text>
        <Text style={styles.bodyText}>
          No source media is available. Check again after the group film recovery is resolved.
        </Text>
        <Pressable accessibilityRole="button" onPress={reload} style={styles.retryButton}>
          <Text style={styles.retryText}>Check premiere again</Text>
        </Pressable>
        {hasOlderReleasedMedia ? (
          <Text style={styles.bodyText} testID="archive-current-cycle-context">
            Previously released group films and your clips remain available below.
          </Text>
        ) : null}
      </Glass>
    );
  }
  const state = revealStateForPremiere(premiere);
  return (
    <View style={styles.stack}>
      <RevealEducationPanel
        onAction={reload}
        state={state}
        surface="archive"
        testID={`archive-${premiere.state}`}
      />
      {hasOlderReleasedMedia ? (
        <Text style={styles.bodyText} testID="archive-current-cycle-context">
          This status is for the current cycle. Previously released media remains available below.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14, padding: 22, paddingBottom: 32 },
  archiveHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  panel: {
    backgroundColor: WARM.sheet,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  label: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  title: { color: WARM.ink, ...serif(30) },
  sectionTitle: { color: WARM.ink, fontFamily: FONT.body, fontSize: 22, fontWeight: '700' },
  subhead: {
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 16,
    fontWeight: '700',
    marginTop: 4,
  },
  bodyText: { color: WARM.muted, fontFamily: FONT.body, fontSize: 15, lineHeight: 22 },
  player: { backgroundColor: WARM.sheet, borderRadius: 24, height: 360, width: '100%' },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: WARM.bg,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  retryText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 14, fontWeight: '700' },
  entry: { borderTopColor: WARM.line, borderTopWidth: 1, gap: 7, paddingTop: 12 },
  entryTitle: { color: WARM.ink, fontFamily: FONT.body, fontSize: 16, fontWeight: '700' },
  entryMeta: { color: WARM.muted, fontSize: 13 },
  downloadButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: WARM.sheet,
    borderRadius: 24,
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  downloadText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 14, fontWeight: '700' },
  notice: { color: WARM.muted, fontSize: 14 },
});
