import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import type { ReleasedArchive, ReleasedArchiveMedia } from '../domain/archive';
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
  | { status: 'ready'; premiere: Premiere; archive: ReleasedArchive };

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
}: {
  archive: ReleasedArchive;
  download: (media: ReleasedArchiveMedia) => void;
  notice: string | null;
}) {
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
    </View>
  );
}

export function ArchiveScreen({ runtimeClient }: { runtimeClient: RuntimeClient | null }) {
  const { session } = useDemoSession();
  const { state: capsuleState, retry: retryCapsule } = useCapsule();
  const [state, setState] = useState<ArchiveState>({ status: 'loading' });
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
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
      runtimeClient.getReleasedArchive
        ? runtimeClient.getReleasedArchive(session.id, group.id)
        : Promise.resolve(EMPTY_ARCHIVE),
    ])
      .then(([premiere, archive]) => setState({ status: 'ready', premiere, archive }))
      .catch((error: unknown) =>
        setState({
          status: 'unavailable',
          message: error instanceof Error ? error.message : RUNTIME_OFFLINE_MESSAGE,
        }),
      );
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

  return (
    <View style={styles.archiveScreen}>
      <Text accessibilityRole="header" style={styles.title}>
        Archive
      </Text>
      {state.status === 'loading' ? (
        <View style={styles.panel} testID="archive-loading">
          <Text style={styles.label}>ARCHIVE</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Checking the group premiere…
          </Text>
        </View>
      ) : state.status === 'unavailable' ? (
        <View style={styles.panel} testID="archive-unavailable">
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
      ) : (
        <View style={styles.stack}>
          {state.premiere.state === 'ready' ? (
            <PublishedPlayer premiere={state.premiere} />
          ) : (
            <PremiereStatus premiere={state.premiere} reload={load} />
          )}
          <ArchiveEntries archive={state.archive} download={download} notice={downloadNotice} />
        </View>
      )}
    </View>
  );
}

function PremiereStatus({
  premiere,
  reload,
}: {
  premiere: Exclude<Premiere, { state: 'ready' }>;
  reload: () => void;
}) {
  const state = revealStateForPremiere(premiere);
  return (
    <RevealEducationPanel
      onAction={reload}
      state={state}
      surface="archive"
      testID={`archive-${premiere.state}`}
    />
  );
}

const styles = StyleSheet.create({
  archiveScreen: { gap: 12 },
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
