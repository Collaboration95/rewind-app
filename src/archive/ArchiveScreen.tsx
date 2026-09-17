import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import type { Premiere } from '../domain/premiere';
import { useCapsule } from '../capsule/CapsuleProvider';
import { useDemoSession } from '../session/DemoSessionProvider';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { COLORS } from '../theme';

type ArchiveState =
  | { status: 'loading' }
  | { status: 'unavailable'; message: string }
  | { status: 'premiere'; premiere: Premiere };

function readyCopy(state: Exclude<Premiere['state'], 'ready'>): { title: string; body: string } {
  if (state === 'delayed') {
    return {
      title: 'Film delayed',
      body: 'The group film needs attention before it can be released. No playback is available yet.',
    };
  }
  if (state === 'processing') {
    return {
      title: 'Preparing your group film',
      body: 'Your accepted moments are compiling. Playback will appear here only after the release is published.',
    };
  }
  return {
    title: 'Sealed until reveal',
    body: 'This group film has not been released. Playback and media links remain unavailable.',
  };
}

function PublishedPlayer({ premiere }: { premiere: Extract<Premiere, { state: 'ready' }> }) {
  const player = useVideoPlayer(premiere.playbackUrl, (instance) => {
    instance.loop = false;
  });
  return (
    <View style={styles.panel} testID="archive-premiere-ready">
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

export function ArchiveScreen({ runtimeClient }: { runtimeClient: RuntimeClient | null }) {
  const { session } = useDemoSession();
  const { state: capsuleState, retry: retryCapsule } = useCapsule();
  const [state, setState] = useState<ArchiveState>({ status: 'loading' });
  const cycle = capsuleState.status === 'ready' ? capsuleState.cycle : null;
  const group = capsuleState.status === 'ready' ? capsuleState.group : null;

  const load = () => {
    if (!session || !cycle || !group || !runtimeClient?.getPremiere) {
      setState({
        status: 'unavailable',
        message: 'Connect the local runtime to check this group premiere.',
      });
      return;
    }
    setState({ status: 'loading' });
    void runtimeClient
      .getPremiere(session.id, group.id, cycle.id)
      .then((premiere) => setState({ status: 'premiere', premiere }))
      .catch(() =>
        setState({
          status: 'unavailable',
          message:
            'The group premiere could not be checked. Retry when the local runtime is ready.',
        }),
      );
  };

  useEffect(() => {
    void Promise.resolve().then(load);
    // `load` is intentionally recreated from the current session/cycle state;
    // it must refresh when a reveal or selected Demo member changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, cycle?.id, group?.id, runtimeClient]);

  if (state.status === 'loading') {
    return (
      <View style={styles.panel} testID="archive-loading">
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

  if (state.premiere.state === 'ready') return <PublishedPlayer premiere={state.premiere} />;
  const copy = readyCopy(state.premiere.state);
  return (
    <View style={styles.panel} testID={`archive-${state.premiere.state}`}>
      <Text style={styles.label}>ARCHIVE</Text>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.title}
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.bodyText}>
        {copy.body}
      </Text>
      <Pressable accessibilityRole="button" onPress={load} style={styles.retryButton}>
        <Text style={styles.retryText}>Check premiere again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
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
});
