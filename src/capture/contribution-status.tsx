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
import { StyleSheet, Text, View } from 'react-native';

import { useI18n } from '../i18n/LanguageProvider';
import { COLORS } from '../theme';
import { ActionButton } from '../ui/kit';

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
  /** Whether the one bounded delete-and-replace action can still be shown. */
  deletionAvailability?: 'available' | 'used' | 'unavailable';
  /** A terminal failure caused by the exhausted cycle allowance. */
  reason?: 'quota_exceeded';
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
    (candidate.message === undefined || typeof candidate.message === 'string') &&
    (candidate.deletionAvailability === undefined ||
      candidate.deletionAvailability === 'available' ||
      candidate.deletionAvailability === 'used' ||
      candidate.deletionAvailability === 'unavailable') &&
    (candidate.reason === undefined || candidate.reason === 'quota_exceeded')
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

const lifecycleCopy: Record<
  Exclude<ContributionLifecycle, 'failed'>,
  { body: string; title: string }
> = {
  queued: {
    title: 'Contribution queued',
    body: 'Clip received; waiting to process.',
  },
  processing: {
    title: 'Processing contribution',
    body: 'Only status is visible.',
  },
  sealed: {
    title: 'Contribution sealed',
    body: 'Waiting for reveal; preview unavailable.',
  },
};

/** Every English title/body the panel can show; used by the copy coverage test. */
export const CONTRIBUTION_STATUS_COPY: readonly string[] = [
  ...Object.values(lifecycleCopy).flatMap((copy) => [copy.title, copy.body]),
  'Contribution limit reached',
  'No allowance remains.',
  'Contribution needs a retry',
  'Processing failed. Retry; media stays sealed.',
  'Contribution could not be prepared',
  'This contribution cannot be retried. Retake it to submit a new contribution.',
];

const failureCopy = (status: ContributionStatus): { body: string; title: string } =>
  status.reason === 'quota_exceeded'
    ? { title: 'Contribution limit reached', body: 'No allowance remains.' }
    : status.retryable
      ? {
          title: 'Contribution needs a retry',
          body: 'Processing failed. Retry; media stays sealed.',
        }
      : {
          title: 'Contribution could not be prepared',
          body: 'This contribution cannot be retried. Retake it to submit a new contribution.',
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
  const { t } = useI18n();
  if (!status) return null;
  const copy = status.state === 'failed' ? failureCopy(status) : lifecycleCopy[status.state];
  const title = t(copy.title);
  const body = t(copy.body);
  const metadata = status.durationSeconds
    ? t('{seconds} seconds · metadata only', { seconds: status.durationSeconds.toFixed(1) })
    : t('Metadata only · no media is shown');
  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${body}${status.message ? ` ${status.message}` : ''}`}
      style={[styles.panel, status.state === 'failed' && styles.failedPanel]}
      testID={`${testID}-${status.state}`}
    >
      <Text style={styles.label}>{t('CONTRIBUTION STATUS')}</Text>
      <View style={styles.titleRow}>
        <View
          accessible={false}
          style={[styles.marker, status.state === 'sealed' && styles.markerSealed]}
        />
        <Text
          accessibilityLiveRegion={status.state === 'failed' ? 'assertive' : 'polite'}
          style={styles.title}
        >
          {title}
        </Text>
      </View>
      <Text style={styles.body}>{body}</Text>
      <Text style={styles.metadata}>{metadata}</Text>
      {status.deletionAvailability === 'used' ? (
        <Text style={styles.availability} testID={`${testID}-delete-used`}>
          {t('Delete and replace is unavailable because this cycle allowance is already used.')}
        </Text>
      ) : null}
      {status.deletionAvailability === 'unavailable' ? (
        <Text style={styles.availability} testID={`${testID}-delete-unavailable`}>
          {t('Delete and replace is no longer available for this contribution.')}
        </Text>
      ) : null}
      {status.state === 'failed' && status.retryable && onRetry ? (
        <ActionButton label={t(retryLabel)} onPress={onRetry} variant="primary" />
      ) : null}
      {onDelete &&
      status.deletionAvailability !== 'used' &&
      status.deletionAvailability !== 'unavailable' ? (
        <ActionButton label={t(deleteLabel)} onPress={onDelete} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 9,
    borderWidth: 1,
    gap: 8,
    padding: 17,
  },
  failedPanel: { borderColor: COLORS.accent, borderLeftWidth: 3 },
  label: { color: COLORS.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.4 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  marker: {
    borderColor: COLORS.ink,
    borderRadius: 4,
    borderStyle: 'dashed',
    borderWidth: 1,
    height: 8,
    width: 8,
  },
  markerSealed: { borderStyle: 'solid', backgroundColor: COLORS.ink },
  title: { color: COLORS.ink, flexShrink: 1, fontSize: 18, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  metadata: { color: COLORS.edge, fontSize: 13, fontWeight: '600' },
  availability: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
});
