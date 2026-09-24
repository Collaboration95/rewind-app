import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ContributionLedgerEntry, ContributionLedgerPage } from '../domain/contributions';
import { COLORS } from '../theme';

export type ContributionLedgerView =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'error' }
  | {
      status: 'ready';
      page: ContributionLedgerPage;
      loadingMore?: boolean;
      loadMoreError?: boolean;
    };

const stateCopy: Record<ContributionLedgerEntry['state'], string> = {
  queued: 'Queued',
  processing: 'Processing',
  sealed: 'Sealed for reveal',
  failed: 'Processing failed',
  deleted: 'Deleted',
  replaced: 'Replaced',
};

function seconds(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} seconds`;
}

function createdLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Time unavailable';
}

function impact(entry: ContributionLedgerEntry): string {
  if (entry.state === 'deleted' || entry.state === 'replaced') {
    return `Restored 1 contribution and ${seconds(entry.restored?.seconds ?? entry.durationSeconds)} of allowance.`;
  }
  return `Uses 1 contribution and ${seconds(entry.durationSeconds)} of allowance.`;
}

function failureDetail(entry: ContributionLedgerEntry): string | null {
  if (entry.state !== 'failed') return null;
  return entry.retryable
    ? 'Eligible for retry. Retry is not available from this list.'
    : 'This contribution cannot be retried.';
}

function allowanceText(page: ContributionLedgerPage): string {
  const { allowance } = page;
  if (allowance.maxCount === 0 || allowance.maxSeconds === 0) {
    return 'No current allowance is recorded.';
  }
  const correction = {
    available: 'One correction is available this week.',
    used: 'This week’s correction has been used.',
    unavailable: 'Corrections are unavailable for this cycle.',
  }[allowance.deletionAvailability];
  return `${allowance.countUsed} of ${allowance.maxCount} contributions and ${seconds(allowance.secondsUsed)} of ${seconds(allowance.maxSeconds)} used. ${correction}`;
}

function LedgerRow({ entry, position }: { entry: ContributionLedgerEntry; position: number }) {
  const title = `Submission ${position + 1}`;
  const status = stateCopy[entry.state];
  const reference = /^[A-Za-z0-9_-]{1,128}$/.test(entry.contributionId)
    ? entry.contributionId
    : 'Unavailable';
  const allowanceImpact = impact(entry);
  const retry = failureDetail(entry);
  return (
    <View
      accessible
      accessibilityLabel={`${title}, reference ${reference}. ${status}. Duration ${seconds(entry.durationSeconds)}. ${allowanceImpact}${retry ? ` ${retry}` : ''}`}
      style={styles.row}
      testID={`contribution-ledger-entry-${position}`}
    >
      <Text style={styles.rowTitle}>{title}</Text>
      <Text style={styles.reference}>Reference {reference}</Text>
      <Text style={styles.status}>{status}</Text>
      <Text style={styles.body}>Recorded {createdLabel(entry.createdAt)}</Text>
      <Text style={styles.body}>Duration {seconds(entry.durationSeconds)}</Text>
      <Text style={styles.body}>{allowanceImpact}</Text>
      {retry ? <Text style={styles.body}>{retry}</Text> : null}
    </View>
  );
}

/** Presentational only. The parent will supply authenticated ledger pages
 * after the GET /contributions route exists. No capture or media action is
 * initiated here. */
export function ContributionLedger({
  view,
  onRetry,
  onLoadMore,
}: {
  view: ContributionLedgerView;
  onRetry?: () => void;
  onLoadMore?: () => void;
}) {
  if (view.status === 'loading') {
    return (
      <View style={styles.panel} testID="contribution-ledger-loading">
        <Text accessibilityLiveRegion="polite" style={styles.title}>
          Loading contributions…
        </Text>
      </View>
    );
  }
  if (view.status === 'denied') {
    return (
      <View style={styles.panel} testID="contribution-ledger-denied">
        <Text accessibilityLiveRegion="assertive" style={styles.title}>
          Contributions unavailable
        </Text>
        <Text style={styles.body}>This Demo session cannot access the selected group.</Text>
      </View>
    );
  }
  if (view.status === 'error') {
    return (
      <View style={styles.panel} testID="contribution-ledger-error">
        <Text accessibilityLiveRegion="assertive" style={styles.title}>
          Contributions could not be loaded
        </Text>
        <Text style={styles.body}>Check the local runtime connection and try again.</Text>
        {onRetry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading contributions"
            onPress={onRetry}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Retry loading contributions</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const { page } = view;
  return (
    <View style={styles.panel} testID="contribution-ledger-ready">
      <Text style={styles.label}>MY CONTRIBUTIONS</Text>
      <Text style={styles.title}>Current cycle</Text>
      <Text style={styles.body}>{allowanceText(page)}</Text>
      {page.entries.length === 0 ? (
        <Text
          accessibilityLiveRegion="polite"
          style={styles.body}
          testID="contribution-ledger-empty"
        >
          No contributions in this cycle yet.
        </Text>
      ) : (
        page.entries.map((entry, position) => (
          <LedgerRow entry={entry} key={entry.contributionId} position={position} />
        ))
      )}
      {view.loadMoreError ? (
        <Text accessibilityLiveRegion="assertive" style={styles.body}>
          More contributions could not be loaded. Try again.
        </Text>
      ) : null}
      {page.pagination.hasMore ? (
        onLoadMore ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: Boolean(view.loadingMore) }}
            disabled={Boolean(view.loadingMore)}
            onPress={onLoadMore}
            style={styles.button}
          >
            <Text style={styles.buttonText}>
              {view.loadingMore ? 'Loading more contributions…' : 'Load more contributions'}
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.body}>More contributions are available.</Text>
        )
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
    gap: 10,
    padding: 16,
  },
  label: { color: COLORS.edge, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.ink, fontSize: 20, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  row: {
    borderColor: COLORS.line,
    borderTopWidth: 1,
    gap: 4,
    paddingTop: 12,
  },
  rowTitle: { color: COLORS.ink, fontSize: 16, fontWeight: '700' },
  reference: { color: COLORS.edge, fontSize: 12 },
  status: { color: COLORS.accent, fontSize: 14, fontWeight: '700' },
  button: {
    alignSelf: 'flex-start',
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
});
