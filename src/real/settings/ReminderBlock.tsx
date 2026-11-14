import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { userMessage } from '../../domain/user-message';
import type {
  PrivateReminderClient,
  PrivateReminderSnapshot,
} from '../../reminders/private-reminder-client';
import { Icon } from '../../ui/Icon';
import {
  Button,
  Dialog,
  ErrorText,
  ListGroup,
  ListRow,
  Switch,
  TextLink,
  useNow,
  useToast,
} from '../../ui/primitives';
import { FONT, WARM } from '../../ui/tokens';
import { postJson } from '../request';
import type { Request, SettingsGroup } from './types';

interface Preference {
  enabled: boolean;
  snoozedUntil: string | null;
  timeZone: string;
  delivery?: { state: string; message: string };
}

/* ---------- Reminder (S1 rows, S10, S11) ---------- */

const isIphoneSafari = () => {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches);
  return /iPhone|iPod/.test(navigator.userAgent) && !standalone;
};

export function ReminderBlock({
  group,
  request,
  reminderClient,
}: {
  group: SettingsGroup;
  request: Request;
  reminderClient: PrivateReminderClient | null;
}) {
  const toast = useToast();
  const [preference, setPreference] = useState<Preference | null>(null);
  const [device, setDevice] = useState<PrivateReminderSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'notify' | 'install' | null>(null);
  const active = useRef(true);
  // Bumped when the group, session or device client changes; late results are dropped.
  const epoch = useRef(0);
  const now = useNow();
  const path = `/real/groups/${encodeURIComponent(group.group.id)}/reminders`;

  useEffect(() => {
    active.current = true;
    void request(path)
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const body = (await response.json()) as { preference: Preference };
        if (active.current) setPreference(body.preference);
      })
      .catch(() => {
        if (active.current)
          setMessage('Reminder preferences could not be loaded. Retry when connected.');
      });
    return () => {
      active.current = false;
    };
  }, [path, request]);

  useEffect(() => {
    const mine = epoch.current;
    return () => {
      if (epoch.current === mine) epoch.current += 1;
      // A dropped in-flight action must not leave the controls locked.
      setPending(false);
    };
  }, [path, request, reminderClient]);

  useEffect(() => {
    if (!reminderClient) return;
    let current = true;
    void reminderClient.load().then((snapshot) => {
      if (current) setDevice(snapshot);
    });
    return () => {
      current = false;
    };
  }, [reminderClient]);

  const save = useCallback(
    async (enabled: boolean, snoozedUntil: string | null, done: string) => {
      const mine = epoch.current;
      setPending(true);
      setMessage(null);
      try {
        const response = await request(path, postJson({ enabled, snoozedUntil }));
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? 'Sign in again to save these settings.'
              : 'Your reminder could not be saved. Retry when connected.',
          );
        const body = (await response.json()) as { preference?: Preference };
        if (!active.current || epoch.current !== mine) return false;
        if (body.preference) setPreference(body.preference);
        toast(done);
        return true;
      } catch (error) {
        if (active.current && epoch.current === mine)
          setMessage(userMessage(error, 'Your reminder could not be saved.'));
        return false;
      } finally {
        if (active.current && epoch.current === mine) setPending(false);
      }
    },
    [path, request, toast],
  );

  const turnOn = async () => {
    if (reminderClient && device?.canEnable) {
      setDialog('notify');
      return;
    }
    // This device can't take push (no support or not installed); the row says why.
    // Only the schedule is saved here, so the copy never claims the device is registered.
    const saved = await save(true, null, 'Sunday 7 PM reminder saved.');
    // iPhone Safari only gets push from the Home Screen app: show how, now.
    if (saved && isIphoneSafari() && active.current) setDialog('install');
  };
  const allow = async () => {
    setDialog(null);
    if (!reminderClient) {
      await save(true, null, 'Sunday 7 PM reminder saved.');
      return;
    }
    const mine = epoch.current;
    const current = () => active.current && epoch.current === mine;
    setPending(true);
    setMessage(null);
    const snapshot = await reminderClient.enable().catch(() => null);
    if (!current()) return;
    setPending(false);
    if (!snapshot) {
      setMessage('This device could not be registered. Retry when connected.');
      return;
    }
    setDevice(snapshot);
    // Registration is confirmed only by an enabled snapshot; everything else is a failure.
    if (snapshot.state !== 'enabled' || snapshot.enabled !== true) {
      if (snapshot.state === 'denied') toast('Notifications are off in your browser settings');
      else setMessage(snapshot.message);
      return;
    }
    // The schedule is a separate preference: register first, then save it.
    const saved = await save(true, null, 'Sunday 7 PM reminders are on for this device.');
    if (!saved && current())
      setMessage(
        'This device is registered, but your reminder schedule could not be saved. Retry.',
      );
  };
  const turnOff = async () => {
    const saved = await save(false, null, 'Sunday 7 PM reminders are off.');
    if (saved && reminderClient && device?.canDisable) {
      const snapshot = await reminderClient.disable().catch(() => null);
      if (snapshot && active.current) setDevice(snapshot);
    }
  };

  const on = Boolean(preference?.enabled);
  const snoozed = Boolean(preference?.snoozedUntil && Date.parse(preference.snoozedUntil) > now);
  // The device's own state (registered, denied, unsupported) beats the schedule.
  const deliveryNote = on && device && device.state !== 'available' ? device.message : null;
  const note = !preference
    ? 'Loading…'
    : !on
      ? 'Off'
      : snoozed
        ? 'Snoozed for 7 days'
        : (deliveryNote ?? 'Sundays at 7 PM, group time');
  return (
    <>
      <ListGroup testID="real-group-settings">
        <ListRow
          first
          icon="bell"
          label="Weekly reminder"
          note={note}
          testID="real-group-reminder-schedule"
          trailing={
            <Switch
              disabled={!preference || pending}
              label="Weekly reminder"
              onValueChange={(next) => void (next ? turnOn() : turnOff())}
              testID="real-group-reminder-toggle"
              value={on}
            />
          }
        />
        {on ? (
          <ListRow
            accessibilityState={{ selected: snoozed }}
            disabled={pending}
            icon="snooze"
            label={snoozed ? 'End snooze' : 'Snooze for 7 days'}
            onPress={() =>
              void (snoozed
                ? save(true, null, 'Reminder is back on for this Sunday.')
                : save(
                    true,
                    new Date(Date.now() + 7 * 86_400_000).toISOString(),
                    'Snoozed until next Sunday.',
                  ))
            }
            testID="real-group-reminder-snooze"
          />
        ) : null}
      </ListGroup>
      {message ? <ErrorText>{message}</ErrorText> : null}
      {dialog === 'notify' ? (
        <Dialog
          body="One notification a week, Sundays at 7 PM in your group’s time zone. Your phone asks next."
          label="Allow notifications"
          testID="real-notify-dialog"
          title="Get the Sunday reminder?"
        >
          <Button
            label="Continue"
            onPress={() => void allow()}
            testID="real-notify-continue"
            variant="primary"
          />
          {isIphoneSafari() ? (
            <TextLink
              label="On iPhone? Add Rewind to your Home Screen first"
              onPress={() => setDialog('install')}
              testID="real-notify-install"
            />
          ) : null}
        </Dialog>
      ) : null}
      {dialog === 'install' ? (
        <Dialog
          body="On iPhone, reminders only arrive in the Home Screen app."
          label="Add to Home Screen"
          onDismiss={() => setDialog(null)}
          title="Add Rewind to your Home Screen"
        >
          <View style={styles.steps}>
            <View style={styles.stepRow}>
              <Text style={styles.stepText}>1. Tap </Text>
              <Icon name="share" size={15} />
              <Text style={styles.stepText}> Share in Safari</Text>
            </View>
            <Text style={styles.stepText}>
              2. Choose <Text style={styles.bold}>Add to Home Screen</Text>
            </Text>
            <Text style={styles.stepText}>
              3. Open Rewind from your Home Screen and turn the reminder on
            </Text>
          </View>
          <Button label="Got it" onPress={() => setDialog(null)} variant="primary" />
        </Dialog>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  steps: { gap: 8, marginBottom: 8 },
  stepRow: { alignItems: 'center', flexDirection: 'row' },
  stepText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 13.5, lineHeight: 19 },
  bold: { fontWeight: '600' },
});
