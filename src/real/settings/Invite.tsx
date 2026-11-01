import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Foot, Glass, ScreenScroll, SubHeader, TextLink } from '../../ui/primitives';
import { FONT, WARM } from '../../ui/tokens';
import type { SettingsGroup, SettingsScreenProps } from './types';

/* ---------- S4 Invite friends ---------- */

export function Invite<T extends SettingsGroup>({
  group,
  onBack,
  invite,
  members,
}: SettingsScreenProps<T> & { group: T }) {
  const requested = useRef(false);
  useEffect(() => {
    // Opening Invite makes a code straight away, as the design shows one.
    if (!invite.code && !invite.pending && !requested.current) {
      requested.current = true;
      invite.create();
    }
  }, [invite]);
  return (
    <ScreenScroll>
      <SubHeader onBack={onBack} title="Invite friends" />
      <Glass style={styles.inviteCard} testID="real-group-invitations">
        <Text style={styles.cardKey}>Invite code</Text>
        {invite.code ? (
          <Text
            accessibilityLabel={`Invite code ${invite.code.split('').join(' ')}`}
            selectable
            style={styles.code}
            testID="real-group-invite-code"
          >
            {invite.code}
          </Text>
        ) : (
          <Text style={styles.codeWaiting}>{invite.pending ? 'Making a code…' : '— — —'}</Text>
        )}
        {invite.code ? (
          <Text style={styles.note} testID="real-group-invite-expiry">
            Works once · expires in 24 hours
          </Text>
        ) : null}
      </Glass>
      {invite.code ? (
        <>
          <View style={styles.two}>
            <Button
              icon="share"
              label="Share code"
              onPress={invite.share}
              style={styles.half}
              testID="real-group-share-invite"
              variant="primary"
            />
            <Button
              icon="copy"
              label="Copy code"
              onPress={invite.copy}
              style={styles.half}
              testID="real-group-copy-invite"
            />
          </View>
          <TextLink
            label={invite.pending ? 'Revoking…' : 'Revoke this code'}
            onPress={invite.revoke}
            style={styles.revoke}
            testID="real-group-revoke-invite"
          />
        </>
      ) : (
        <Button
          busy={invite.pending}
          busyLabel="Creating invitation…"
          label="Create invitation code"
          onPress={invite.create}
          testID="real-group-create-invite"
          variant="primary"
        />
      )}
      {invite.feedback ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.feedback}
          testID="real-invite-feedback"
        >
          {invite.feedback}
        </Text>
      ) : null}
      <Foot>
        {members ? members.length : '…'} of {group.group.maxMembers} members in {group.group.name}
      </Foot>
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  inviteCard: {
    alignItems: 'center',
    gap: 6,
    marginBottom: 18,
    paddingBottom: 20,
    paddingHorizontal: 18,
    paddingTop: 22,
  },
  cardKey: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11.5,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  code: {
    color: WARM.ink,
    fontFamily: FONT.monoMedium,
    fontSize: 34,
    letterSpacing: 2.7,
    lineHeight: 38,
  },
  codeWaiting: { color: WARM.muted, fontFamily: FONT.monoMedium, fontSize: 24, lineHeight: 38 },
  note: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13 },
  two: { flexDirection: 'row', gap: 10, marginTop: 10 },
  half: { flex: 1, width: undefined },
  revoke: { marginTop: 16 },
  feedback: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 13,
    marginTop: 12,
    textAlign: 'center',
  },
});
