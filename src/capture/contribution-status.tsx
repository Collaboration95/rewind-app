import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { COLORS } from '../theme';

/**
 * The client deliberately exposes only lifecycle metadata for a contribution.
 * In particular, this record must never contain a local file URI or a server
 * media path: before reveal, the capsule can describe a contribution without
 * making its bytes addressable.
 */
export type ContributionLifecycle = 'queued' | 'processing' | 'sealed' | 'failed';

export interface ContributionStatus {
  state: ContributionLifecycle;
  contributionId?: string;
  jobId?: string;
  durationSeconds?: number;
  createdAt: string;
  message?: string;
  retryable: boolean;
}

export interface ContributionStatusScope {
  sessionId: string;
  groupId: string;
  memberId: string;
}

export const CONTRIBUTION_STATUS_STORAGE_KEY = '@rewind/contribution-status-v1';

export interface ContributionStatusStore {
  load(scope: ContributionStatusScope): Promise<ContributionStatus | null>;
  save(scope: ContributionStatusScope, value: ContributionStatus): Promise<void>;
  clear(scope: ContributionStatusScope): Promise<void>;
}

class AsyncStorageStatusStore implements ContributionStatusStore {
  async load(scope: ContributionStatusScope): Promise<ContributionStatus | null> {
    const all = await this.read();
    const value = all[scopeKey(scope)];
    return isContributionStatus(value) ? { ...value } : null;
  }

  async save(scope: ContributionStatusScope, value: ContributionStatus): Promise<void> {
    const all = await this.read();
    all[scopeKey(scope)] = { ...value };
    await AsyncStorage.setItem(CONTRIBUTION_STATUS_STORAGE_KEY, JSON.stringify(all));
  }

  async clear(scope: ContributionStatusScope): Promise<void> {
    const all = await this.read();
    delete all[scopeKey(scope)];
    if (Object.keys(all).length === 0)
      await AsyncStorage.removeItem(CONTRIBUTION_STATUS_STORAGE_KEY);
    else await AsyncStorage.setItem(CONTRIBUTION_STATUS_STORAGE_KEY, JSON.stringify(all));
  }

  private async read(): Promise<Record<string, unknown>> {
    const raw = await AsyncStorage.getItem(CONTRIBUTION_STATUS_STORAGE_KEY);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
}

const defaultStatusStore = new AsyncStorageStatusStore();

function scopeKey(scope: ContributionStatusScope): string {
  return `${scope.sessionId}:${scope.groupId}:${scope.memberId}`;
}

function isContributionStatus(value: unknown): value is ContributionStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ContributionStatus>;
  return (
    (candidate.state === 'queued' ||
      candidate.state === 'processing' ||
      candidate.state === 'sealed' ||
      candidate.state === 'failed') &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.retryable === 'boolean' &&
    (candidate.contributionId === undefined || typeof candidate.contributionId === 'string') &&
    (candidate.jobId === undefined || typeof candidate.jobId === 'string') &&
    (candidate.durationSeconds === undefined ||
      (typeof candidate.durationSeconds === 'number' && candidate.durationSeconds > 0)) &&
    (candidate.message === undefined || typeof candidate.message === 'string')
  );
}

interface ContributionStatusContextValue {
  status: ContributionStatus | null;
  setStatus: (status: ContributionStatus) => void;
  clearStatus: () => void;
}

const ContributionStatusContext = createContext<ContributionStatusContextValue | null>(null);

export function ContributionStatusProvider({
  children,
  scope: { groupId, memberId, sessionId },
  store = defaultStatusStore,
}: {
  children: ReactNode;
  scope: ContributionStatusScope;
  store?: ContributionStatusStore;
}) {
  const [status, setStatusState] = useState<ContributionStatus | null>(null);
  const generation = useRef(0);
  const writeChain = useRef(Promise.resolve());
  const stableScope = useMemo(
    () => ({ groupId, memberId, sessionId }),
    [groupId, memberId, sessionId],
  );
  const scopeIdentity = scopeKey(stableScope);

  useEffect(() => {
    const request = ++generation.current;
    void Promise.resolve().then(async () => {
      if (request !== generation.current) return;
      setStatusState(null);
      const loaded = await store.load(stableScope);
      if (request === generation.current) setStatusState(loaded);
    });
    return () => {
      generation.current += 1;
    };
  }, [scopeIdentity, stableScope, store]);

  const setStatus = useCallback(
    (next: ContributionStatus) => {
      const request = generation.current;
      setStatusState(next);
      writeChain.current = writeChain.current
        .catch(() => undefined)
        .then(() => store.save(stableScope, next))
        .catch(() => {
          // A status write is recovery metadata. The visible state remains
          // useful for this session even when local storage is unavailable.
          if (request !== generation.current) return;
        });
    },
    [stableScope, store],
  );

  const clearStatus = useCallback(() => {
    setStatusState(null);
    writeChain.current = writeChain.current
      .catch(() => undefined)
      .then(() => store.clear(stableScope))
      .catch(() => undefined);
  }, [stableScope, store]);

  const value = useMemo(
    () => ({ status, setStatus, clearStatus }),
    [clearStatus, setStatus, status],
  );
  return (
    <ContributionStatusContext.Provider value={value}>
      {children}
    </ContributionStatusContext.Provider>
  );
}

/** The capture route also works in isolation in native previews and tests. */
export function useOptionalContributionStatus(): ContributionStatusContextValue | null {
  return useContext(ContributionStatusContext);
}

const lifecycleCopy: Record<ContributionLifecycle, { body: string; title: string }> = {
  queued: {
    title: 'Contribution queued',
    body: 'Your contribution is safely queued. It stays sealed while processing begins.',
  },
  processing: {
    title: 'Processing contribution',
    body: 'The local runtime is preparing your contribution. Media remains sealed.',
  },
  sealed: {
    title: 'Contribution sealed',
    body: 'The contribution is ready for the group reveal. Its media stays unavailable until then.',
  },
  failed: {
    title: 'Contribution needs a retry',
    body: 'The contribution could not be prepared. Retry is available without exposing its file.',
  },
};

export function ContributionStatusPanel({
  onDelete,
  deleteLabel = 'Delete and replace',
  onRetry,
  retryLabel = 'Retry contribution',
  status,
  testID = 'contribution-status',
}: {
  status: ContributionStatus | null;
  onDelete?: () => void | Promise<void>;
  deleteLabel?: string;
  onRetry?: () => void | Promise<void>;
  retryLabel?: string;
  testID?: string;
}) {
  if (!status) return null;
  const copy = lifecycleCopy[status.state];
  const metadata = status.durationSeconds
    ? `${status.durationSeconds.toFixed(1)} seconds · metadata only`
    : 'Metadata only · no media is shown';
  return (
    <View
      accessible
      accessibilityLabel={`${copy.title}. ${copy.body}${status.message ? ` ${status.message}` : ''}`}
      style={[styles.panel, status.state === 'failed' && styles.failedPanel]}
      testID={`${testID}-${status.state}`}
    >
      <Text style={styles.label}>CONTRIBUTION STATUS</Text>
      <Text
        accessibilityLiveRegion={status.state === 'failed' ? 'assertive' : 'polite'}
        style={styles.title}
      >
        {copy.title}
      </Text>
      <Text style={styles.body}>{copy.body}</Text>
      <Text style={styles.metadata}>{metadata}</Text>
      {status.state === 'failed' && status.retryable && onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retryButton}>
          <Text style={styles.retryText}>{retryLabel}</Text>
        </Pressable>
      ) : null}
      {onDelete ? (
        <Pressable accessibilityRole="button" onPress={onDelete} style={styles.deleteButton}>
          <Text style={styles.deleteText}>{deleteLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  failedPanel: { borderColor: COLORS.accent },
  label: { color: COLORS.edge, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.ink, fontSize: 20, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  metadata: { color: COLORS.edge, fontSize: 13, fontWeight: '600' },
  error: { color: COLORS.accent, fontSize: 14, lineHeight: 20 },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 14,
  },
  retryText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  deleteButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: 'center',
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  deleteText: { color: COLORS.muted, fontSize: 14, fontWeight: '700' },
});
