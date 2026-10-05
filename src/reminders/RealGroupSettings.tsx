import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { BUILT_IN_PROMPTS } from '../domain/groups';
import { WARM } from '../ui/tokens';

interface Preference {
  enabled: boolean;
  snoozedUntil: string | null;
  timeZone: string;
  nextScheduledAt: string;
  delivery: { state: string; message: string };
}

interface SettingsGroup {
  group: { id: string; role: 'owner' | 'member'; timeZone?: string };
  cycle: { prompt: string };
}

export function RealGroupSettings<T extends SettingsGroup>({
  group,
  authenticatedRequest,
  onUpdated,
}: {
  group: T;
  authenticatedRequest: (path: string, options?: RequestInit) => Promise<Response>;
  onUpdated: (group: T) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [prompt, setPrompt] = useState(group.cycle.prompt);
  const [timeZone, setTimeZone] = useState(group.group.timeZone ?? 'UTC');
  const [preference, setPreference] = useState<Preference | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const contextVersion = useRef(0);
  const path = `/real/groups/${encodeURIComponent(group.group.id)}`;

  const [context, setContext] = useState({ path, authenticatedRequest });
  // Reset during rendering so another group's controls are never committed
  // with the previous account's preferences or unfinished edits.
  if (context.path !== path || context.authenticatedRequest !== authenticatedRequest) {
    setContext({ path, authenticatedRequest });
    setPrompt(group.cycle.prompt);
    setTimeZone(group.group.timeZone ?? 'UTC');
    setPreference(null);
    setPending(false);
    setMessage(null);
  }

  useEffect(() => {
    const context = ++contextVersion.current;
    if (!expanded) return;
    let active = true;
    void authenticatedRequest(`${path}/reminders`)
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const body = (await response.json()) as { preference: Preference };
        if (active && context === contextVersion.current) setPreference(body.preference);
      })
      .catch(() => {
        if (active && context === contextVersion.current)
          setMessage('Reminder preferences could not be loaded. Retry when connected.');
      });
    return () => {
      active = false;
      contextVersion.current += 1;
    };
  }, [authenticatedRequest, path, expanded]);

  const mutate = async (kind: 'settings' | 'reminders', body: object) => {
    const context = contextVersion.current;
    setPending(true);
    setMessage(null);
    try {
      const response = await authenticatedRequest(`${path}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          response.status === 403
            ? 'Only the group owner can change the prompt and timezone.'
            : response.status === 401
              ? 'Sign in again to save these settings.'
              : result?.error === 'cycle_closed'
                ? 'This cycle has closed. Reload your group before editing.'
                : 'Check the prompt and IANA timezone, then retry.',
        );
      }
      const result = (await response.json()) as { group?: T; preference?: Preference };
      if (context !== contextVersion.current) return;
      if (result.group) onUpdated(result.group);
      if (result.preference) setPreference(result.preference);
      setMessage(
        kind === 'settings'
          ? 'Prompt and timezone saved. The prompt applies to this collecting cycle and future cycles.'
          : 'Your group reminder preference is saved.',
      );
    } catch (error) {
      if (context === contextVersion.current)
        setMessage(
          error instanceof Error
            ? error.message
            : 'Settings could not be saved. Retry when connected.',
        );
    } finally {
      if (context === contextVersion.current) setPending(false);
    }
  };

  if (!expanded)
    return (
      <Pressable
        accessibilityRole="button"
        testID="real-group-open-settings"
        style={styles.action}
        onPress={() => setExpanded(true)}
      >
        <Text style={styles.button}>
          {group.group.role === 'owner'
            ? 'Group settings and reminders'
            : 'My group reminder settings'}
        </Text>
      </Pressable>
    );

  return (
    <View style={styles.panel} testID="real-group-settings">
      {group.group.role === 'owner' ? (
        <>
          <Text style={styles.title}>GROUP PROMPT AND TIMEZONE</Text>
          <Text style={styles.body}>
            Changes apply to the current collecting cycle and future cycles. Previous films and
            deadlines stay fixed.
          </Text>
          {BUILT_IN_PROMPTS.map((item) => (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityState={{ disabled: pending, selected: prompt === item }}
              disabled={pending}
              onPress={() => setPrompt(item)}
              style={styles.action}
            >
              <Text style={styles.button}>{item}</Text>
            </Pressable>
          ))}
          <TextInput
            accessibilityLabel="Edit group prompt"
            testID="real-group-edit-prompt"
            value={prompt}
            onChangeText={setPrompt}
            maxLength={160}
            editable={!pending}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Group timezone"
            testID="real-group-timezone"
            value={timeZone}
            onChangeText={setTimeZone}
            editable={!pending}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Text style={styles.body}>
            Use an IANA timezone, for example Asia/Singapore or America/New_York. Default: UTC.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: pending }}
            disabled={pending}
            onPress={() => void mutate('settings', { prompt, timeZone })}
            testID="real-group-save-settings"
            style={styles.action}
          >
            <Text style={styles.button}>{pending ? 'Saving…' : 'Save prompt and timezone'}</Text>
          </Pressable>
        </>
      ) : null}
      <Text style={styles.title}>MY GROUP REMINDERS</Text>
      <Text style={styles.body} testID="real-group-reminder-schedule">
        Sunday 19:00 · {preference?.timeZone ?? group.group.timeZone ?? 'UTC'} (group timezone)
      </Text>
      {preference ? (
        <>
          <Text style={styles.body}>
            {preference.enabled ? 'Preference enabled' : 'Preference disabled'}
            {preference.snoozedUntil
              ? ` · Snoozed until ${new Date(preference.snoozedUntil).toLocaleString()}`
              : ''}
          </Text>
          <Text style={styles.body} testID="real-group-reminder-delivery">
            {preference.delivery.message}
          </Text>
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="Group reminder preference"
            accessibilityState={{ checked: preference.enabled, disabled: pending }}
            disabled={pending}
            testID="real-group-reminder-toggle"
            style={styles.action}
            onPress={() =>
              void mutate('reminders', {
                enabled: !preference.enabled,
                snoozedUntil: preference.snoozedUntil,
              })
            }
          >
            <Text style={styles.button}>
              {preference.enabled ? 'Disable my reminders' : 'Enable my reminder preference'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: pending }}
            disabled={pending}
            testID="real-group-reminder-snooze"
            style={styles.action}
            onPress={() =>
              void mutate('reminders', {
                enabled: preference.enabled,
                snoozedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
              })
            }
          >
            <Text style={styles.button}>Snooze for 7 days</Text>
          </Pressable>
          {preference.snoozedUntil ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: pending }}
              disabled={pending}
              style={styles.action}
              onPress={() =>
                void mutate('reminders', { enabled: preference.enabled, snoozedUntil: null })
              }
            >
              <Text style={styles.button}>End snooze</Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <Text style={styles.body}>Loading your reminder preference…</Text>
      )}
      {message ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.body}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 10, marginVertical: 18 },
  title: { color: WARM.ink, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  body: { color: WARM.ink, fontSize: 15, lineHeight: 22 },
  input: {
    color: WARM.ink,
    borderWidth: 1,
    borderColor: WARM.ink,
    padding: 12,
    borderRadius: 6,
    minHeight: 44,
  },
  action: { minHeight: 44, paddingVertical: 12 },
  button: { color: WARM.ink, fontSize: 15, fontWeight: '600' },
});
