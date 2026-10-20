import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';

import { BUILT_IN_PROMPTS, PROMPT_MAX_LENGTH } from '../../domain/groups';
import { userMessage } from '../../domain/user-message';
import { Button, ErrorText, Lead, ScreenScroll, SubHeader, useToast } from '../../ui/primitives';
import { FONT, WARM } from '../../ui/tokens';
import { RadioList } from '../RadioList';
import { saveGroupSettings } from './save-group-settings';
import type { SettingsGroup, SettingsScreenProps } from './types';

/* ---------- S3 Prompt ---------- */

export function PromptPicker({
  value,
  custom,
  onChange,
  onCustomChange,
}: {
  /** One of the built-in prompts, or 'custom'. */
  value: string;
  custom: string;
  onChange: (value: string) => void;
  onCustomChange: (value: string) => void;
}) {
  const options = [...BUILT_IN_PROMPTS, 'custom'].map((option, index) => ({
    value: option,
    label: option === 'custom' ? 'Write a custom prompt' : option,
    testID: option === 'custom' ? 'real-group-custom-prompt-choice' : `real-prompt-option-${index}`,
  }));
  return (
    <RadioList
      label="Prompt"
      onChange={onChange}
      options={options}
      style={styles.prompts}
      value={value}
    >
      {value === 'custom' ? (
        <TextInput
          accessibilityLabel="Custom prompt"
          maxLength={PROMPT_MAX_LENGTH}
          multiline
          onChangeText={onCustomChange}
          placeholder="Write a short prompt"
          placeholderTextColor="rgba(51, 35, 26, 0.5)"
          style={styles.custom}
          testID="real-group-custom-prompt"
          value={custom}
        />
      ) : null}
    </RadioList>
  );
}

const promptChoice = (prompt: string) =>
  (BUILT_IN_PROMPTS as readonly string[]).includes(prompt) ? prompt : 'custom';

export function PromptScreen<T extends SettingsGroup>({
  group,
  onBack,
  authenticatedRequest,
  onGroupUpdated,
}: SettingsScreenProps<T> & { group: T }) {
  const toast = useToast();
  const [choice, setChoice] = useState(promptChoice(group.cycle.prompt));
  const [custom, setCustom] = useState(
    promptChoice(group.cycle.prompt) === 'custom' ? group.cycle.prompt : '',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const prompt = (choice === 'custom' ? custom : choice).trim();
    if (!prompt) {
      setError('Write a prompt, or pick one above.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const updated = await saveGroupSettings(authenticatedRequest, group, {
        prompt,
        timeZone: group.group.timeZone ?? 'UTC',
      });
      onGroupUpdated(updated);
      toast('Saved.');
      onBack();
    } catch (failure) {
      setError(userMessage(failure, 'Settings could not be saved. Retry when connected.'));
      setPending(false);
    }
  };
  return (
    <ScreenScroll>
      <SubHeader onBack={onBack} title="Prompt" />
      <Lead>Everyone sees it on Home for this cycle.</Lead>
      <PromptPicker
        custom={custom}
        onChange={setChoice}
        onCustomChange={setCustom}
        value={choice}
      />
      <ErrorText>{error}</ErrorText>
      <Button
        busy={pending}
        busyLabel="Saving…"
        label="Save"
        onPress={() => void save()}
        testID="real-group-save-settings"
        variant="primary"
      />
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  prompts: { borderRadius: 22, paddingVertical: 4 },
  custom: {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderRadius: 12,
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 14,
    height: 64,
    marginBottom: 12,
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
});
