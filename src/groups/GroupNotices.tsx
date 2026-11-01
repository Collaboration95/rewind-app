import { Platform, StyleSheet, Text } from 'react-native';

import type { InviteLinkPayload } from '../invites/deep-links';
import { Button, Glass } from '../ui/primitives';
import { FONT, WARM } from '../ui/tokens';

export function signOutNoticeFor(notice: string | null | undefined): string | null {
  return notice === 'sign-out-marker-unavailable'
    ? 'Sign-out did not start because this device could not save its recovery state. You are still signed in. Retry sign out.'
    : notice === 'revocation-unconfirmed'
      ? Platform.OS === 'web'
        ? 'We could not confirm sign-out. You are still signed in on this browser; retry when the service is reachable.'
        : 'This device signed out, but server revocation was not confirmed. Another device may remain signed in until expiry or account reset.'
      : null;
}

/** The invitation, sign-out, error and refresh notices shown above the group's home. */
export function GroupNotices({
  inviteIntent,
  acceptPending,
  joinFeedback,
  onAcceptInvite,
  signOutNotice,
  message,
  refreshFailed,
  onRetryRefresh,
}: {
  inviteIntent?: (InviteLinkPayload & { groupId: string }) | null;
  acceptPending: boolean;
  joinFeedback: string | null;
  onAcceptInvite: (code: string, groupId: string) => void;
  signOutNotice: string | null;
  message: string | null;
  refreshFailed: boolean;
  onRetryRefresh: () => void;
}) {
  const inviteIntentCard = inviteIntent ? (
    <Glass style={styles.notice} testID="real-invite-intent">
      <Text style={styles.noticeTitle}>You have an invitation</Text>
      <Text style={styles.noticeBody}>
        Expires {new Date(inviteIntent.expiresAt).toLocaleString()}. Accept it to join this private
        group.
      </Text>
      <Button
        busy={acceptPending}
        busyLabel="Joining…"
        label="Accept invitation"
        onPress={() => onAcceptInvite(inviteIntent.code, inviteIntent.groupId)}
        testID="real-invite-accept"
        variant="primary"
      />
      {joinFeedback ? (
        <Text accessibilityRole="alert" style={styles.noticeBody} testID="real-invite-feedback">
          {joinFeedback}
        </Text>
      ) : null}
    </Glass>
  ) : null;
  return (
    <>
      {inviteIntentCard}
      {signOutNotice ? (
        <Text accessibilityRole="alert" style={styles.alert} testID="logout-unconfirmed">
          {signOutNotice}
        </Text>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" style={styles.alert} testID="real-group-switch-error">
          {message}
        </Text>
      ) : null}
      {refreshFailed ? (
        <Glass style={styles.notice} testID="real-group-refresh-error">
          <Text accessibilityRole="alert" style={styles.noticeBody}>
            Couldn’t refresh your group. Showing your last update.
          </Text>
          <Button label="Try again" onPress={onRetryRefresh} testID="real-group-refresh-retry" />
        </Glass>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  notice: { gap: 8, marginBottom: 14, padding: 18 },
  noticeTitle: { color: WARM.ink, fontFamily: FONT.body, fontSize: 16, fontWeight: '600' },
  noticeBody: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13.5, lineHeight: 19 },
  alert: {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderColor: 'rgba(194, 69, 47, 0.35)',
    borderRadius: 14,
    borderWidth: 1,
    color: '#6b2a1a',
    fontFamily: FONT.body,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
});
