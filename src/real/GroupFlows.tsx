import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BUILT_IN_PROMPTS, GROUP_NAME_MAX_LENGTH, PROMPT_MAX_LENGTH } from '../domain/groups';
import { Icon } from '../ui/Icon';
import {
  Button,
  ErrorText,
  Field,
  Glass,
  Glow,
  Lead,
  ScreenScroll,
  SectionLabel,
  SubHeader,
} from '../ui/primitives';
import { FONT, WARM, serif } from '../ui/tokens';
import { PromptPicker } from './Settings';

/** "abcdef" or "ABC DEF" → "ABC-DEF" while typing. */
export const formatInviteCode = (value: string) => {
  const letters = value
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, 6);
  return letters.length > 3 ? `${letters.slice(0, 3)}-${letters.slice(3)}` : letters;
};

/* ---------- D2/D3 Have an invite?, D4 Joined ---------- */

export function JoinScreen({
  onBack,
  onJoin,
  pending,
  error,
  joinedName,
  onGoToGroup,
}: {
  onBack: () => void;
  onJoin: (code: string) => void;
  pending: boolean;
  error: string | null;
  /** Set once the code worked (D4). */
  joinedName: string | null;
  onGoToGroup: () => void;
}) {
  const [code, setCode] = useState('');
  return (
    <View style={styles.screen}>
      <Glow />
      <ScreenScroll>
        <SubHeader backTestID="real-join-back" onBack={onBack} title="Have an invite?" />
        {joinedName ? (
          <>
            <Glass style={styles.ok} testID="real-join-done">
              <View style={styles.okIcon}>
                <Icon color="#fff" name="check" size={22} strokeWidth={2.6} />
              </View>
              <Text accessibilityRole="header" style={styles.okTitle}>
                Joined {joinedName}
              </Text>
              <Text style={styles.note}>The code is now used.</Text>
            </Glass>
            <Button
              label="Go to the group"
              onPress={onGoToGroup}
              testID="real-join-go"
              variant="primary"
            />
          </>
        ) : (
          <>
            <Lead>Enter the six-letter code the group owner sent you.</Lead>
            <Field
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect={false}
              label="Invite code"
              maxLength={7}
              mono
              onChangeText={(value) => setCode(formatInviteCode(value))}
              onSubmitEditing={() => onJoin(code)}
              placeholder="ABC-DEF"
              spellCheck={false}
              testID="real-group-enter-code"
              value={code}
            />
            <ErrorText testID="real-group-join-feedback">{error}</ErrorText>
            <Button
              busy={pending}
              busyLabel="Joining…"
              label="Accept invitation"
              onPress={() => onJoin(code)}
              testID="real-group-join-choice"
              variant="primary"
            />
          </>
        )}
      </ScreenScroll>
    </View>
  );
}

/* ---------- D5 New group ---------- */

export interface NewGroupInput {
  name: string;
  prompt: string;
  maxMembers: number;
}

export function validateNewGroup({ name, prompt, maxMembers }: NewGroupInput): string | null {
  if (!name.trim() || name.trim().length > GROUP_NAME_MAX_LENGTH)
    return `Enter a group name of 1–${GROUP_NAME_MAX_LENGTH} characters.`;
  if (!prompt.trim() || prompt.trim().length > PROMPT_MAX_LENGTH)
    return `Enter a prompt of 1–${PROMPT_MAX_LENGTH} characters.`;
  if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 10)
    return 'Choose a member limit from 2 to 10.';
  return null;
}

export function CreateGroupScreen({
  onBack,
  onCreate,
  pending,
  error,
}: {
  onBack: () => void;
  onCreate: (input: NewGroupInput) => void;
  pending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<string>(BUILT_IN_PROMPTS[0]);
  const [custom, setCustom] = useState('');
  const [limit, setLimit] = useState(10);
  const [local, setLocal] = useState<string | null>(null);
  const submit = () => {
    const input = {
      name: name.trim(),
      prompt: (choice === 'custom' ? custom : choice).trim(),
      maxMembers: limit,
    };
    const problem = validateNewGroup(input);
    setLocal(problem);
    if (!problem) onCreate(input);
  };
  return (
    <View style={styles.screen}>
      <Glow />
      <ScreenScroll>
        <SubHeader backTestID="real-create-back" onBack={onBack} title="New group" />
        <Field
          autoComplete="off"
          label="Group name"
          maxLength={GROUP_NAME_MAX_LENGTH}
          onChangeText={setName}
          placeholder="e.g. Saturday table"
          testID="real-group-name"
          value={name}
        />
        <SectionLabel>Prompt</SectionLabel>
        <PromptPicker
          custom={custom}
          onChange={setChoice}
          onCustomChange={setCustom}
          value={choice}
        />
        <Glass style={styles.limit}>
          <View style={styles.limitText}>
            <Text style={styles.limitLabel}>Member limit</Text>
            <Text style={styles.note}>2–10, including you</Text>
          </View>
          <Stepper
            label="Fewer"
            disabled={limit <= 2}
            onPress={() => setLimit((value) => value - 1)}
            testID="real-group-capacity-decrease"
            text="−"
          />
          <Text
            accessibilityLiveRegion="polite"
            style={styles.limitValue}
            testID="real-group-capacity"
          >
            {limit}
          </Text>
          <Stepper
            label="More"
            disabled={limit >= 10}
            onPress={() => setLimit((value) => value + 1)}
            testID="real-group-capacity-increase"
            text="+"
          />
        </Glass>
        <ErrorText>{local ?? error}</ErrorText>
        <Lead>You’ll be the owner. The first cycle lasts four weeks and starts now.</Lead>
        <Button
          busy={pending}
          busyLabel="Creating group…"
          label="Create group"
          onPress={submit}
          testID="real-group-create-submit"
          variant="primary"
        />
      </ScreenScroll>
    </View>
  );
}

function Stepper({
  label,
  text,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  text: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.step, disabled && styles.off, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={styles.stepText}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: WARM.bg, flex: 1, overflow: 'hidden' },
  ok: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 18,
    paddingHorizontal: 18,
    paddingVertical: 24,
  },
  okIcon: {
    alignItems: 'center',
    backgroundColor: WARM.accent,
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  okTitle: { color: WARM.ink, textAlign: 'center', ...serif(24) },
  note: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13 },
  limit: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginTop: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  limitText: { flex: 1 },
  limitLabel: { color: WARM.ink, fontFamily: FONT.body, fontSize: 15, fontWeight: '500' },
  limitValue: { color: WARM.ink, minWidth: 30, textAlign: 'center', ...serif(22) },
  step: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.7)',
    borderColor: WARM.line,
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  stepText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 22, lineHeight: 26 },
  off: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
