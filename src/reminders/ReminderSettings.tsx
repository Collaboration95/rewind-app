import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useI18n } from '../i18n/LanguageProvider';
import { COLORS } from '../theme';
import { reminderService, type ReminderService, type ReminderSnapshot } from './reminder-service';

export function ReminderSettings({ service = reminderService }: { service?: ReminderService }) {
  const { t } = useI18n();
  const [reminder, setReminder] = useState<ReminderSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void service
      .load()
      .then((loaded) => {
        if (active) setReminder(loaded);
      })
      .catch(() => {
        if (active) setError('Reminder status could not be loaded. Try again.');
      });
    return () => {
      active = false;
    };
  }, [service]);

  async function update(action: () => Promise<ReminderSnapshot>) {
    setPending(true);
    setError(null);
    try {
      setReminder(await action());
    } catch {
      setError('The local reminder could not be updated. Try again on this device.');
    } finally {
      setPending(false);
    }
  }

  const unavailable = reminder?.availability === 'unsupported';
  const denied = reminder?.availability === 'permission-denied';
  const undecided = reminder?.availability === 'permission-undecided';

  return (
    <View style={styles.panel} testID="settings-reminders">
      <Text style={styles.label}>{t('LOCAL REMINDERS')}</Text>
      <Text accessibilityRole="header" style={styles.title}>
        {t('Sunday 7pm reminder')}
      </Text>
      <Text style={styles.body}>
        {t(
          'This is a device-only reminder. It does not use remote push tokens or cloud scheduling.',
        )}
      </Text>
      {reminder ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[
            styles.status,
            unavailable || denied ? styles.statusWarning : styles.statusPositive,
          ]}
          testID={`reminder-status-${reminder.availability}`}
        >
          {t(reminder.message)}
        </Text>
      ) : (
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {t('Checking local notification support…')}
        </Text>
      )}
      {unavailable ? (
        <Text style={styles.detail} testID="reminder-unsupported">
          {t('Web browsers cannot schedule this local notification.')}
        </Text>
      ) : null}
      {denied ? (
        <Text style={styles.detail} testID="reminder-permission-denied">
          {t(
            'Rewind cannot enable the reminder until notifications are allowed in device settings.',
          )}
        </Text>
      ) : null}
      {undecided ? (
        <Text style={styles.detail} testID="reminder-permission-undecided">
          {t('Enabling the reminder will ask for notification permission.')}
        </Text>
      ) : null}
      <Pressable
        accessibilityLabel={t('Sunday 7pm reminder')}
        accessibilityRole="switch"
        aria-checked={reminder?.enabled ?? false}
        accessibilityState={{
          checked: reminder?.enabled ?? false,
          disabled: pending || unavailable,
        }}
        disabled={!reminder || pending || unavailable}
        onPress={() => void update(reminder?.enabled ? service.disable : service.enable)}
        style={[styles.primaryButton, (!reminder || pending || unavailable) && styles.disabled]}
        testID="reminder-toggle"
      >
        <Text style={styles.primaryButtonText}>
          {t(
            pending
              ? 'Updating reminder…'
              : reminder?.enabled
                ? 'Disable reminder'
                : 'Enable reminder',
          )}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={!reminder || pending || unavailable}
        onPress={() => void update(service.triggerTest)}
        style={[styles.outlineButton, (!reminder || pending || unavailable) && styles.disabled]}
        testID="reminder-test"
      >
        <Text style={styles.outlineButtonText}>{t('Send a test reminder now')}</Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t(error)}
        </Text>
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
  status: { fontSize: 14, lineHeight: 21 },
  statusPositive: { color: COLORS.ink },
  statusWarning: { color: COLORS.accent },
  detail: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  primaryButtonText: { color: COLORS.accentInk, fontSize: 14, fontWeight: '800' },
  outlineButton: {
    alignItems: 'center',
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  outlineButtonText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  error: { color: COLORS.accent, fontSize: 14, lineHeight: 21 },
});
