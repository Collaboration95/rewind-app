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
import { useCapsule } from '../capsule/CapsuleProvider';
import { RevealEducationPanel } from '../capsule/RevealEducationPanel';
import type { ReleasedArchive, ReleasedArchiveMedia, ReleasedArchivePage } from '../domain/archive';
import type { CycleHistoryEntry, CycleHistoryPage } from '../domain/cycles';
import type { Premiere } from '../domain/premiere';
import { revealStateForPremiere } from '../domain/reveal-education';
import { RUNTIME_OFFLINE_MESSAGE, type RuntimeClient } from '../runtime/local-runtime-client';
import { useDemoSession } from '../session/DemoSessionProvider';
import { Glass } from '../ui/primitives';
import { FONT, WARM, serif } from '../ui/tokens';
import { createArchiveDownloadQueue } from './archive-download';

type ArchiveState =
  | { status: 'loading' }
  | { status: 'unavailable'; message: string }
  | {
      status: 'ready';
      premiere: Premiere;
      archive: ReleasedArchive;
      archivePage: ReleasedArchivePage;
      cycles: CycleHistoryEntry[];
      cyclePage: CycleHistoryPage;
    };

const EMPTY_ARCHIVE: ReleasedArchive = { films: [], clips: [] };

function PublishedPlayer({ premiere }: { premiere: Extract<Premiere, { state: 'ready' }> }) {
  const player = useVideoPlayer(premiere.playbackUrl, (instance) => {
    instance.loop = false;
  });
  return (
    <Glass style={styles.panel} testID="archive-premiere-ready">
      <RevealEducationPanel
        onAction={() => player.play()}
        state="released"
        surface="archive"
        testID="archive-reveal-released"
      />
      <Text style={styles.label}>GROUP PREMIERE</Text>
      <Text accessibilityRole="header" style={styles.title}>
        Your capsule film
      </Text>
      <Text style={styles.bodyText}>
        Released for this group. Play it together when you are ready.
      </Text>
      <VideoView
        accessible
        accessibilityLabel="Published capsule film player"
        contentFit="contain"
        nativeControls
        player={player}
        style={styles.player}
        testID="archive-video-player"
      />
    </Glass>
  );
}

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

export function ArchiveScreen({
  runtimeClient,
  onOpenFilm,
}: {
  runtimeClient: RuntimeClient | null;
  onOpenFilm?: (cycleId: string, label: string) => void;
}) {
  const { session } = useDemoSession();
  const { state } = useCapsule();
  const scope = state.status === 'ready' ? `${state.group?.id}:${state.cycle?.id}` : state.status;
  return (
    <ArchiveSurface
      key={`${session?.id}:${scope}`}
      runtimeClient={runtimeClient}
      onOpenFilm={onOpenFilm}
    />
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

function ArchiveSurface({
  runtimeClient,
  onOpenFilm,
}: {
  runtimeClient: RuntimeClient | null;
  onOpenFilm?: (cycleId: string, label: string) => void;
}) {
  const { session } = useDemoSession();
  const { state: capsuleState, retry: retryCapsule } = useCapsule();
  const [state, setState] = useState<ArchiveState>({ status: 'loading' });
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const downloadQueue = useRef(createArchiveDownloadQueue()).current;
  const cycle = capsuleState.status === 'ready' ? capsuleState.cycle : null;
  const group = capsuleState.status === 'ready' ? capsuleState.group : null;

  const load = () => {
    if (!session || !cycle || !group || !runtimeClient?.getPremiere) {
      setState({
        status: 'unavailable',
        message: 'Server-backed archive actions are unavailable without the local runtime.',
      });
      return;
    }
    setState({ status: 'loading' });
    void Promise.all([
      runtimeClient.getPremiere(session.id, group.id, cycle.id),
      runtimeClient.getReleasedArchivePage
        ? runtimeClient.getReleasedArchivePage(session.id, group.id, { limit: 50 })
        : runtimeClient.getReleasedArchive
          ? runtimeClient.getReleasedArchive(session.id, group.id).then((archive) => ({
              archive,
              filmCursor: null,
              clipCursor: null,
              hasMoreFilms: false,
              hasMoreClips: false,
            }))
          : Promise.resolve({
              archive: EMPTY_ARCHIVE,
              filmCursor: null,
              clipCursor: null,
              hasMoreFilms: false,
              hasMoreClips: false,
            }),
      runtimeClient.getCycleHistoryPage
        ? runtimeClient.getCycleHistoryPage(session.id, group.id, { limit: 50 })
        : runtimeClient.getCycleHistory
          ? runtimeClient.getCycleHistory(session.id, group.id).then((cycles) => ({
              cycles,
              nextCursor: null,
              hasMore: false,
            }))
          : Promise.resolve({
              cycles: cycle
                ? [
                    {
                      id: cycle.id,
                      prompt: cycle.prompt,
                      startsAt: cycle.startsAt,
                      endsAt: cycle.endsAt,
                      status: cycle.status,
                      releaseStatus: 'unpublished' as const,
                    },
                  ]
                : [],
              nextCursor: null,
              hasMore: false,
            }),
    ])
      .then(([premiere, archivePage, cyclePage]) =>
        setState({
          status: 'ready',
          premiere,
          archive: archivePage.archive,
          archivePage,
          cycles: cyclePage.cycles,
          cyclePage,
        }),
      )
      .catch((error: unknown) =>
        setState({
          status: 'unavailable',
          message: error instanceof Error ? error.message : RUNTIME_OFFLINE_MESSAGE,
        }),
      );
  };

  const loadMore = async () => {
    if (state.status !== 'ready' || !session || !group || loadingMore) return;
    const current = state;
    const canPageArchive = Boolean(runtimeClient?.getReleasedArchivePage);
    const canPageCycles = Boolean(runtimeClient?.getCycleHistoryPage);
    if (!canPageArchive && !canPageCycles) return;
    setLoadingMore(true);
    try {
      const [archivePage, cyclePage] = await Promise.all([
        canPageArchive && (current.archivePage.hasMoreFilms || current.archivePage.hasMoreClips)
          ? runtimeClient!.getReleasedArchivePage!(session.id, group.id, {
              filmCursor: current.archivePage.filmCursor,
              clipCursor: current.archivePage.clipCursor,
              includeFilms: current.archivePage.hasMoreFilms,
              includeClips: current.archivePage.hasMoreClips,
              limit: 50,
            })
          : Promise.resolve(null),
        canPageCycles && current.cyclePage.hasMore
          ? runtimeClient!.getCycleHistoryPage!(session.id, group.id, {
              cursor: current.cyclePage.nextCursor,
              limit: 50,
            })
          : Promise.resolve(null),
      ]);
      setState((latest) => {
        if (latest.status !== 'ready') return latest;
        const mergeById = <T extends { id: string }>(left: T[], right: T[]) => {
          const entries = new Map(left.map((entry) => [entry.id, entry]));
          for (const entry of right) entries.set(entry.id, entry);
          return [...entries.values()];
        };
        const nextArchive = archivePage
          ? {
              archive: {
                films: mergeById(latest.archive.films, archivePage.archive.films),
                clips: mergeById(latest.archive.clips, archivePage.archive.clips),
              },
              filmCursor: archivePage.hasMoreFilms ? archivePage.filmCursor : null,
              clipCursor: archivePage.hasMoreClips ? archivePage.clipCursor : null,
              hasMoreFilms: archivePage.hasMoreFilms,
              hasMoreClips: archivePage.hasMoreClips,
            }
          : latest.archivePage;
        const nextCycles = cyclePage
          ? {
              cycles: mergeById(latest.cycles, cyclePage.cycles),
              nextCursor: cyclePage.hasMore ? cyclePage.nextCursor : null,
              hasMore: cyclePage.hasMore,
            }
          : latest.cyclePage;
        return {
          ...latest,
          archive: nextArchive.archive,
          archivePage: nextArchive,
          cycles: nextCycles.cycles,
          cyclePage: nextCycles,
        };
      });
    } catch (error) {
      setDownloadNotice(
        error instanceof Error ? error.message : 'Older archive items could not load.',
      );
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void Promise.resolve().then(load);
    // `load` is intentionally recreated from the current session/cycle state;
    // it must refresh when a reveal or selected Demo member changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, cycle?.id, group?.id, runtimeClient]);

  const download = (media: ReleasedArchiveMedia) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setDownloadNotice(RUNTIME_OFFLINE_MESSAGE);
      return;
    }
    setDownloadNotice('Saving your authorized media…');
    void downloadQueue(media)
      .then((result) =>
        setDownloadNotice(
          result.method === 'browser' ? 'Opened the authorized media.' : 'Saved to this device.',
        ),
      )
      .catch(() =>
        setDownloadNotice(
          'The download could not be saved. Try again while the runtime is available.',
        ),
      );
  };

  if (state.status === 'loading') {
    return (
      <Glass style={styles.panel} testID="archive-loading">
        <Text accessibilityRole="header" style={styles.title} testID="route-heading-archive">
          Archive
        </Text>
        <Text style={styles.label}>ARCHIVE</Text>
        <Text accessibilityLiveRegion="polite" style={styles.title}>
          Checking the group premiere…
        </Text>
      </Glass>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <Glass style={styles.panel} testID="archive-unavailable">
        <Text accessibilityRole="header" style={styles.title} testID="route-heading-archive">
          Archive
        </Text>
        <Text style={styles.label}>ARCHIVE</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Premiere unavailable
        </Text>
        <Text accessibilityLiveRegion="assertive" style={styles.bodyText}>
          {state.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            retryCapsule();
            load();
          }}
          style={styles.retryButton}
        >
          <Text style={styles.retryText}>Retry premiere</Text>
        </Pressable>
      </Glass>
    );
  }

  const releasedCycleIds = new Set(
    state.cycles.filter((cycle) => cycle.releaseStatus === 'published').map((cycle) => cycle.id),
  );
  const premierePanel =
    state.premiere.state === 'ready' ? (
      releasedCycleIds.has(state.premiere.cycleId) ? (
        <View>
          <PublishedPlayer premiere={state.premiere} />
          {onOpenFilm ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenFilm(state.premiere.cycleId, 'Group premiere')}
              style={styles.retryButton}
              testID="demo-watch-film"
            >
              <Text style={styles.retryText}>Watch film</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <PremiereStatus
          premiere={{ state: 'locked', cycleId: state.premiere.cycleId }}
          reload={load}
          hasOlderReleasedMedia={state.archive.films.length > 0 || state.archive.clips.length > 0}
        />
      )
    ) : (
      <PremiereStatus
        premiere={state.premiere}
        reload={load}
        hasOlderReleasedMedia={state.archive.films.length > 0 || state.archive.clips.length > 0}
      />
    );
  // The server restricts real archive pages to published cycles. If locally
  // supplied cycle metadata is available, also hide any explicitly locked
  // entry; an older paged cycle with no metadata remains visible.
  const cycleById = new Map(state.cycles.map((entry) => [entry.id, entry]));
  const releasedArchive: ReleasedArchive = {
    films: state.archive.films.filter(
      (film) => cycleById.get(film.cycleId)?.releaseStatus !== 'unpublished',
    ),
    clips: state.archive.clips.filter(
      (clip) => cycleById.get(clip.cycleId)?.releaseStatus !== 'unpublished',
    ),
  };
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.stack}>
      <Text accessibilityRole="header" style={styles.title} testID="route-heading-archive">
        Archive
      </Text>
      {premierePanel}
      <ArchiveEntries
        archive={releasedArchive}
        cycles={state.cycles}
        hasMoreCycles={
          state.archivePage.hasMoreFilms ||
          state.archivePage.hasMoreClips ||
          state.cyclePage.hasMore
        }
        loadingMore={loadingMore}
        loadMore={() => void loadMore()}
        download={download}
        notice={downloadNotice}
        playFilm={
          onOpenFilm
            ? (film) =>
                onOpenFilm(
                  film.cycleId,
                  `Released ${new Date(film.publishedAt).toLocaleDateString()}`,
                )
            : undefined
        }
      />
    </ScrollView>
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
