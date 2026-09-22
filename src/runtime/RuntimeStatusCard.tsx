import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  RUNTIME_OFFLINE_MESSAGE,
  type RuntimeClient,
  type RuntimeHealth,
} from './local-runtime-client';
import { COLORS } from '../theme';

type RuntimeStatus =
  | { kind: 'demo' }
  | { kind: 'loading' }
  | { kind: 'connected'; health: RuntimeHealth }
  | { kind: 'offline' }
  | { kind: 'disconnected'; message: string };

function readBrowserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function RuntimeStatusCard({ client }: { client: RuntimeClient | null }) {
  const [status, setStatus] = useState<RuntimeStatus>(
    client ? { kind: 'loading' } : { kind: 'demo' },
  );
  const [attempt, setAttempt] = useState(0);
  const [browserOnline, setBrowserOnline] = useState(readBrowserOnline);

  useEffect(() => {
    if (
      !client ||
      Platform.OS !== 'web' ||
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      typeof window.removeEventListener !== 'function'
    )
      return;
    const update = () => {
      const online = readBrowserOnline();
      setBrowserOnline(online);
      if (online) setAttempt((value) => value + 1);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    if (!browserOnline) return;
    let cancelled = false;
    void client.getHealth().then(
      (health) => {
        if (!cancelled) setStatus({ kind: 'connected', health });
      },
      (error: unknown) => {
        if (!cancelled) {
          setStatus({
            kind: 'disconnected',
            message:
              error instanceof Error ? error.message : 'The local runtime could not be reached.',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, browserOnline, client]);

  if (!client) {
    return (
      <View
        accessibilityLabel="Local runtime demo fixture active"
        style={styles.card}
        testID="runtime-demo"
      >
        <Text style={styles.label}>LOCAL RUNTIME</Text>
        <Text style={styles.title}>Demo fixture active</Text>
        <Text style={styles.body}>
          Set EXPO_PUBLIC_LOCAL_BASE_URL to connect this app to the SQLite service over localhost or
          a trusted LAN.
        </Text>
      </View>
    );
  }

  const displayedStatus: RuntimeStatus = !browserOnline ? { kind: 'offline' } : status;

  return (
    <View
      accessibilityLabel={`Local runtime ${displayedStatus.kind === 'connected' ? 'connected' : displayedStatus.kind}`}
      style={styles.card}
      testID="runtime-status"
    >
      <Text style={styles.label}>LOCAL RUNTIME</Text>
      {displayedStatus.kind === 'loading' && (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.title}>
            Connecting…
          </Text>
          <Text style={styles.body}>Checking the local service and SQLite readiness.</Text>
        </>
      )}
      {displayedStatus.kind === 'connected' && (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.title}>
            Connected · v{displayedStatus.health.version}
          </Text>
          <Text style={styles.body}>
            SQLite ready · FFmpeg{' '}
            {displayedStatus.health.checks.ffmpegConfigured ? 'configured' : 'missing'}
          </Text>
          <Text style={styles.endpoint}>Local service reachable</Text>
        </>
      )}
      {displayedStatus.kind === 'offline' && (
        <>
          <Text accessibilityLiveRegion="assertive" style={styles.title}>
            Server-backed actions unavailable offline
          </Text>
          <Text style={styles.body}>
            {RUNTIME_OFFLINE_MESSAGE} Capture sync is not supported offline.
          </Text>
          <Pressable
            accessibilityHint="Checks the local runtime again"
            accessibilityRole="button"
            onPress={() => {
              setStatus({ kind: 'loading' });
              setAttempt((value) => value + 1);
            }}
            style={styles.retry}
          >
            <Text style={styles.retryText}>Retry connection</Text>
          </Pressable>
        </>
      )}
      {displayedStatus.kind === 'disconnected' && (
        <>
          <Text accessibilityLiveRegion="assertive" style={styles.title}>
            Runtime unavailable
          </Text>
          <Text style={styles.body}>{displayedStatus.message}</Text>
          <Pressable
            accessibilityHint="Checks the local runtime again"
            accessibilityRole="button"
            onPress={() => {
              setStatus({ kind: 'loading' });
              setAttempt((value) => value + 1);
            }}
            style={styles.retry}
          >
            <Text style={styles.retryText}>Retry connection</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  label: { color: COLORS.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.ink, fontSize: 20, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  endpoint: { color: COLORS.accent, fontSize: 13, fontWeight: '600' },
  retry: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: COLORS.paper,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 14,
  },
  retryText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
});
