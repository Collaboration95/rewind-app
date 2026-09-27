import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useDemoProfile } from './DemoProfileProvider';
import { useI18n } from '../i18n/LanguageProvider';
import { COLORS } from '../theme';
import { useOptionalDemoSession } from '../session/DemoSessionProvider';

export function DemoProfilePicker() {
  const { t } = useI18n();
  const { profiles, currentMember, saveStatus, loadWarning, selectMember, retrySave } =
    useDemoProfile();
  const demoSession = useOptionalDemoSession();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const sessionMember =
    demoSession?.status === 'active' && demoSession.session
      ? (profiles.find((profile) => profile.id === demoSession.session?.actor.memberId) ?? null)
      : null;
  const resolvedCurrentMember = sessionMember ?? currentMember;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{t('SWITCH MEMBER')}</Text>
      <Text accessibilityRole="header" style={styles.heading}>
        {t('Local demo')}
      </Text>
      <Text style={styles.body}>
        {t('Choose a sample member. These profiles are synthetic and do not sign you in.')}
      </Text>
      {!resolvedCurrentMember ? (
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {t('Loading your demo profile…')}
        </Text>
      ) : (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.current}>
            {t('Current member: {name}', { name: resolvedCurrentMember.displayName })}
          </Text>
          <View style={styles.choices}>
            {profiles.map((profile) => {
              const selected = profile.id === resolvedCurrentMember.id;
              return (
                <Pressable
                  key={profile.id}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    selected
                      ? 'Choose {name}, sample member, selected'
                      : 'Choose {name}, sample member',
                    { name: profile.displayName },
                  )}
                  accessibilityState={{ selected }}
                  onPress={() => {
                    selectMember(profile.id);
                    if (demoSession?.status === 'active') void demoSession.chooseMember(profile.id);
                  }}
                  onFocus={() => setFocusedId(profile.id)}
                  onBlur={() => setFocusedId(null)}
                  style={[
                    styles.choice,
                    selected && styles.selected,
                    focusedId === profile.id && styles.focused,
                  ]}
                >
                  <Text style={styles.name}>{profile.displayName}</Text>
                  <Text style={styles.body}>{selected ? t('Selected') : t('Sample member')}</Text>
                </Pressable>
              );
            })}
          </View>
          {loadWarning && (
            <Text accessibilityRole="alert" style={styles.body}>
              {t('Could not restore your saved profile. Using the default member for now.')}
            </Text>
          )}
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {t(
              saveStatus === 'saving'
                ? 'Saving selection…'
                : saveStatus === 'error'
                  ? 'Could not save this selection. It may not be remembered next time.'
                  : loadWarning
                    ? 'Choose a member or retry to save your selection.'
                    : 'Your selection is remembered on this device.',
            )}
          </Text>
          {(saveStatus === 'error' || loadWarning) && (
            <Pressable accessibilityRole="button" onPress={retrySave} style={styles.choice}>
              <Text style={styles.name}>{t('Retry saving selection')}</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 9,
    borderWidth: 1,
    gap: 10,
    padding: 17,
  },
  label: { color: COLORS.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.4 },
  heading: { color: COLORS.ink, fontSize: 19, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  current: { color: COLORS.ink, fontSize: 16, fontWeight: '700' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: '47%',
    flexGrow: 1,
    gap: 2,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  selected: { backgroundColor: COLORS.deep, borderColor: COLORS.accent },
  focused: { borderColor: COLORS.ink, borderWidth: 2 },
  name: { color: COLORS.ink, fontSize: 15, fontWeight: '700' },
});
