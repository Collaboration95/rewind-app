import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useDemoProfile } from './DemoProfileProvider';

export function DemoProfilePicker() {
  const { profiles, currentMember, saveStatus, loadWarning, selectMember, retrySave } =
    useDemoProfile();
  const [focusedId, setFocusedId] = useState<string | null>(null);

  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>
        Local demo
      </Text>
      <Text style={styles.body}>
        Choose a sample member. These profiles are synthetic and do not sign you in.
      </Text>
      {!currentMember ? (
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          Loading your demo profile…
        </Text>
      ) : (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.current}>
            Current member: {currentMember.displayName}
          </Text>
          <View style={styles.choices}>
            {profiles.map((profile) => {
              const selected = profile.id === currentMember.id;
              return (
                <Pressable
                  key={profile.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Choose ${profile.displayName}, sample member`}
                  accessibilityState={{ selected }}
                  onPress={() => selectMember(profile.id)}
                  onFocus={() => setFocusedId(profile.id)}
                  onBlur={() => setFocusedId(null)}
                  style={[
                    styles.choice,
                    selected && styles.selected,
                    focusedId === profile.id && styles.focused,
                  ]}
                >
                  <Text style={styles.name}>{profile.displayName}</Text>
                  <Text style={styles.body}>{selected ? 'Selected' : 'Sample member'}</Text>
                </Pressable>
              );
            })}
          </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#E4EEE7', borderRadius: 20, padding: 24, gap: 16, maxWidth: 620 },
  heading: { color: '#1D2622', fontSize: 24, fontWeight: '700' },
  body: { color: '#3D4B44', fontSize: 16, lineHeight: 24 },
  current: { color: '#1D2622', fontSize: 20, fontWeight: '600' },
  choices: { gap: 12 },
  choice: {
    padding: 14,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#687E70',
    backgroundColor: '#F5F1EA',
  },
  selected: { borderColor: '#236341', backgroundColor: '#CDE4D3' },
  focused: { borderColor: '#1D2622', borderWidth: 4 },
  name: { color: '#1D2622', fontSize: 18, fontWeight: '600' },
});
