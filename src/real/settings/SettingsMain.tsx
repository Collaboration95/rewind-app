import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DISPLAY_CURRENT_VERSION, CURRENT_VERSION } from '../../runtime/version';
import {
  Avatar,
  Button,
  Dialog,
  Foot,
  Glass,
  ListGroup,
  ListHint,
  ListRow,
  ScreenScroll,
  SectionLabel,
  SubHeader,
} from '../../ui/primitives';
import { FONT, WARM, memberColor, serif } from '../../ui/tokens';
import { plural } from '../home-model';
import { openLegalPage } from '../safety';
import { ReminderBlock } from './ReminderBlock';
import type { SettingsGroup, SettingsScreenProps } from './types';

export function SettingsMain<T extends SettingsGroup>({
  onBack,
  onNavigate,
  account,
  group,
  groups,
  members,
  invite: _invite,
  onJoin,
  onCreate,
  signOut,
  notice,
  authenticatedRequest,
  reminderClient,
}: SettingsScreenProps<T>) {
  const [signOutOpen, setSignOutOpen] = useState(false);
  const owner = group?.group.role === 'owner';
  const count = members?.length ?? null;
  const limit = group?.group.maxMembers ?? 10;
  const full = count !== null && count >= limit;
  const zone = group?.group.timeZone ?? 'UTC';
  return (
    <>
      <ScreenScroll>
        <SubHeader
          backLabel="Back"
          backTestID="real-settings-back"
          onBack={onBack}
          title="Settings"
        />
        {notice ? (
          <Text
            accessibilityRole="alert"
            style={styles.notice}
            testID="settings-logout-unconfirmed"
          >
            {notice}
          </Text>
        ) : null}
        <Glass style={styles.me}>
          <Avatar color={memberColor(account.id)} name={account.displayName} size={56} />
          <View style={styles.meText}>
            <Text style={styles.meName}>{account.displayName}</Text>
            <Text style={styles.meHandle}>{account.username}</Text>
          </View>
        </Glass>
        {group ? (
          <>
            <SectionLabel>Group</SectionLabel>
            <ListGroup>
              <View style={styles.groupRow}>
                <View style={styles.groupText}>
                  <Text style={styles.groupName}>{group.group.name}</Text>
                  <Text style={styles.groupNote} testID="real-settings-group-summary">
                    {owner ? 'Owner' : 'Member'} · {count === null ? '…' : count} of {limit} members
                  </Text>
                </View>
                <View accessibilityElementsHidden style={styles.stack}>
                  {(members ?? []).slice(0, 6).map((member, index) => (
                    <Avatar
                      color={memberColor(member.memberId)}
                      key={member.memberId}
                      name={member.displayName}
                      size={26}
                      style={[styles.stackAvatar, index === 0 && { marginLeft: 0 }]}
                    />
                  ))}
                </View>
              </View>
              {owner ? (
                <>
                  <ListRow
                    chevron
                    icon="quote"
                    label="Prompt"
                    note={group.cycle.prompt}
                    onPress={() => onNavigate('prompt')}
                    testID="real-settings-prompt"
                  />
                  <ListRow
                    chevron
                    icon="clock"
                    label="Time zone"
                    note={zone}
                    onPress={() => onNavigate('tz')}
                    testID="real-settings-tz"
                  />
                  {full ? (
                    <ListRow
                      icon="users"
                      label="Invite friends"
                      note={`The group is full · ${count} of ${limit}`}
                      off
                      testID="real-settings-invite"
                    />
                  ) : (
                    <ListRow
                      chevron
                      icon="users"
                      label="Invite friends"
                      onPress={() => onNavigate('invite')}
                      testID="real-settings-invite"
                    />
                  )}
                </>
              ) : (
                <>
                  <ListRow icon="quote" label="Prompt" note={group.cycle.prompt} off />
                  <ListRow icon="clock" label="Time zone" note={zone} off />
                  <ListHint>
                    Only the owner can change the prompt, the time zone or invite friends.
                  </ListHint>
                </>
              )}
            </ListGroup>
            <ListGroup style={styles.more}>
              <ListRow
                chevron
                first
                icon="users"
                label="Members"
                note={count === null ? null : `${count} of ${limit}`}
                onPress={() => onNavigate('members')}
                testID="real-settings-members"
              />
              <ListRow
                chevron
                icon="users"
                label="Switch group"
                note={plural(groups.length, 'group')}
                onPress={() => onNavigate('groups')}
                testID="real-settings-groups"
              />
              <ListRow
                chevron
                icon="key"
                label="Have an invite?"
                onPress={onJoin}
                testID="real-settings-join"
              />
              <ListRow
                chevron
                icon="plus"
                label="Create a group"
                onPress={onCreate}
                testID="real-settings-create"
              />
            </ListGroup>
            <SectionLabel>Reminder</SectionLabel>
            <ReminderBlock
              group={group}
              key={group.group.id}
              reminderClient={reminderClient}
              request={authenticatedRequest}
            />
          </>
        ) : (
          <>
            <SectionLabel>Group</SectionLabel>
            <ListGroup>
              <ListHint first>You’re not in a group yet.</ListHint>
              <ListRow
                chevron
                icon="key"
                label="Have an invite?"
                onPress={onJoin}
                testID="real-settings-join"
              />
              <ListRow
                chevron
                icon="plus"
                label="Create a group"
                onPress={onCreate}
                testID="real-settings-create"
              />
            </ListGroup>
          </>
        )}
        <SectionLabel>Help and privacy</SectionLabel>
        <ListGroup>
          <ListRow
            first
            icon="chat"
            label="Help and support"
            onPress={() => openLegalPage('/support')}
            testID="real-settings-help"
          />
          <ListRow
            icon="lock"
            label="Privacy Policy"
            onPress={() => openLegalPage('/privacy')}
            testID="real-settings-privacy"
          />
          <ListRow
            icon="quote"
            label="Terms of use"
            onPress={() => openLegalPage('/terms')}
            testID="real-settings-terms"
          />
        </ListGroup>
        <SectionLabel>Account</SectionLabel>
        <ListGroup>
          <ListRow
            danger
            disabled={signOut.pending}
            first
            icon="out"
            label={signOut.label}
            onPress={() => setSignOutOpen(true)}
            testID="real-group-sign-out"
          />
          <ListRow
            danger
            icon="trash"
            label="Delete account"
            onPress={() => onNavigate('delete')}
            testID="real-settings-delete"
          />
        </ListGroup>
        <Foot>
          Rewind · signed in as {account.username}
          {DISPLAY_CURRENT_VERSION ? ` · ${CURRENT_VERSION}` : ''}
        </Foot>
      </ScreenScroll>
      {signOutOpen ? (
        <Dialog
          body="Your sealed moments stay with the group. A moment still uploading on this phone stops until you sign in again."
          label="Sign out confirmation"
          onDismiss={() => setSignOutOpen(false)}
          testID="real-sign-out-dialog"
          title="Sign out?"
        >
          <Button label="Stay signed in" onPress={() => setSignOutOpen(false)} />
          <Button
            busy={signOut.pending}
            busyLabel="Signing out…"
            label="Sign out"
            onPress={() => {
              setSignOutOpen(false);
              signOut.onSignOut();
            }}
            testID="real-group-sign-out-confirm"
            variant="danger"
          />
        </Dialog>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  notice: {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderColor: 'rgba(194, 69, 47, 0.35)',
    borderRadius: 14,
    borderWidth: 1,
    color: '#6b2a1a',
    fontFamily: FONT.body,
    fontSize: 13,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  me: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  meText: { flex: 1 },
  meName: { color: WARM.ink, lineHeight: 25, ...serif(22) },
  meHandle: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13 },
  groupRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  groupText: { flex: 1 },
  groupName: { color: WARM.ink, lineHeight: 22, ...serif(19) },
  groupNote: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13, marginTop: 3 },
  stack: { flexDirection: 'row' },
  stackAvatar: { borderColor: '#fbf5ee', marginLeft: -7 },
  more: { marginTop: 10 },
});
