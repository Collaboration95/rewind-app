import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useI18n } from '../i18n/LanguageProvider';
import { useDemoSession } from '../session/DemoSessionProvider';
import { COLORS } from '../theme';
import { ActionButton, InlineError, Quiet, ScreenIntro } from '../ui/kit';

export type EntryDebugScenario = 'loading' | 'error';

/** Session restore copy shared by the launch gate and its debug preview. */
export function SessionRestoring() {
  const { t } = useI18n();
  return (
    <View style={styles.stack} testID="entry-restoring">
      <ScreenIntro
        body={t('Checking the local Demo session.')}
        eyebrow={t('DEMO ACCESS')}
        title={t('Restoring local access…')}
      />
    </View>
  );
}

/**
 * Demo member chooser. Synthetic members only: choosing one is local Demo
 * access, not sign-in. `onEntered` lets the in-app debug preview return Home.
 */
export function DemoAccessChooser({
  debugScenario = null,
  onEntered,
}: {
  debugScenario?: EntryDebugScenario | null;
  onEntered?: () => void;
}) {
  const { t } = useI18n();
  const { profiles, chooseMember, error, pending, retryRestore } = useDemoSession();
  if (debugScenario === 'loading') return <SessionRestoring />;
  const shownError =
    debugScenario === 'error' ? t('Could not enter. Choose a member again.') : error;

  return (
    <View style={styles.stack}>
      <ScreenIntro
        body={t('Synthetic Demo members. No real account.')}
        eyebrow={t('DEMO ACCESS')}
        headingTestID="route-heading-entry"
        title={t('Choose a Demo member')}
      />
      {shownError ? (
        <View
          accessibilityLabel={t('Demo access error')}
          accessible={false}
          testID="demo-access-error"
        >
          <InlineError>{shownError}</InlineError>
          {error ? (
            <View style={styles.retry}>
              <ActionButton label={t('Retry Demo access')} onPress={retryRestore} />
            </View>
          ) : null}
        </View>
      ) : null}
      <View style={styles.members}>
        {profiles.map((profile) => (
          <Pressable
            accessibilityHint={t('Starts local Demo access for this synthetic member')}
            accessibilityLabel={t('Enter Demo as {name}, sample member', {
              name: profile.displayName,
            })}
            accessibilityRole="button"
            disabled={pending}
            key={profile.id}
            onPress={() =>
              void chooseMember(profile.id).then(() => {
                onEntered?.();
              })
            }
            style={({ pressed }) => [
              styles.member,
              pending && styles.disabled,
              pressed && styles.pressed,
            ]}
            testID={`demo-entry-${profile.id}`}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{profile.displayName.slice(0, 1)}</Text>
            </View>
            <View style={styles.memberText}>
              <Text style={styles.memberName}>{profile.displayName}</Text>
              <Text style={styles.memberCaption}>
                {t('Enter Demo as {name} · synthetic', { name: profile.displayName })}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
      {pending ? <Quiet>{t('Starting Demo access…')}</Quiet> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 18 },
  retry: { marginTop: 8 },
  members: { gap: 9 },
  member: {
    alignItems: 'center',
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 9,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  disabled: { opacity: 0.55 },
  pressed: { borderColor: COLORS.accent },
  avatar: {
    alignItems: 'center',
    borderColor: COLORS.line,
    borderRadius: 16,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  avatarText: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  memberText: { flex: 1, gap: 2 },
  memberName: { color: COLORS.ink, fontSize: 16, fontWeight: '700' },
  memberCaption: { color: COLORS.muted, fontSize: 12 },
});
