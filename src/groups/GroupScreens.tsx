import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useCapsule } from '../capsule/CapsuleProvider';
import { demoRepository, hydrateLocalDemoData, listLocalDemoGroups } from '../data/demo-repository';
import { localGroupStore } from '../data/local-group-store';
import {
  BUILT_IN_PROMPTS,
  GROUP_NAME_MAX_LENGTH,
  PROMPT_MAX_LENGTH,
  groupInputErrorMessage,
  validateGroupInput,
} from '../domain/groups';
import { isValidInviteCode, normalizeInviteCode } from '../domain/invites';
import type { CreateGroupInput } from '../domain/profiles';
import { useI18n } from '../i18n/LanguageProvider';
import {
  createInviteLink,
  inviteLinkErrorMessage,
  type InviteLinkParseResult,
} from '../invites/deep-links';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { useDemoSession } from '../session/DemoSessionProvider';
import { COLORS } from '../theme';
import {
  ActionButton,
  ButtonRow,
  Eyebrow,
  InlineError,
  Micro,
  Notice,
  ScreenIntro,
  kitStyles,
} from '../ui/kit';

export type InviteLinkIntent = InviteLinkParseResult & { intentId: number };
export type GroupDebugScenario = 'error' | 'loading';

export function GroupCreateScreen({
  debugScenario = null,
  onCancel,
  onCreated,
  runtimeClient,
}: {
  debugScenario?: GroupDebugScenario | null;
  onCancel: () => void;
  onCreated: () => void;
  runtimeClient: RuntimeClient | null;
}) {
  const { t } = useI18n();
  const { session, updateGroup } = useDemoSession();
  const { retry } = useCapsule();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState<string>(BUILT_IN_PROMPTS[0]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<'name' | 'prompt', string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingState, setPending] = useState(false);
  if (!session) return null;
  const pending = pendingState || debugScenario === 'loading';
  const shownFormError =
    formError ?? (debugScenario === 'error' ? t('Save failed. Your draft is kept.') : null);

  const selectedPrompt = useCustomPrompt ? customPrompt : prompt;
  const input: CreateGroupInput = { name, prompt: selectedPrompt };
  const submit = async () => {
    const validation = validateGroupInput(input);
    if (validation.name || validation.prompt) {
      setErrors({
        ...(validation.name ? { name: groupInputErrorMessage('name', validation.name) } : {}),
        ...(validation.prompt
          ? { prompt: groupInputErrorMessage('prompt', validation.prompt) }
          : {}),
      });
      return;
    }
    setErrors({});
    if (debugScenario === 'error') {
      setFormError(t('Save failed. Your draft is kept.'));
      return;
    }
    setFormError(null);
    setPending(true);
    try {
      const localSnapshot = listLocalDemoGroups();
      const result = runtimeClient?.createGroup
        ? await runtimeClient.createGroup(session.id, input)
        : await demoRepository.createGroup(session.actor.memberId, input);
      if (!result.ok) {
        setErrors({
          [result.field === 'owner' ? 'name' : result.field]: groupInputErrorMessage(
            result.field === 'owner' ? 'name' : result.field,
            result.reason,
          ),
        });
        return;
      }
      if (!runtimeClient?.createGroup) {
        try {
          await localGroupStore.save(listLocalDemoGroups());
        } catch (storageError) {
          hydrateLocalDemoData(localSnapshot);
          throw storageError;
        }
      }
      try {
        await updateGroup(result.group.id);
      } catch {
        // Runtime creation is already committed. The provider keeps the
        // in-memory pointer reconciled even if its local persistence fails,
        // so this must not be presented as a failed/duplicable creation.
      }
      retry();
      onCreated();
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : t('The local group could not be created. Retry when ready.'),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={kitStyles.content}
      keyboardShouldPersistTaps="handled"
      style={kitStyles.scroll}
    >
      <ScreenIntro
        body={t('You become owner. The first cycle lasts one day.')}
        eyebrow={t('NEW LOCAL GROUP')}
        headingTestID="route-heading-create-group"
        title={t('Create a group')}
      />
      {shownFormError ? <InlineError>{shownFormError}</InlineError> : null}
      <View style={styles.formPanel}>
        <Text nativeID="group-name-label" style={styles.fieldLabel}>
          {t('Group name')}
        </Text>
        <TextInput
          accessibilityLabel={t('Group name')}
          aria-invalid={Boolean(errors.name)}
          maxLength={GROUP_NAME_MAX_LENGTH + 1}
          onChangeText={(value) => {
            setName(value);
            if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
          }}
          placeholder={t('e.g. Saturday table')}
          placeholderTextColor={COLORS.muted}
          style={styles.textInput}
          testID="group-name-input"
          value={name}
        />
        <View style={styles.helpRow}>
          <Micro>{t('Required · up to 80 characters')}</Micro>
          <Text style={styles.counter}>
            {name.length}/{GROUP_NAME_MAX_LENGTH}
          </Text>
        </View>
        {errors.name ? (
          <Text accessibilityRole="alert" style={styles.fieldError}>
            {t(errors.name)}
          </Text>
        ) : null}
      </View>
      <View accessibilityRole="radiogroup" style={styles.formPanel}>
        <Text style={styles.fieldLabel}>{t('Prompt')}</Text>
        {BUILT_IN_PROMPTS.map((builtIn) => {
          const selected = !useCustomPrompt && prompt === builtIn;
          return (
            <PromptChoice
              key={builtIn}
              label={t(builtIn)}
              onPress={() => {
                setPrompt(builtIn);
                setUseCustomPrompt(false);
              }}
              selected={selected}
            />
          );
        })}
        <PromptChoice
          label={t('Write a custom prompt')}
          onPress={() => setUseCustomPrompt(true)}
          selected={useCustomPrompt}
        />
        {useCustomPrompt ? (
          <>
            <TextInput
              accessibilityLabel={t('Custom prompt')}
              aria-invalid={Boolean(errors.prompt)}
              multiline
              maxLength={PROMPT_MAX_LENGTH + 1}
              onChangeText={(value) => {
                setCustomPrompt(value);
                if (errors.prompt) setErrors((current) => ({ ...current, prompt: undefined }));
              }}
              placeholder={t('Write a short prompt')}
              placeholderTextColor={COLORS.muted}
              style={[styles.textInput, styles.promptInput]}
              testID="custom-prompt-input"
              value={customPrompt}
            />
            <View style={styles.helpRow}>
              <Micro>{t('Required · up to 160 characters')}</Micro>
              <Text style={styles.counter}>
                {customPrompt.length}/{PROMPT_MAX_LENGTH}
              </Text>
            </View>
          </>
        ) : null}
        {errors.prompt ? (
          <Text accessibilityRole="alert" style={styles.fieldError}>
            {t(errors.prompt)}
          </Text>
        ) : null}
      </View>
      <ActionButton
        busy={pending}
        full
        label={pending ? t('Creating…') : t('Create local group')}
        onPress={submit}
        testID="create-group-submit"
        variant="primary"
      />
      <ActionButton disabled={pending} full label={t('Cancel')} onPress={onCancel} />
    </ScrollView>
  );
}

function PromptChoice({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      aria-checked={selected}
      onPress={onPress}
      style={[styles.promptChoice, selected && styles.promptChoiceSelected]}
    >
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <Text style={styles.promptChoiceText}>{label}</Text>
    </Pressable>
  );
}

export type JoinDebugScenario = 'error' | 'loading';

/** Accepts a bounded, one-use invitation for the active Demo member. */
export function JoinGroupScreen({
  debugScenario = null,
  inviteLink,
  onCancel,
  onJoined,
  runtimeClient,
}: {
  debugScenario?: JoinDebugScenario | null;
  inviteLink: InviteLinkIntent | null;
  onCancel: () => void;
  onJoined?: () => void;
  runtimeClient: RuntimeClient | null;
}) {
  const { t } = useI18n();
  const { session, updateGroup } = useDemoSession();
  const { retry, state: capsuleState } = useCapsule();
  const currentGroupName = capsuleState.group?.name ?? null;
  const initialLinkedCode = inviteLink?.kind === 'valid' ? inviteLink.code : null;
  const initialLinkedExpiry = inviteLink?.kind === 'valid' ? inviteLink.expiresAt : null;
  const initialFeedback = inviteLink
    ? inviteLink.kind === 'valid'
      ? 'Invite link ready. Review it below and accept the invitation.'
      : inviteLinkErrorMessage(inviteLink.reason)
    : null;
  const [code, setCode] = useState(initialLinkedCode ?? '');
  const [pendingState, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(initialFeedback);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [linkedCode, setLinkedCode] = useState<string | null>(initialLinkedCode);
  const [linkedExpiry, setLinkedExpiry] = useState<string | null>(initialLinkedExpiry);
  const pending = pendingState || debugScenario === 'loading';
  const forcedError = debugScenario === 'error' ? t('Invalid, expired or used invite.') : null;

  const accept = async () => {
    const normalizedCode = normalizeInviteCode(code);
    if (!isValidInviteCode(normalizedCode)) {
      setCodeError('Enter the eight-character invite code using letters and numbers.');
      setFeedback(null);
      return;
    }
    if (debugScenario === 'error') {
      setFeedback(null);
      return;
    }
    if (linkedCode === normalizedCode && linkedExpiry && Date.parse(linkedExpiry) <= Date.now()) {
      setCode('');
      setLinkedCode(null);
      setLinkedExpiry(null);
      setFeedback(inviteLinkErrorMessage('expired'));
      return;
    }
    if (!runtimeClient?.acceptInvite || !session) {
      setFeedback('Connect the local runtime to accept an invitation code.');
      return;
    }
    setPending(true);
    setCodeError(null);
    setFeedback(null);
    try {
      // The invite determines its destination group. Passing the current
      // group here would reject a valid invite from another group.
      const result = await runtimeClient.acceptInvite(session.id, normalizedCode);
      await updateGroup(result.session.groupId);
      retry();
      setCode('');
      setLinkedCode(null);
      setLinkedExpiry(null);
      setFeedback(t('Joined {group}. The code is now used.', { group: result.group.name }));
      onJoined?.();
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : 'The invitation code could not be accepted.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={kitStyles.content}
      keyboardShouldPersistTaps="handled"
      style={kitStyles.scroll}
      testID="settings-invites"
    >
      <ScreenIntro
        body={t('One-use invite; expires in 24 hours.')}
        eyebrow={t('LOCAL INVITATION')}
        headingTestID="route-heading-join"
        title={t('Join a group')}
      />
      {currentGroupName ? (
        <Micro testID="join-current-group">
          {t('Current group: {group}', { group: currentGroupName })}
        </Micro>
      ) : null}
      <View style={styles.formPanel}>
        <Text style={styles.fieldLabel}>{t('Invite code')}</Text>
        <TextInput
          accessibilityLabel={t('Invite code')}
          autoCapitalize="characters"
          aria-describedby={codeError ? 'invite-code-error' : undefined}
          aria-invalid={Boolean(codeError)}
          maxLength={32}
          onChangeText={(value) => {
            setCode(normalizeInviteCode(value));
            setLinkedCode(null);
            setLinkedExpiry(null);
            setCodeError(null);
            setFeedback(null);
          }}
          placeholder={t('8-character code')}
          placeholderTextColor={COLORS.muted}
          style={styles.textInput}
          testID="invite-code-input"
          value={code}
        />
        <Micro>{t('Ask the group owner for an eight-character code.')}</Micro>
        {codeError ? (
          <Text
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            nativeID="invite-code-error"
            style={styles.fieldError}
            testID="invite-code-error"
          >
            {t(codeError)}
          </Text>
        ) : null}
      </View>
      {forcedError ? <InlineError>{forcedError}</InlineError> : null}
      {feedback ? <Notice>{t(feedback)}</Notice> : null}
      <ButtonRow>
        <ActionButton
          busy={pending}
          disabled={code.length === 0}
          label={pending ? t('Joining…') : t('Accept invitation')}
          onPress={accept}
          testID="accept-invite"
          variant="primary"
        />
        <ActionButton disabled={pending} label={t('Cancel')} onPress={onCancel} />
      </ButtonRow>
    </ScrollView>
  );
}

/** Owner-only invitation generation, shown inside Settings. */
export function InviteGeneratePanel({
  groupId,
  runtimeClient,
}: {
  groupId: string;
  runtimeClient: RuntimeClient | null;
}) {
  const { t } = useI18n();
  const { session } = useDemoSession();
  const [invite, setInvite] = useState<Awaited<
    ReturnType<NonNullable<RuntimeClient['createInvite']>>
  > | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const generate = async () => {
    if (!runtimeClient?.createInvite || !session) {
      setFeedback('Connect the local runtime to generate an invitation code.');
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      setInvite(await runtimeClient.createInvite(session.id, groupId));
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : 'The invitation code could not be created.',
      );
    } finally {
      setPending(false);
    }
  };

  const webOrigin =
    Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : undefined;
  const inviteLinkUrl = invite
    ? createInviteLink(invite, {
        platform: Platform.OS === 'web' ? 'web' : 'native',
        webOrigin,
      })
    : null;

  const copy = async () => {
    if (!invite) return;
    try {
      await Clipboard.setStringAsync(invite.code);
      setFeedback('Invitation code copied.');
    } catch {
      setFeedback('Copy is unavailable here; select the code to share it locally.');
    }
  };

  const copyLink = async () => {
    if (!inviteLinkUrl) return;
    try {
      await Clipboard.setStringAsync(inviteLinkUrl);
      setFeedback('Invitation link copied.');
    } catch {
      setFeedback('Copy is unavailable here; use Share or select the invite link locally.');
    }
  };

  const openLink = () => {
    if (!inviteLinkUrl || typeof window === 'undefined') {
      setFeedback('The invitation link could not be opened here. Copy it to open elsewhere.');
      return;
    }
    const opened = window.open(inviteLinkUrl, '_blank', 'noopener,noreferrer');
    setFeedback(
      opened
        ? 'Invitation link opened in a new tab.'
        : 'The invitation link was blocked. Copy it to open elsewhere.',
    );
  };

  const shareLink = async () => {
    if (!inviteLinkUrl) {
      setFeedback('The invitation link could not be prepared. Use the invite code instead.');
      return;
    }
    try {
      await Share.share({
        message: t('Join my Rewind group with this invitation link: {link}', {
          link: inviteLinkUrl,
        }),
        url: inviteLinkUrl,
      });
      setFeedback('Invitation link ready to share.');
    } catch {
      setFeedback('Share is unavailable here; copy the invitation link to share it locally.');
    }
  };

  return (
    <View accessible={false} style={styles.invite} testID="settings-invite-generate">
      <Eyebrow>{t('LOCAL INVITATIONS')}</Eyebrow>
      <Text style={styles.body}>{t('One code for this group. 24 hours or one use.')}</Text>
      <ActionButton
        busy={pending}
        label={pending ? t('Generating…') : t('Generate invite code')}
        onPress={generate}
        testID="generate-invite"
      />
      {invite ? (
        <>
          <Text
            accessibilityLabel={t('Invite code {code}', { code: invite.code })}
            selectable
            style={styles.inviteCode}
          >
            {invite.code}
          </Text>
          <Text style={styles.body}>
            {t('Expires {time} · Active', { time: new Date(invite.expiresAt).toLocaleString() })}
          </Text>
          <ActionButton label={t('Copy invite code')} onPress={copy} />
          {inviteLinkUrl ? (
            <>
              <Text selectable style={styles.inviteLink} testID="invite-link">
                {inviteLinkUrl}
              </Text>
              {Platform.OS === 'web' ? (
                <ButtonRow>
                  <ActionButton
                    label={t('Copy invite link')}
                    onPress={copyLink}
                    testID="copy-invite-link"
                  />
                  <ActionButton
                    label={t('Open invite link')}
                    onPress={openLink}
                    testID="open-invite-link"
                  />
                </ButtonRow>
              ) : (
                <ActionButton
                  label={t('Share invite link')}
                  onPress={shareLink}
                  testID="share-invite-link"
                  variant="primary"
                />
              )}
            </>
          ) : null}
        </>
      ) : null}
      {feedback ? (
        <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.body}>
          {t(feedback)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  formPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 9,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  fieldLabel: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  textInput: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    color: COLORS.ink,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  promptInput: { minHeight: 96, textAlignVertical: 'top' },
  helpRow: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  counter: { color: COLORS.muted, fontSize: 12 },
  fieldError: { color: COLORS.accent, fontSize: 13, lineHeight: 19 },
  promptChoice: {
    alignItems: 'center',
    borderColor: COLORS.line,
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  promptChoiceSelected: { backgroundColor: COLORS.deep, borderColor: COLORS.accent },
  promptChoiceText: { color: COLORS.ink, flex: 1, flexShrink: 1, fontSize: 14, lineHeight: 20 },
  radio: {
    alignItems: 'center',
    borderColor: COLORS.muted,
    borderRadius: 9,
    borderWidth: 1.5,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  radioSelected: { borderColor: COLORS.accent },
  radioDot: { backgroundColor: COLORS.accent, borderRadius: 4, height: 8, width: 8 },
  invite: {
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    gap: 10,
    marginTop: 4,
    paddingTop: 14,
  },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  inviteCode: {
    color: COLORS.ink,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 4,
    paddingVertical: 4,
  },
  inviteLink: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
});
