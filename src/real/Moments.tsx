import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ContributionLedgerEntry, ContributionLedgerPage } from '../domain/contributions';
import { Icon } from '../ui/Icon';
import {
  Button,
  Dialog,
  ErrorText,
  Foot,
  Glass,
  Glow,
  Lead,
  ListGroup,
  ListRow,
  ScreenScroll,
  SubHeader,
  useNow,
  useToast,
} from '../ui/primitives';
import { FONT, WARM, serif } from '../ui/tokens';
import { momentDay, plural } from './home-model';
import { userMessage } from '../domain/user-message';

/** Moments that count this week: sealed, or still on their way, or failed.
 * The ledger spans the whole cycle; only the current seven-day window counts. */
export function weekMoments(
  page: ContributionLedgerPage | null,
  windowStart: number,
): ContributionLedgerEntry[] {
  return (page?.entries ?? []).filter(
    (entry) =>
      !['deleted', 'replaced'].includes(entry.state) && Date.parse(entry.createdAt) >= windowStart,
  );
}

/** M1–M4: metadata only. Delete one a week and retake it. */
export function MomentsScreen({
  page,
  error,
  resetDays,
  windowStart,
  onBack,
  onDelete,
  onRetry,
  onRetake,
  onReload,
}: {
  page: ContributionLedgerPage | null;
  error: string | null;
  resetDays: number;
  windowStart: number;
  onBack: () => void;
  onDelete: (entry: ContributionLedgerEntry) => Promise<void>;
  onRetry: (entry: ContributionLedgerEntry) => Promise<void>;
  onRetake: () => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const [pick, setPick] = useState<ContributionLedgerEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const moments = weekMoments(page, windowStart);
  const allowance = page?.allowance;
  const usedDelete = allowance ? allowance.deletionAvailability !== 'available' : true;
  const reset = plural(resetDays, 'day');
  const now = useNow();

  const run = async (entry: ContributionLedgerEntry, action: 'delete' | 'retry') => {
    setBusy(`${action}:${entry.contributionId}`);
    setFailure(null);
    try {
      if (action === 'delete') {
        await onDelete(entry);
        setPick(null);
        setDeleted(entry.state !== 'failed');
        toast('Deleted. Its seconds are back for this week.');
      } else {
        await onRetry(entry);
        toast('Uploading again. It finishes in the background.');
      }
    } catch (problem) {
      setPick(null);
      setFailure(userMessage(problem, 'That didn’t work. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.screen} testID="real-moments">
      <Glow />
      <ScreenScroll>
        <SubHeader backTestID="real-moments-back" onBack={onBack} title="Your moments" />
        <Glass style={styles.sum}>
          <Text style={styles.sumCount} testID="real-moments-count">
            {allowance ? `${allowance.countUsed} of ${allowance.maxCount}` : '…'}
          </Text>
          <Text style={styles.note}>
            {allowance
              ? `${allowance.secondsUsed} of ${allowance.maxSeconds} s · resets in ${reset}`
              : 'Loading…'}
          </Text>
        </Glass>
        <Lead>Sealed until the film. You can see when, not what.</Lead>
        {error ? (
          <>
            <ErrorText>{error}</ErrorText>
            <Button label="Try again" onPress={onReload} testID="real-moments-reload" />
          </>
        ) : null}
        {page && moments.length === 0 ? <Lead>Nothing sealed yet this week.</Lead> : null}
        {moments.length ? (
          <ListGroup testID="real-moments-list">
            {moments.map((entry, index) => {
              const kind = entry.mediaType === 'photo' ? 'Photo' : 'Video';
              const length = `${Math.round(entry.durationSeconds)} s`;
              const day = momentDay(entry.createdAt, now);
              const icon = entry.mediaType === 'photo' ? 'camera' : 'video';
              if (entry.state === 'failed')
                return (
                  <View key={entry.contributionId} testID={`real-moment-${index}`}>
                    <ListRow
                      first={index === 0}
                      icon={icon}
                      label={kind}
                      note={`${length} · ${day} · didn’t finish uploading`}
                      noteColor={WARM.dangerInk}
                    />
                    <View style={styles.fix}>
                      {entry.retryable && entry.jobId ? (
                        <Button
                          busy={busy === `retry:${entry.contributionId}`}
                          busyLabel="Retrying…"
                          height={44}
                          icon="replay"
                          label="Retry"
                          onPress={() => void run(entry, 'retry')}
                          style={styles.half}
                          testID={`real-moment-retry-${index}`}
                        />
                      ) : null}
                      <Button
                        height={44}
                        icon="trash"
                        label="Delete"
                        onPress={() => setPick(entry)}
                        style={styles.half}
                        testID={`real-moment-delete-${index}`}
                      />
                    </View>
                  </View>
                );
              const sealed = entry.state === 'sealed';
              return (
                <ListRow
                  accessibilityLabel={`${kind}, ${length}, ${day}, ${sealed ? 'sealed' : 'uploading'}${usedDelete || !sealed ? '' : '. Delete'}`}
                  disabled={usedDelete || !sealed}
                  first={index === 0}
                  icon={icon}
                  key={entry.contributionId}
                  label={kind}
                  note={`${length} · ${day} · ${sealed ? 'sealed' : 'uploading'}`}
                  onPress={() => setPick(entry)}
                  testID={`real-moment-${index}`}
                  trailing={
                    usedDelete || !sealed ? null : (
                      <Icon color={WARM.muted} name="trash" size={18} />
                    )
                  }
                />
              );
            })}
          </ListGroup>
        ) : null}
        <ErrorText testID="real-moments-error">{failure}</ErrorText>
        <Foot>
          {usedDelete
            ? `You used this week’s delete. It comes back in ${reset}.`
            : 'Once a week, you can delete one and retake it.'}
        </Foot>
        {deleted ? (
          <Button
            icon="camera"
            label="Retake now"
            onPress={onRetake}
            style={styles.retake}
            testID="real-moments-retake"
            variant="primary"
          />
        ) : null}
      </ScreenScroll>
      {pick ? (
        <Dialog
          body={
            pick.state === 'failed'
              ? `It didn’t finish, so this doesn’t use your weekly delete. Its ${Math.round(pick.durationSeconds)} s go back to your week.`
              : `It’s gone for good, and its ${Math.round(pick.durationSeconds)} s go back to your week. You can do this once a week.`
          }
          label="Delete moment confirmation"
          onDismiss={busy ? undefined : () => setPick(null)}
          testID="real-moment-dialog"
          title={`Delete this ${pick.mediaType === 'photo' ? 'photo' : 'video'}?`}
        >
          <Button disabled={Boolean(busy)} label="Keep it" onPress={() => setPick(null)} />
          <Button
            busy={busy === `delete:${pick.contributionId}`}
            busyLabel="Deleting…"
            label="Delete"
            onPress={() => void run(pick, 'delete')}
            testID="real-moment-delete-confirm"
            variant="danger"
          />
        </Dialog>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: WARM.bg, flex: 1, overflow: 'hidden' },
  sum: { alignItems: 'center', gap: 4, marginBottom: 14, paddingVertical: 20 },
  sumCount: { color: WARM.ink, ...serif(34) },
  note: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13 },
  fix: { flexDirection: 'row', gap: 10, paddingBottom: 12, paddingHorizontal: 16 },
  half: { flex: 1, width: undefined },
  retake: { marginTop: 16 },
});
