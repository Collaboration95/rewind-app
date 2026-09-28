import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useRealAccount } from '../auth/RealAccountProvider';
import { BUILT_IN_PROMPTS, GROUP_NAME_MAX_LENGTH, PROMPT_MAX_LENGTH } from '../domain/groups';
import { COLORS } from '../theme';

interface RealGroup {
  group: { id: string; name: string; role: 'owner' | 'member'; maxMembers: number };
  cycle: {
    id: string;
    prompt: string;
    startsAt: string;
    endsAt: string;
    quota: { maxCount: number; maxSeconds: number };
    contributionUsage: { countUsed: number; secondsUsed: number };
    contributionCount: number;
  };
}

async function readGroup(response: Response): Promise<RealGroup | null> {
  if (!response.ok) throw new Error('Your group could not be loaded. Retry when connected.');
  const body = (await response.json()) as { group?: RealGroup | null };
  return body.group ?? null;
}

function remainingLabel(endsAt: string): string {
  const milliseconds = Date.parse(endsAt) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'Cycle ended';
  const days = Math.ceil(milliseconds / (24 * 60 * 60 * 1000));
  return `${days} ${days === 1 ? 'day' : 'days'} remaining`;
}

export function RealAccountGroupExperience({ displayName }: { displayName: string }) {
  const auth = useRealAccount();
  const [group, setGroup] = useState<RealGroup | null>(null);
  const [screen, setScreen] = useState<
    'loading' | 'choices' | 'create' | 'home' | 'capture' | 'error'
  >('loading');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState<string>(BUILT_IN_PROMPTS[0]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [maxMembers, setMaxMembers] = useState(10);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await readGroup(await auth.authenticatedRequest('/real/groups/current'));
      setGroup(result);
      setScreen(result ? 'home' : 'choices');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Your group could not be loaded.');
      setScreen('error');
    }
  }, [auth]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const create = async () => {
    const cleanName = name.trim();
    const cleanPrompt = (useCustomPrompt ? customPrompt : prompt).trim();
    if (!cleanName || cleanName.length > GROUP_NAME_MAX_LENGTH) {
      setMessage(`Enter a group name of 1–${GROUP_NAME_MAX_LENGTH} characters.`);
      return;
    }
    if (!cleanPrompt || cleanPrompt.length > PROMPT_MAX_LENGTH) {
      setMessage(`Enter a prompt of 1–${PROMPT_MAX_LENGTH} characters.`);
      return;
    }
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 10) {
      setMessage('Choose a member limit from 2 to 10.');
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await auth.authenticatedRequest('/real/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName, prompt: cleanPrompt, maxMembers }),
      });
      if (!response.ok)
        throw new Error('The group could not be created. Check the details and retry.');
      const created = (await response.json()) as RealGroup;
      setGroup(created);
      setScreen('home');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The group could not be created.');
    } finally {
      setPending(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} testID="real-group-experience">
      <View style={styles.brand}>
        <Text style={styles.wordmark}>REWIND</Text>
        <Text style={styles.label}>REAL ACCOUNT · {displayName}</Text>
      </View>
      {screen === 'loading' ? (
        <View testID="real-group-loading">
          <Text style={styles.title}>Restoring your group…</Text>
        </View>
      ) : screen === 'error' ? (
        <View>
          <Text accessibilityRole="header" style={styles.title}>
            Group unavailable
          </Text>
          <Text accessibilityRole="alert" style={styles.body}>
            {message}
          </Text>
          <Action
            title="Retry"
            onPress={() => {
              setMessage(null);
              setScreen('loading');
              void load();
            }}
            testID="real-group-retry"
          />
        </View>
      ) : screen === 'choices' ? (
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={styles.title}>
            Choose a group
          </Text>
          {auth.notice === 'revocation-unconfirmed' ||
          auth.notice === 'sign-out-marker-unavailable' ? (
            <Text accessibilityRole="alert" style={styles.error} testID="logout-unconfirmed">
              {auth.notice === 'sign-out-marker-unavailable'
                ? 'Sign-out did not start because this device could not save its recovery state. You are still signed in. Retry sign out.'
                : Platform.OS === 'web'
                  ? 'We could not confirm sign-out. You are still signed in on this browser; retry when the service is reachable.'
                  : 'This device signed out, but server revocation was not confirmed. Another device may remain signed in until expiry or account reset.'}
            </Text>
          ) : null}
          <Text style={styles.body}>
            Create a private group for your account, or join later with an invitation.
          </Text>
          <Action
            title="Create group"
            onPress={() => {
              setMessage(null);
              setScreen('create');
            }}
            testID="real-group-create-choice"
          />
          <Action
            title="Join with invitation · not available yet"
            disabled
            onPress={() => undefined}
            testID="real-group-join-choice"
          />
          <Action
            title={
              auth.pending
                ? 'Signing out…'
                : auth.notice === 'revocation-unconfirmed' ||
                    auth.notice === 'sign-out-marker-unavailable'
                  ? 'Retry sign out'
                  : 'Sign out'
            }
            disabled={auth.pending}
            onPress={() => void auth.signOut()}
            testID="real-group-sign-out"
          />
        </View>
      ) : screen === 'create' ? (
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={styles.title}>
            Create your private group
          </Text>
          <Text style={styles.body}>You’ll be the owner. The first cycle lasts four weeks.</Text>
          <Text style={styles.label}>GROUP NAME</Text>
          <TextInput
            accessibilityLabel="Group name"
            maxLength={GROUP_NAME_MAX_LENGTH + 1}
            onChangeText={setName}
            style={styles.input}
            testID="real-group-name"
            value={name}
          />
          <Text style={styles.label}>CYCLE PROMPT</Text>
          {BUILT_IN_PROMPTS.map((item) => (
            <Action
              key={item}
              title={`${prompt === item && !useCustomPrompt ? '✓ ' : ''}${item}`}
              onPress={() => {
                setPrompt(item);
                setUseCustomPrompt(false);
              }}
            />
          ))}
          <Action
            title="Write a custom prompt"
            onPress={() => setUseCustomPrompt(true)}
            testID="real-group-custom-prompt-choice"
          />
          {useCustomPrompt ? (
            <TextInput
              accessibilityLabel="Custom prompt"
              maxLength={PROMPT_MAX_LENGTH + 1}
              multiline
              onChangeText={setCustomPrompt}
              style={[styles.input, styles.multiline]}
              testID="real-group-custom-prompt"
              value={customPrompt}
            />
          ) : null}
          <Text style={styles.label}>MEMBER LIMIT (INCLUDING YOU)</Text>
          <View style={styles.capacity}>
            <Action
              title="−"
              disabled={maxMembers <= 2}
              onPress={() => setMaxMembers((value) => value - 1)}
              testID="real-group-capacity-decrease"
            />
            <Text
              accessibilityLiveRegion="polite"
              style={styles.capacityText}
              testID="real-group-capacity"
            >
              {maxMembers}
            </Text>
            <Action
              title="+"
              disabled={maxMembers >= 10}
              onPress={() => setMaxMembers((value) => value + 1)}
              testID="real-group-capacity-increase"
            />
          </View>
          <Text style={styles.body}>
            You are the first member. Inviting others will be available later.
          </Text>
          {message ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {message}
            </Text>
          ) : null}
          <Action
            title={pending ? 'Creating…' : 'Create group'}
            disabled={pending}
            onPress={() => void create()}
            testID="real-group-create-submit"
          />
          <Action
            title="Back"
            disabled={pending}
            onPress={() => {
              setMessage(null);
              setScreen('choices');
            }}
          />
        </View>
      ) : screen === 'home' && group ? (
        <View style={styles.panel} testID="real-group-home">
          {auth.notice === 'revocation-unconfirmed' ||
          auth.notice === 'sign-out-marker-unavailable' ? (
            <Text accessibilityRole="alert" style={styles.error} testID="logout-unconfirmed">
              {auth.notice === 'sign-out-marker-unavailable'
                ? 'Sign-out did not start because this device could not save its recovery state. You are still signed in. Retry sign out.'
                : Platform.OS === 'web'
                  ? 'We could not confirm sign-out. You are still signed in on this browser; retry when the service is reachable.'
                  : 'This device signed out, but server revocation was not confirmed. Another device may remain signed in until expiry or account reset.'}
            </Text>
          ) : null}
          <Text style={styles.label}>PRIVATE GROUP · {group.group.role.toUpperCase()}</Text>
          <Text accessibilityRole="header" style={styles.title} testID="real-group-name-heading">
            {group.group.name}
          </Text>
          <Text style={styles.body}>Up to {group.group.maxMembers} members</Text>
          <View style={styles.divider} />
          <Text style={styles.label}>FOUR-WEEK CYCLE</Text>
          <Text style={styles.body} testID="real-group-countdown">
            {remainingLabel(group.cycle.endsAt)}
          </Text>
          <Text style={styles.label}>THIS CYCLE’S PROMPT</Text>
          <Text style={styles.prompt} testID="real-group-cycle-prompt">
            {group.cycle.prompt}
          </Text>
          <Text style={styles.label}>MY ALLOWANCE</Text>
          <Text style={styles.body}>
            {group.cycle.contributionUsage.countUsed} of {group.cycle.quota.maxCount} contributions
            · {group.cycle.contributionUsage.secondsUsed} of {group.cycle.quota.maxSeconds} seconds
            used
          </Text>
          {group.cycle.contributionCount === 0 ? (
            <View style={styles.empty} testID="real-group-empty-contributions">
              <Text style={styles.panelTitle}>No contributions yet</Text>
              <Text style={styles.body}>Nothing has been contributed to this cycle.</Text>
            </View>
          ) : (
            <View style={styles.empty} testID="real-group-contribution-summary">
              <Text style={styles.panelTitle}>{group.cycle.contributionCount} contributions</Text>
              <Text style={styles.body}>
                Contribution details will appear when real capture is available.
              </Text>
            </View>
          )}
          <Action
            title="Capture a moment"
            onPress={() => {
              setMessage(null);
              setScreen('capture');
            }}
            testID="real-group-capture-action"
          />
          <Action
            title={
              auth.pending
                ? 'Signing out…'
                : auth.notice === 'revocation-unconfirmed' ||
                    auth.notice === 'sign-out-marker-unavailable'
                  ? 'Retry sign out'
                  : 'Sign out'
            }
            disabled={auth.pending}
            onPress={() => void auth.signOut()}
            testID="real-group-sign-out"
          />
        </View>
      ) : (
        <View style={styles.panel} testID="real-group-capture-unavailable">
          <Text accessibilityRole="header" style={styles.title}>
            Capture a moment
          </Text>
          <Text style={styles.body}>
            Capture and media submission are not part of group setup yet. Your group and cycle are
            saved; no contribution has been created.
          </Text>
          <Action
            title="Back to Home"
            onPress={() => setScreen('home')}
            testID="real-group-capture-back"
          />
        </View>
      )}
    </ScrollView>
  );
}

function Action({
  title,
  onPress,
  disabled = false,
  testID,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, disabled && styles.disabled]}
      testID={testID}
    >
      <Text style={styles.actionText}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { gap: 18, padding: 22 },
  brand: { gap: 4 },
  wordmark: { color: COLORS.ink, fontSize: 15, fontWeight: '800', letterSpacing: 2 },
  label: { color: COLORS.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 8 },
  panel: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  title: { color: COLORS.ink, fontSize: 27, fontWeight: '700' },
  panelTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  prompt: { color: COLORS.ink, fontSize: 18, fontWeight: '600' },
  input: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    color: COLORS.ink,
    minHeight: 48,
    padding: 12,
  },
  multiline: { minHeight: 92, textAlignVertical: 'top' },
  capacity: { alignItems: 'center', flexDirection: 'row', gap: 14 },
  capacityText: {
    color: COLORS.ink,
    fontSize: 22,
    fontWeight: '700',
    minWidth: 24,
    textAlign: 'center',
  },
  action: {
    alignItems: 'center',
    borderColor: COLORS.accent,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  disabled: { opacity: 0.45 },
  actionText: { color: COLORS.ink, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  error: { color: '#ffb8a9', fontSize: 14 },
  divider: { borderTopColor: COLORS.edge, borderTopWidth: 1, marginVertical: 4 },
  empty: { borderColor: COLORS.edge, borderRadius: 8, borderWidth: 1, gap: 6, padding: 14 },
});
