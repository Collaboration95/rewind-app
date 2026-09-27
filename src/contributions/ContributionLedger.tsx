import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ContributionLedgerEntry, ContributionLedgerPage } from '../domain/contributions';
import { useI18n } from '../i18n/LanguageProvider';
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

type Translate = ReturnType<typeof useI18n>['t'];

function seconds(value: number, t: Translate): string {
  return t('{seconds} seconds', { seconds: Number.isInteger(value) ? value : value.toFixed(1) });
}

function createdLabel(value: string, t: Translate): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : t('Time unavailable');
}

function impact(entry: ContributionLedgerEntry, t: Translate): string {
  if (entry.state === 'deleted' || entry.state === 'replaced') {
    return t('Restored 1 contribution and {seconds} of allowance.', {
      seconds: seconds(entry.restored?.seconds ?? entry.durationSeconds, t),
    });
  }
  return t('Uses 1 contribution and {seconds} of allowance.', {
    seconds: seconds(entry.durationSeconds, t),
  });
}

function failureDetail(entry: ContributionLedgerEntry, t: Translate): string | null {
  if (entry.state !== 'failed') return null;
  return entry.retryable
    ? t('Eligible for retry. Retry is not available from this list.')
    : t('This contribution cannot be retried.');
}

function allowanceText(page: ContributionLedgerPage, t: Translate): string {
  const { allowance } = page;
  if (allowance.maxCount === 0 || allowance.maxSeconds === 0) {
    return t('No current allowance is recorded.');
  }
  const correction = {
    available: 'One correction is available this week.',
    used: 'This week’s correction has been used.',
    unavailable: 'Corrections are unavailable for this cycle.',
  }[allowance.deletionAvailability];
  return t('{used} of {max} contributions and {secondsUsed} of {maxSeconds} used. {correction}', {
    correction: t(correction),
    max: allowance.maxCount,
    maxSeconds: seconds(allowance.maxSeconds, t),
    secondsUsed: seconds(allowance.secondsUsed, t),
    used: allowance.countUsed,
  });
}

function LedgerRow({ entry, position }: { entry: ContributionLedgerEntry; position: number }) {
  const { t } = useI18n();
  const title = t('Submission {number}', { number: position + 1 });
  const status = t(stateCopy[entry.state]);
  const reference = /^[A-Za-z0-9_-]{1,128}$/.test(entry.contributionId)
    ? entry.contributionId
    : t('Unavailable');
  const allowanceImpact = impact(entry, t);
  const retry = failureDetail(entry, t);
  const duration = seconds(entry.durationSeconds, t);
  return (
    <View
      accessible
      accessibilityLabel={`${title}, ${t('reference {reference}', { reference })}. ${status}. ${t('Duration {duration}', { duration })}. ${allowanceImpact}${retry ? ` ${retry}` : ''}`}
      style={styles.row}
      testID={`contribution-ledger-entry-${position}`}
    >
      <Text style={styles.rowTitle}>{title}</Text>
      <Text style={styles.reference}>{t('Reference {reference}', { reference })}</Text>
      <Text style={styles.status}>{status}</Text>
      <Text style={styles.body}>
        {t('Recorded {time}', { time: createdLabel(entry.createdAt, t) })}
      </Text>
      <Text style={styles.body}>{t('Duration {duration}', { duration })}</Text>
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
  const { t } = useI18n();
  if (view.status === 'loading') {
    return (
      <View style={styles.panel} testID="contribution-ledger-loading">
        <Text accessibilityLiveRegion="polite" style={styles.title}>
          {t('Loading contributions…')}
        </Text>
      </View>
    );
  }
  if (view.status === 'denied') {
    return (
      <View style={styles.panel} testID="contribution-ledger-denied">
        <Text accessibilityLiveRegion="assertive" style={styles.title}>
          {t('Contributions unavailable')}
        </Text>
        <Text style={styles.body}>{t('This Demo session cannot access the selected group.')}</Text>
      </View>
    );
  }
  if (view.status === 'error') {
    return (
      <View style={styles.panel} testID="contribution-ledger-error">
        <Text accessibilityLiveRegion="assertive" style={styles.title}>
          {t('Contributions could not be loaded')}
        </Text>
        <Text style={styles.body}>{t('Check the local runtime connection and try again.')}</Text>
        {onRetry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('Retry loading contributions')}
            onPress={onRetry}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{t('Retry loading contributions')}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const { page } = view;
  return (
    <View style={styles.panel} testID="contribution-ledger-ready">
      <Text style={styles.label}>{t('MY CONTRIBUTIONS')}</Text>
      <Text style={styles.title}>{t('Current cycle')}</Text>
      <Text style={styles.body}>{allowanceText(page, t)}</Text>
      {page.entries.length === 0 ? (
        <Text
          accessibilityLiveRegion="polite"
          style={styles.body}
          testID="contribution-ledger-empty"
        >
          {t('No contributions in this cycle yet.')}
        </Text>
      ) : (
        page.entries.map((entry, position) => (
          <LedgerRow entry={entry} key={entry.contributionId} position={position} />
        ))
      )}
      {view.loadMoreError ? (
        <Text accessibilityLiveRegion="assertive" style={styles.body}>
          {t('More contributions could not be loaded. Try again.')}
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
              {view.loadingMore ? t('Loading more contributions…') : t('Load more contributions')}
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.body}>{t('More contributions are available.')}</Text>
        )
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
    gap: 10,
    padding: 17,
  },
  label: { color: COLORS.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.4 },
  title: { color: COLORS.ink, fontSize: 19, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  row: {
    borderColor: COLORS.line,
    borderTopWidth: 1,
    gap: 4,
    paddingTop: 12,
  },
  rowTitle: { color: COLORS.ink, fontSize: 15, fontWeight: '700' },
  reference: { color: COLORS.edge, fontSize: 12 },
  status: { color: COLORS.accent, fontSize: 14, fontWeight: '700' },
  button: {
    alignSelf: 'flex-start',
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
});
