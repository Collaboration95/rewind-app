import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import type { ReleasedArchive, ReleasedArchiveMedia, ReleasedArchivePage } from '../domain/archive';
import type { CycleHistoryEntry, CycleHistoryPage } from '../domain/cycles';
import type { Premiere } from '../domain/premiere';
import { useCapsule } from '../capsule/CapsuleProvider';
import { RevealEducationPanel } from '../capsule/RevealEducationPanel';
import { useDemoSession } from '../session/DemoSessionProvider';
import { revealStateForPremiere } from '../domain/reveal-education';
import { RUNTIME_OFFLINE_MESSAGE, type RuntimeClient } from '../runtime/local-runtime-client';
import type { ScreenDebug } from '../debug/DebugProvider';
import { useI18n } from '../i18n/LanguageProvider';
import { COLORS } from '../theme';
import {
  ActionButton,
  ButtonRow,
  Eyebrow,
  MockMedia,
  Notice,
  Panel,
  Quiet,
  ScreenIntro,
  kitStyles,
} from '../ui/kit';
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

function PublishedPlayer({
  groupName,
  premiere,
}: {
  groupName: string | null;
  premiere: Extract<Premiere, { state: 'ready' }>;
}) {
  const { t } = useI18n();
  const player = useVideoPlayer(premiere.playbackUrl, (instance) => {
    instance.loop = false;
  });
  return (
    <View style={styles.panel} testID="archive-premiere-ready">
      <Eyebrow>{t('RELEASED FOR THIS GROUP')}</Eyebrow>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {groupName ?? t('Your group film')}
      </Text>
      <VideoView
        accessible
        accessibilityLabel={t('Published capsule film player')}
        contentFit="contain"
        nativeControls
        player={player}
        style={styles.player}
        testID="archive-video-player"
      />
      <RevealEducationPanel
        onAction={() => player.play()}
        state="released"
        surface="archive"
        testID="archive-reveal-released"
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
  const { t } = useI18n();
  const cycleById = new Map(cycles.map((cycle) => [cycle.id, cycle]));
  return (
    <View style={styles.panel} testID="archive-released-media">
      <Eyebrow>{t('RELEASED MEDIA')}</Eyebrow>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {t('Your archive')}
      </Text>
      {archive.films.length === 0 ? (
        <Text style={styles.bodyText} testID="archive-empty-films">
          {t('No released group films yet.')}
        </Text>
      ) : (
        archive.films.map((film) => (
          <View key={film.id} style={styles.entry}>
            <Text style={styles.entryTitle}>{t('Group film')}</Text>
            <Text style={styles.entryMeta} testID={`archive-film-cycle-${film.id}`}>
              {t('Cycle: {prompt}', {
                prompt: t(cycleById.get(film.cycleId)?.prompt ?? 'Previous cycle'),
              })}
            </Text>
            <Text style={styles.entryMeta}>
              {t('Released {date}', { date: new Date(film.publishedAt).toLocaleDateString() })}
            </Text>
            <ActionButton
              accessibilityLabel={t('Download released group film')}
              label={t('Download film')}
              onPress={() => download(film)}
            />
          </View>
        ))
      )}
      <Text style={styles.subhead}>{t('Your released clips')}</Text>
      {archive.clips.length === 0 ? (
        <Text style={styles.bodyText} testID="archive-empty-clips">
          {t('Your released clips will appear here.')}
        </Text>
      ) : (
        archive.clips.map((clip) => (
          <View key={clip.id} style={styles.entry}>
            <Text style={styles.entryTitle}>{t('Your clip')}</Text>
            <Text style={styles.entryMeta} testID={`archive-clip-cycle-${clip.id}`}>
              {t('Cycle: {prompt}', {
                prompt: t(cycleById.get(clip.cycleId)?.prompt ?? 'Previous cycle'),
              })}
            </Text>
            <ActionButton
              accessibilityLabel={t('Download your released clip')}
              label={t('Download clip')}
              onPress={() => download(clip)}
            />
          </View>
        ))
      )}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {t(notice)}
        </Text>
      ) : null}
      <Text accessibilityRole="header" style={styles.subhead}>
        {t('Cycle history')}
      </Text>
      {cycles.map((cycle) => (
        <View key={cycle.id} style={styles.entry} testID={`archive-cycle-${cycle.id}`}>
          <Text style={styles.entryTitle}>{t(cycle.prompt)}</Text>
          <Text style={styles.entryMeta}>
            {new Date(cycle.startsAt).toLocaleDateString()} –{' '}
            {new Date(cycle.endsAt).toLocaleDateString()}
          </Text>
          <Text style={styles.entryMeta}>{t(cycle.status)}</Text>
          {cycle.releaseStatus === 'unpublished' ? (
            <Text style={styles.bodyText} testID={`archive-cycle-locked-${cycle.id}`}>
              {t('This cycle is locked. Only its prompt and dates are available.')}
            </Text>
          ) : null}
        </View>
      ))}
      {hasMoreCycles ? (
        <ActionButton
          busy={loadingMore}
          label={loadingMore ? t('Loading…') : t('Load older archive items')}
          onPress={loadMore}
          testID="archive-load-more"
        />
      ) : null}
    </View>
  );
}

export type ArchiveDebugScenario =
  'loading' | 'empty' | 'denied' | 'error' | 'processing' | 'delayed' | 'released';

export function ArchiveScreen({
  debug,
  runtimeClient,
}: {
  debug?: ScreenDebug<ArchiveDebugScenario>;
  runtimeClient: RuntimeClient | null;
}) {
  const { session } = useDemoSession();
  const { state } = useCapsule();
  const scope = state.status === 'ready' ? `${state.group?.id}:${state.cycle?.id}` : state.status;
  return (
    <ArchiveSurface debug={debug} key={`${session?.id}:${scope}`} runtimeClient={runtimeClient} />
  );
}

function ArchiveSurface({
  debug,
  runtimeClient,
}: {
  debug?: ScreenDebug<ArchiveDebugScenario>;
  runtimeClient: RuntimeClient | null;
}) {
  const { t } = useI18n();
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

  const groupName = group?.name ?? capsuleState.group?.name ?? null;
  const scenario = debug?.scenario ?? null;
  const frame = (children: ReactNode) => (
    <ScrollView contentContainerStyle={kitStyles.content} style={kitStyles.scroll}>
      <ScreenIntro
        body={groupName ?? undefined}
        eyebrow={t('ARCHIVE')}
        headingTestID="route-heading-archive"
        title={t('Your group film.')}
      />
      {children}
      {downloadNotice && scenario ? <Notice>{t(downloadNotice)}</Notice> : null}
    </ScrollView>
  );

  if (scenario === 'loading' || (!scenario && state.status === 'loading')) {
    return frame(
      <Panel live="polite" testID="archive-loading" title={t('Checking the group premiere…')}>
        <Quiet>{t('Your place is kept.')}</Quiet>
      </Panel>,
    );
  }

  if (scenario === 'denied') {
    return frame(
      <Panel
        body={t('This member cannot access the group.')}
        testID="archive-denied"
        title={t('Access unavailable')}
      />,
    );
  }

  if (scenario === 'error') {
    return frame(
      <Panel
        body={t('Connection unavailable. Try again.')}
        testID="archive-error"
        title={t('Could not load the premiere')}
        tone="alert"
      >
        <ActionButton label={t('Retry')} onPress={() => debug?.set('live')} />
      </Panel>,
    );
  }

  if (scenario === 'empty') {
    return frame(
      <Panel
        body={t('A contribution is not a released film.')}
        testID="archive-empty"
        title={t('No released films yet')}
      >
        <ActionButton
          label={t('Check premiere again')}
          onPress={() => setDownloadNotice('No change. Try another debug state.')}
        />
      </Panel>,
    );
  }

  if (scenario === 'released') {
    return frame(
      <>
        <View style={styles.panel} testID="archive-premiere-ready">
          <Eyebrow>{t('RELEASED FOR THIS GROUP')}</Eyebrow>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {groupName ?? t('Your group film')}
          </Text>
          <MockMedia
            caption={t('Debug preview · no video file attached')}
            kind="clip"
            title={t('Released film placeholder')}
          />
          <ActionButton
            full
            label={t('Play film · preview')}
            onPress={() => setDownloadNotice('Playback preview only; no film attached.')}
            variant="primary"
          />
        </View>
        <Panel
          body={`${t('Group film · released sample')}\n${t('Your clip · synthetic, 2.0 seconds')}`}
          title={t('Your released media')}
        >
          <ButtonRow>
            <ActionButton
              label={t('Download film · preview')}
              onPress={() => setDownloadNotice('Download preview only.')}
            />
            <ActionButton
              label={t('Download clip · preview')}
              onPress={() => setDownloadNotice('Download preview only.')}
            />
          </ButtonRow>
        </Panel>
      </>,
    );
  }

  if (!scenario && state.status === 'unavailable') {
    return frame(
      <Panel testID="archive-unavailable" title={t('Premiere unavailable')}>
        <Text accessibilityLiveRegion="assertive" style={styles.bodyText}>
          {state.message ===
          'Server-backed archive actions are unavailable without the local runtime.'
            ? t('Connect the local runtime to check the film.')
            : t(state.message)}
        </Text>
        <ActionButton
          label={t('Retry premiere')}
          onPress={() => {
            retryCapsule();
            load();
          }}
        />
      </Panel>,
    );
  }

  const ready = state.status === 'ready' ? state : null;
  const cycles = ready?.cycles ?? [];
  const archive = ready?.archive ?? EMPTY_ARCHIVE;
  const releasedCycleIds = new Set(
    cycles.filter((entry) => entry.releaseStatus === 'published').map((entry) => entry.id),
  );
  const hasOlderReleasedMedia = archive.films.length > 0 || archive.clips.length > 0;
  const forcedPremiere =
    scenario === 'processing' || scenario === 'delayed'
      ? ({ state: scenario, cycleId: cycle?.id ?? 'debug-fixture-cycle' } as const)
      : null;
  const premierePanel = forcedPremiere ? (
    <PremiereStatus
      hasOlderReleasedMedia={hasOlderReleasedMedia}
      premiere={forcedPremiere}
      reload={() => setDownloadNotice('No change. Try another debug state.')}
    />
  ) : !ready ? null : ready.premiere.state === 'ready' ? (
    releasedCycleIds.has(ready.premiere.cycleId) ? (
      <PublishedPlayer groupName={groupName} premiere={ready.premiere} />
    ) : (
      <PremiereStatus
        premiere={{ state: 'locked', cycleId: ready.premiere.cycleId }}
        reload={load}
        hasOlderReleasedMedia={hasOlderReleasedMedia}
      />
    )
  ) : (
    <PremiereStatus
      premiere={ready.premiere}
      reload={load}
      hasOlderReleasedMedia={hasOlderReleasedMedia}
    />
  );
  // The server restricts real archive pages to published cycles. If locally
  // supplied cycle metadata is available, also hide any explicitly locked
  // entry; an older paged cycle with no metadata remains visible.
  const cycleById = new Map(cycles.map((entry) => [entry.id, entry]));
  const releasedArchive: ReleasedArchive = {
    films: archive.films.filter(
      (film) => cycleById.get(film.cycleId)?.releaseStatus !== 'unpublished',
    ),
    clips: archive.clips.filter(
      (clip) => cycleById.get(clip.cycleId)?.releaseStatus !== 'unpublished',
    ),
  };
  return frame(
    <>
      {premierePanel}
      <ArchiveEntries
        archive={releasedArchive}
        cycles={cycles}
        hasMoreCycles={
          ready
            ? ready.archivePage.hasMoreFilms ||
              ready.archivePage.hasMoreClips ||
              ready.cyclePage.hasMore
            : false
        }
        loadingMore={loadingMore}
        loadMore={() => void loadMore()}
        download={download}
        notice={scenario ? null : downloadNotice}
      />
    </>,
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
  const { t } = useI18n();
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
          {t(
            'This status is for the current cycle. Previously released media remains available below.',
          )}
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
    borderRadius: 9,
    borderWidth: 1,
    gap: 12,
    padding: 17,
  },
  sectionTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700' },
  subhead: { color: COLORS.ink, fontSize: 15, fontWeight: '700', marginTop: 4 },
  bodyText: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  player: { backgroundColor: COLORS.deep, borderRadius: 8, height: 360, width: '100%' },
  entry: { borderTopColor: COLORS.line, borderTopWidth: 1, gap: 7, paddingTop: 12 },
  entryTitle: { color: COLORS.ink, fontSize: 15, fontWeight: '700' },
  entryMeta: { color: COLORS.muted, fontSize: 13 },
  notice: { color: COLORS.muted, fontSize: 14 },
});
