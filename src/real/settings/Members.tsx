import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { userMessage } from '../../domain/user-message';
import {
  Avatar,
  Button,
  Dialog,
  Foot,
  Lead,
  ListGroup,
  ListRow,
  ScreenScroll,
  SubHeader,
  useToast,
} from '../../ui/primitives';
import { FONT, WARM, memberColor, serif } from '../../ui/tokens';
import { ReportSheet } from '../ReportSheet';
import { blockMember, reportContent, unblockMember } from '../safety';
import type { SettingsGroup, SettingsMember, SettingsScreenProps } from './types';

/* ---------- S15–S17 Members, a member, report ---------- */

export function Members<T extends SettingsGroup>({
  group,
  onBack,
  members,
  membersError,
  pendingInvites,
  blocked,
  onBlockedChange,
  authenticatedRequest,
}: SettingsScreenProps<T> & { group: T }) {
  const toast = useToast();
  const [person, setPerson] = useState<SettingsMember | null>(null);
  const [reporting, setReporting] = useState<SettingsMember | null>(null);
  const [pending, setPending] = useState(false);
  const toggleBlock = async (member: SettingsMember) => {
    const isBlocked = blocked.has(member.memberId);
    setPending(true);
    try {
      if (isBlocked) await unblockMember(authenticatedRequest, member.memberId);
      else await blockMember(authenticatedRequest, member.memberId);
      onBlockedChange(member.memberId, !isBlocked);
      setPerson(null);
      toast(
        isBlocked
          ? 'Unblocked.'
          : `${member.displayName} is blocked. You won’t see their messages or moments.`,
      );
    } catch (error) {
      toast(userMessage(error, 'Try again.'));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <ScreenScroll>
        <SubHeader onBack={onBack} title="Members" />
        {members === null ? (
          <Lead testID="real-group-members-empty">{membersError ?? 'Loading group members…'}</Lead>
        ) : (
          <ListGroup testID="real-group-members">
            {members.map((member, index) => {
              const you = Boolean(group.memberId) && member.memberId === group.memberId;
              const role = member.role === 'owner' ? 'Owner' : 'Member';
              return (
                <ListRow
                  accessibilityLabel={`${member.displayName}, ${member.role}`}
                  chevron={!you}
                  first={index === 0}
                  key={member.memberId}
                  label={you ? `${member.displayName} (you)` : member.displayName}
                  leading={
                    <Avatar
                      color={memberColor(member.memberId)}
                      name={member.displayName}
                      size={32}
                    />
                  }
                  note={`${role}${blocked.has(member.memberId) ? ' · blocked' : ''}`}
                  onPress={you ? undefined : () => setPerson(member)}
                  testID={`real-group-member-${index}`}
                />
              );
            })}
          </ListGroup>
        )}
        <Text style={styles.pending} testID="real-group-pending-invites">
          {pendingInvites
            ? `${pendingInvites} pending ${pendingInvites === 1 ? 'invitation' : 'invitations'}`
            : members
              ? 'No pending invitations'
              : membersError
                ? 'Invitation status unavailable.'
                : 'Loading invitation status…'}
        </Text>
        <Foot>Blocking hides someone’s messages and moments from you. They aren’t told.</Foot>
      </ScreenScroll>
      {person ? (
        <Dialog
          label={person.displayName}
          onDismiss={() => setPerson(null)}
          testID="real-person-dialog"
        >
          <View style={[styles.personIcon, { backgroundColor: memberColor(person.memberId) }]}>
            <Text style={styles.personInitial}>{person.displayName[0]?.toUpperCase()}</Text>
          </View>
          <Text accessibilityRole="header" style={styles.personName}>
            {person.displayName}
          </Text>
          <Button
            label="Report"
            onPress={() => {
              setReporting(person);
              setPerson(null);
            }}
            testID="real-person-report"
          />
          <Button
            busy={pending}
            busyLabel={blocked.has(person.memberId) ? 'Unblocking…' : 'Blocking…'}
            label={blocked.has(person.memberId) ? 'Unblock' : 'Block'}
            onPress={() => void toggleBlock(person)}
            testID="real-person-block"
          />
          <Button label="Cancel" onPress={() => setPerson(null)} />
        </Dialog>
      ) : null}
      {reporting ? (
        <ReportSheet
          name={reporting.displayName}
          onCancel={() => setReporting(null)}
          onSend={async (reason, alsoBlock) => {
            try {
              await reportContent(
                authenticatedRequest,
                group.group.id,
                { memberId: reporting.memberId },
                reason,
              );
              if (alsoBlock && !blocked.has(reporting.memberId)) {
                await blockMember(authenticatedRequest, reporting.memberId);
                onBlockedChange(reporting.memberId, true);
              }
              setReporting(null);
              toast(
                alsoBlock
                  ? 'Reported and blocked. You won’t see their messages or moments.'
                  : 'Thanks. The Rewind team reviews reports within 24 hours.',
              );
              return null;
            } catch (error) {
              return userMessage(error, 'The report could not be sent. Try again.');
            }
          }}
          what="person"
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  personIcon: {
    alignItems: 'center',
    alignSelf: 'center',
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    marginBottom: 4,
    width: 56,
  },
  personInitial: { color: '#2a1a10', fontFamily: FONT.body, fontSize: 22, fontWeight: '600' },
  personName: { color: WARM.ink, textAlign: 'center', ...serif(22) },
  pending: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 13,
    marginTop: 10,
    textAlign: 'center',
  },
});
