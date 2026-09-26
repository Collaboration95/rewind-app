import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import type { ReleasedArchive, ReleasedArchiveMedia, ReleasedArchivePage } from '../domain/archive';
import type { CycleHistoryEntry, CycleHistoryPage } from '../domain/cycles';
import type { Premiere } from '../domain/premiere';
import { useCapsule } from '../capsule/CapsuleProvider';
import { RevealEducationPanel } from '../capsule/RevealEducationPanel';
import { useDemoSession } from '../session/DemoSessionProvider';
import { revealStateForPremiere } from '../domain/reveal-education';
import { RUNTIME_OFFLINE_MESSAGE, type RuntimeClient } from '../runtime/local-runtime-client';
import { COLORS } from '../theme';
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
    <View style={styles.panel} testID="archive-premiere-ready">
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
    </View>
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
}: {
  archive: ReleasedArchive;
  cycles: CycleHistoryEntry[];
  hasMoreCycles: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  download: (media: ReleasedArchiveMedia) => void;
  notice: string | null;
}) {
  const cycleById = new Map(cycles.map((cycle) => [cycle.id, cycle]));
  return (
    <View style={styles.panel} testID="archive-released-media">
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
    </View>
  );
}

export function ArchiveScreen({ runtimeClient }: { runtimeClient: RuntimeClient | null }) {
  const { session } = useDemoSession();
  const { state } = useCapsule();
  const scope = state.status === 'ready' ? `${state.group?.id}:${state.cycle?.id}` : state.status;
  return <ArchiveSurface key={`${session?.id}:${scope}`} runtimeClient={runtimeClient} />;
}

function ArchiveSurface({ runtimeClient }: { runtimeClient: RuntimeClient | null }) {
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
      <View style={styles.panel} testID="archive-loading">
        <Text accessibilityRole="header" style={styles.title} testID="route-heading-archive">
          Archive
        </Text>
        <Text style={styles.label}>ARCHIVE</Text>
        <Text accessibilityLiveRegion="polite" style={styles.title}>
          Checking the group premiere…
        </Text>
      </View>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <View style={styles.panel} testID="archive-unavailable">
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
      </View>
    );
  }

  const releasedCycleIds = new Set(
    state.cycles.filter((cycle) => cycle.releaseStatus === 'published').map((cycle) => cycle.id),
  );
  const premierePanel =
    state.premiere.state === 'ready' ? (
      releasedCycleIds.has(state.premiere.cycleId) ? (
        <PublishedPlayer premiere={state.premiere} />
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
  stack: { gap: 14 },
  panel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  label: { color: COLORS.edge, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.ink, fontSize: 26, fontWeight: '700' },
  sectionTitle: { color: COLORS.ink, fontSize: 22, fontWeight: '700' },
  subhead: { color: COLORS.ink, fontSize: 16, fontWeight: '700', marginTop: 4 },
  bodyText: { color: COLORS.muted, fontSize: 15, lineHeight: 22 },
  player: { backgroundColor: COLORS.deep, borderRadius: 8, height: 360, width: '100%' },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: COLORS.background,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  retryText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  entry: { borderTopColor: COLORS.line, borderTopWidth: 1, gap: 7, paddingTop: 12 },
  entryTitle: { color: COLORS.ink, fontSize: 16, fontWeight: '700' },
  entryMeta: { color: COLORS.muted, fontSize: 13 },
  downloadButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: COLORS.deep,
    borderRadius: 8,
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  downloadText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  notice: { color: COLORS.muted, fontSize: 14 },
});
