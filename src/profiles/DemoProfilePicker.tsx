import { Pressable, StyleSheet, Text } from 'react-native';

import { useOptionalDemoSession } from '../session/DemoSessionProvider';
import { Avatar, Glass, ListGroup, ListRow } from '../ui/primitives';
import { FONT, WARM, memberColor, serif } from '../ui/tokens';
import { useDemoProfile } from './DemoProfileProvider';

export function DemoProfilePicker() {
  const { profiles, currentMember, saveStatus, loadWarning, selectMember, retrySave } =
    useDemoProfile();
  const demoSession = useOptionalDemoSession();
  const sessionMember =
    demoSession?.status === 'active' && demoSession.session
      ? (profiles.find((profile) => profile.id === demoSession.session?.actor.memberId) ?? null)
      : null;
  const resolvedCurrentMember = sessionMember ?? currentMember;

  return (
    <Glass style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>
        Local demo
      </Text>
      <Text style={styles.body}>
        Choose a sample member. These profiles are synthetic and do not sign you in.
      </Text>
      {!resolvedCurrentMember ? (
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          Loading your demo profile…
        </Text>
      ) : (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.current}>
            Current member: {resolvedCurrentMember.displayName}
          </Text>
          <ListGroup>
            {profiles.map((profile, index) => {
              const selected = profile.id === resolvedCurrentMember.id;
              return (
                <ListRow
                  key={profile.id}
                  first={index === 0}
                  label={profile.displayName}
                  accessibilityLabel={`Choose ${profile.displayName}, sample member${selected ? ', selected' : ''}`}
                  accessibilityState={{ selected }}
                  selected={selected}
                  note={selected ? 'Selected' : 'Sample member'}
                  leading={
                    <Avatar name={profile.displayName} color={memberColor(profile.id)} size={32} />
                  }
                  onPress={() => {
                    selectMember(profile.id);
                    if (demoSession?.status === 'active') void demoSession.chooseMember(profile.id);
                  }}
                />
              );
            })}
          </ListGroup>
          {loadWarning && (
            <Text accessibilityRole="alert" style={styles.body}>
              Could not restore your saved profile. Using the default member for now.
            </Text>
          )}
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {saveStatus === 'saving'
              ? 'Saving selection…'
              : saveStatus === 'error'
                ? 'Could not save this selection. It may not be remembered next time.'
                : loadWarning
                  ? 'Choose a member or retry to save your selection.'
                  : 'Your selection is remembered on this device.'}
          </Text>
          {(saveStatus === 'error' || loadWarning) && (
            <Pressable accessibilityRole="button" onPress={retrySave} style={styles.choice}>
              <Text style={styles.name}>Retry saving selection</Text>
            </Pressable>
          )}
        </>
      )}
    </Glass>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: WARM.sheet, borderRadius: 24, padding: 24, gap: 16, maxWidth: 520 },
  heading: { color: WARM.ink, ...serif(24) },
  body: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13, lineHeight: 19 },
  current: { color: WARM.ink, fontFamily: FONT.body, fontSize: 14, fontWeight: '600' },
  choice: {
    padding: 14,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: WARM.line,
    backgroundColor: WARM.sheet,
  },
  name: { color: WARM.ink, fontFamily: FONT.body, fontSize: 18, fontWeight: '600' },
});
