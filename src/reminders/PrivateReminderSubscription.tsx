import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../theme';
import type { PrivateReminderClient, PrivateReminderSnapshot } from './private-reminder-client';

// Lead supplies a client scoped to the authenticated session/current group.
// A parent lifecycle must await client.revoke() before group switch or logout.
export function PrivateReminderSubscription({ client }: { client: PrivateReminderClient }) {
  return <SubscriptionContext key={clientIdentity(client)} client={client} />;
}
const identities = new WeakMap<PrivateReminderClient, number>();
let nextIdentity = 0;
function clientIdentity(client: PrivateReminderClient) {
  if (!identities.has(client)) identities.set(client, ++nextIdentity);
  return identities.get(client)!;
}
function SubscriptionContext({ client }: { client: PrivateReminderClient }) {
  const [snapshot, setSnapshot] = useState<PrivateReminderSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void client.load().then((value) => {
      if (active) setSnapshot(value);
    });
    return () => {
      active = false;
      mounted.current = false;
      // Service lifetime belongs to the auth/group owner, including pre-switch revoke.
    };
  }, [client]);
  async function update(action: () => Promise<PrivateReminderSnapshot>) {
    setPending(true);
    try {
      const value = await action();
      if (mounted.current) setSnapshot(value);
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  return (
    <View style={styles.panel} testID="private-reminder-subscription">
      <Text accessibilityRole="header" style={styles.title}>
        REMOTE GROUP REMINDERS
      </Text>
      <Text style={styles.body}>
        Register this device to receive private group reminders. Your group schedule and snooze
        preference apply separately.
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.body} testID="private-reminder-status">
        {snapshot?.message ?? 'Checking remote notification support…'}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: pending || !snapshot?.canEnable }}
        disabled={pending || !snapshot?.canEnable}
        onPress={() => void update(client.enable)}
        testID="private-reminder-enable"
        style={styles.action}
      >
        <Text style={styles.body}>Enable reminders on this device</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: pending || !snapshot?.canDisable }}
        disabled={pending || !snapshot?.canDisable}
        onPress={() => void update(client.disable)}
        testID="private-reminder-disable"
        style={styles.action}
      >
        <Text style={styles.body}>Disable reminders on this device</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: pending }}
        disabled={pending}
        onPress={() => void update(client.load)}
        testID="private-reminder-check"
        style={styles.action}
      >
        <Text style={styles.body}>{pending ? 'Updating…' : 'Check support again'}</Text>
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { gap: 10, marginVertical: 18 },
  title: { color: COLORS.ink, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  body: { color: COLORS.ink, fontSize: 15, lineHeight: 22 },
  action: { minHeight: 44, paddingVertical: 12 },
});
