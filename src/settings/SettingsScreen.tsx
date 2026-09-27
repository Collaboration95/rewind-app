import { useEffect, useRef, useState, type ElementRef } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useCapsule } from '../capsule/CapsuleProvider';
import { useDebug } from '../debug/DebugProvider';
import type { DemoRevealState } from '../domain/cycles';
import { InviteGeneratePanel } from '../groups/GroupScreens';
import { useI18n, type Language } from '../i18n/LanguageProvider';
import { DemoProfilePicker } from '../profiles/DemoProfilePicker';
import { ReminderSettings } from '../reminders/ReminderSettings';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { RuntimeStatusCard } from '../runtime/RuntimeStatusCard';
import { useDemoSession } from '../session/DemoSessionProvider';
import { COLORS } from '../theme';
import {
  ActionButton,
  ButtonRow,
  Eyebrow,
  InlineError,
  Micro,
  Notice,
  Panel,
  ScreenIntro,
  kitStyles,
} from '../ui/kit';

export type SettingsDebugScenario = 'error' | 'loading';

export function SettingsScreen({
  confirmResetDialogOpen: confirmOpen,
  debugScenario = null,
  onConfirmResetDialogOpenChange: setConfirmOpen,
  onCreateGroup,
  onJoinGroup,
  runtimeClient,
}: {
  confirmResetDialogOpen: boolean;
  debugScenario?: SettingsDebugScenario | null;
  onConfirmResetDialogOpenChange: (open: boolean) => void;
  onCreateGroup: () => void;
  onJoinGroup: () => void;
  runtimeClient: RuntimeClient | null;
}) {
  const { t } = useI18n();
  const { session, signOut, resetDemoData, pending: sessionPending, error } = useDemoSession();
  const { state } = useCapsule();
  const [forcedNoticeState, setForcedNoticeState] = useState<{
    scenario: SettingsDebugScenario | null;
    text: string;
  } | null>(null);
  // A debug notice belongs to the state that produced it.
  const forcedNotice =
    forcedNoticeState && forcedNoticeState.scenario === debugScenario
      ? forcedNoticeState.text
      : null;
  const setForcedNotice = (text: string | null) =>
    setForcedNoticeState(text ? { scenario: debugScenario, text } : null);
  const resetTriggerRef = useRef<ElementRef<typeof Pressable>>(null);
  const pending = sessionPending || debugScenario === 'loading';
  const restoreResetTrigger = () => {
    if (Platform.OS !== 'web') return;
    setTimeout(() => (resetTriggerRef.current as unknown as HTMLElement | null)?.focus(), 0);
  };
  useEffect(() => {
    if (Platform.OS !== 'web' || !confirmOpen || typeof document === 'undefined') return;

    const background = [
      document.getElementById('settings-background'),
      document.getElementById('main-navigation'),
    ].filter((element): element is HTMLElement => element instanceof HTMLElement);
    const priorInert = background.map((element) => element.inert);
    background.forEach((element) => {
      element.inert = true;
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="button"], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog) return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapTab, true);
    focusable()[0]?.focus();

    return () => {
      document.removeEventListener('keydown', trapTab, true);
      background.forEach((element, index) => {
        element.inert = priorInert[index] ?? false;
      });
    };
  }, [confirmOpen]);
  if (!session) return null;
  const groupName = state.group?.name ?? session.groupId;
  const role = state.group?.actingMemberRole ?? 'member';
  const shownError =
    error ?? (debugScenario === 'error' ? t('Operation failed. Demo data unchanged.') : null);

  const confirmReset = async () => {
    if (debugScenario === 'error') {
      setForcedNotice(t('Reset failed. Local Demo data was kept.'));
      return;
    }
    const reset = await resetDemoData();
    if (reset) {
      setConfirmOpen(false);
      restoreResetTrigger();
    }
  };

  return (
    <View style={styles.settingsScreen}>
      <ScrollView
        accessibilityElementsHidden={confirmOpen}
        aria-hidden={Platform.OS === 'web' ? confirmOpen : undefined}
        importantForAccessibility={confirmOpen ? 'no-hide-descendants' : 'auto'}
        contentContainerStyle={kitStyles.content}
        nativeID="settings-background"
        style={kitStyles.scroll}
      >
        <ScreenIntro
          body={t('Member, group and device settings.')}
          eyebrow={t('SETTINGS')}
          headingTestID="route-heading-settings"
          title={t('Your Demo.')}
        />

        <Panel eyebrow={t('CURRENT ACCESS')} testID="settings-identity">
          <View accessible>
            <Text style={styles.panelTitle}>{session.actor.displayName}</Text>
            <Text style={styles.body}>{t('Synthetic member · Demo access')}</Text>
          </View>
          <View accessible style={styles.divided} testID="settings-group">
            <Eyebrow>{t('CURRENT GROUP')}</Eyebrow>
            <Text style={styles.groupName}>{groupName}</Text>
            <Text style={styles.body}>
              {role === 'owner' ? t('Owner · local group') : t('Member · local group')}
            </Text>
          </View>
        </Panel>

        <DemoProfilePicker />

        <Panel
          body={t('Create a group or accept an invite.')}
          eyebrow={t('LOCAL GROUP')}
          testID="settings-local-group"
        >
          <ButtonRow>
            <ActionButton label={t('Create a local group')} onPress={onCreateGroup} />
            <ActionButton
              label={t('Have an invite?')}
              onPress={onJoinGroup}
              testID="open-join-group"
            />
          </ButtonRow>
          {role === 'owner' ? (
            <InviteGeneratePanel groupId={session.groupId} runtimeClient={runtimeClient} />
          ) : null}
        </Panel>

        <ReminderSettings />
        <DemoRevealPanel groupId={session.groupId} runtimeClient={runtimeClient} />
        <RuntimeStatusCard client={runtimeClient} />
        <DisplayAndDeveloperPanel />

        <Eyebrow>{t('DEMO DATA')}</Eyebrow>
        {shownError ? <InlineError>{shownError}</InlineError> : null}
        {forcedNotice && !confirmOpen ? <Notice>{forcedNotice}</Notice> : null}
        <ActionButton
          busy={pending}
          full
          label={pending ? t('Signing out…') : t('Sign out of Demo')}
          onPress={() => {
            if (debugScenario === 'error') {
              setForcedNotice(t('Sign-out failed; access unchanged.'));
              return;
            }
            void signOut();
          }}
          testID="sign-out"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: pending }}
          disabled={pending}
          onPress={() => setConfirmOpen(true)}
          ref={resetTriggerRef}
          style={[styles.dangerButton, pending && styles.disabled]}
          testID="reset-demo-data"
        >
          <Text style={styles.dangerButtonText}>{t('Reset local Demo data')}</Text>
        </Pressable>
        <Micro>
          {t(
            'Reset clears the Demo session, local groups, saved selection and app-owned still cache on this device.',
          )}
        </Micro>
      </ScrollView>
      <Modal
        animationType="none"
        accessibilityLabel={t('Reset local Demo data confirmation')}
        onRequestClose={() => {
          setConfirmOpen(false);
          restoreResetTrigger();
        }}
        transparent
        visible={confirmOpen}
      >
        <View accessible={false} style={styles.modalBackdrop} testID="reset-confirmation">
          <View style={styles.modalCard}>
            <Text accessibilityRole="header" style={styles.dialogTitle}>
              {t('Reset local Demo data?')}
            </Text>
            <ScrollView style={styles.dialogCopy}>
              <Text style={styles.dialogBodyText}>
                {t(
                  'This removes the saved Demo session, locally created groups, accepted still metadata, and app-owned cached camera files on this device. It restores the deterministic five-member fixture. Nothing remote or source-controlled is changed.',
                )}
              </Text>
            </ScrollView>
            {error ? <InlineError>{error}</InlineError> : null}
            {forcedNotice ? <InlineError>{forcedNotice}</InlineError> : null}
            <View style={styles.modalActions}>
              <ActionButton
                disabled={pending}
                full
                label={t('Keep local data')}
                onPress={() => {
                  setConfirmOpen(false);
                  setForcedNotice(null);
                  restoreResetTrigger();
                }}
              />
              <ActionButton
                disabled={pending}
                full
                label={pending ? t('Resetting local Demo data…') : t('Reset local Demo data')}
                onPress={confirmReset}
                testID="reset-confirm-action"
                variant="danger"
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function DisplayAndDeveloperPanel() {
  const { language, setLanguage, t } = useI18n();
  const { enabled, openSheet, setEnabled } = useDebug();
  const languages: { key: Language; label: string }[] = [
    { key: 'en', label: 'English' },
    { key: 'zh', label: '中文' },
  ];
  return (
    <Panel eyebrow={t('DISPLAY & DEVELOPER')} testID="settings-developer">
      <Text style={styles.fieldLabel}>{t('Language / 语言')}</Text>
      <View accessibilityRole="radiogroup" style={styles.segment}>
        {languages.map((option) => {
          const selected = option.key === language;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, selected }}
              aria-checked={selected}
              key={option.key}
              onPress={() => setLanguage(option.key)}
              style={[styles.segmentOption, selected && styles.segmentSelected]}
              testID={`language-${option.key}`}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={[styles.switchRow, styles.divided]}>
        <View style={styles.switchText}>
          <Text nativeID="debug-mode-label" style={styles.fieldLabel}>
            {t('Debug mode')}
          </Text>
          <Text style={styles.body}>
            {t(
              'Shows a DEBUG chip in the header. Tap it on any screen to force loading, empty, denied, error, sealed and released states.',
            )}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={t('Debug mode')}
          accessibilityRole="switch"
          accessibilityState={{ checked: enabled }}
          aria-checked={enabled}
          hitSlop={8}
          onPress={() => setEnabled(!enabled)}
          style={[styles.toggle, enabled && styles.toggleOn]}
          testID="debug-mode-switch"
        >
          <View style={[styles.knob, enabled && styles.knobOn]} />
        </Pressable>
      </View>
      {enabled ? (
        <ActionButton
          label={t('Open state picker')}
          onPress={() => openSheet('settings')}
          testID="debug-open-sheet"
        />
      ) : null}
    </Panel>
  );
}

function DemoRevealPanel({
  groupId,
  runtimeClient,
}: {
  groupId: string;
  runtimeClient: RuntimeClient | null;
}) {
  const { t } = useI18n();
  const { session } = useDemoSession();
  const { state, retry } = useCapsule();
  const [reveal, setReveal] = useState<DemoRevealState | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const owner = state.group?.actingMemberRole === 'owner';
  const revealDemoCycle = runtimeClient?.revealDemoCycle;

  if (!owner || !session || !runtimeClient || !revealDemoCycle) return null;

  const progress = async () => {
    setPending(true);
    setFeedback(null);
    try {
      if (!reveal || reveal.state === 'collecting') {
        const advanced = await runtimeClient.advanceDemoCycle(
          groupId,
          session.actor.memberId,
          24 * 60 * 60,
          session.id,
        );
        if ('kind' in advanced) {
          throw new Error('The local Demo cycle could not be advanced for reveal.');
        }
      }
      const next = await revealDemoCycle.call(runtimeClient, session.id, groupId);
      setReveal(next);
      retry();
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : 'The local reveal could not be progressed.',
      );
    } finally {
      setPending(false);
    }
  };

  const actionLabel =
    reveal?.state === 'compiling'
      ? 'Compile and release'
      : reveal?.state === 'delayed'
        ? 'Retry compilation'
        : reveal?.state === 'collecting'
          ? 'Check local reveal'
          : 'Start local reveal';
  const status =
    reveal?.state === 'compiling'
      ? 'A durable film job is ready to compile. Playback remains locked until release.'
      : reveal?.state === 'delayed'
        ? 'The film is delayed. No player or download has been published.'
        : reveal?.state === 'released'
          ? 'The film is released. Open Archive to view the published result.'
          : reveal?.state === 'collecting'
            ? 'The collection window is still open. Media remains sealed.'
            : 'This owner-only local Demo control advances the Demo clock, then uses the normal cycle, compilation, and release gates.';

  return (
    <Panel eyebrow={t('LOCAL REVEAL CONTROL')} testID="settings-local-reveal">
      <Text style={styles.body}>{t(status)}</Text>
      {reveal?.state !== 'released' ? (
        <ActionButton
          busy={pending}
          label={pending ? t('Progressing…') : t(actionLabel)}
          onPress={progress}
          testID="progress-local-reveal"
          variant="primary"
        />
      ) : null}
      {feedback ? (
        <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.body}>
          {t(feedback)}
        </Text>
      ) : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  settingsScreen: { flex: 1 },
  panelTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700' },
  groupName: { color: COLORS.ink, fontSize: 16, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  fieldLabel: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  divided: { borderTopColor: COLORS.line, borderTopWidth: 1, gap: 4, paddingTop: 12 },
  segment: { flexDirection: 'row', gap: 8 },
  segmentOption: {
    alignItems: 'center',
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
  },
  segmentSelected: { backgroundColor: COLORS.deep, borderColor: COLORS.accent },
  segmentText: { color: COLORS.muted, fontSize: 14, fontWeight: '600' },
  segmentTextSelected: { color: COLORS.ink, fontWeight: '800' },
  switchRow: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  toggle: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.line,
    borderRadius: 16,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    paddingHorizontal: 3,
    width: 54,
  },
  toggleOn: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  knob: { backgroundColor: COLORS.muted, borderRadius: 12, height: 24, width: 24 },
  knobOn: { alignSelf: 'flex-end', backgroundColor: COLORS.accentInk },
  switchText: { flex: 1, gap: 4 },
  dangerButton: {
    alignItems: 'center',
    borderColor: COLORS.accent,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  dangerButtonText: { color: COLORS.accent, fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(29, 27, 30, 0.96)',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.line,
    borderRadius: 12,
    borderWidth: 1,
    gap: 14,
    maxWidth: 360,
    padding: 20,
    width: '100%',
  },
  modalActions: { gap: 10 },
  dialogTitle: { color: COLORS.ink, fontSize: 21, fontWeight: '700' },
  dialogBodyText: { color: COLORS.ink, fontSize: 14, lineHeight: 21 },
  dialogCopy: { maxHeight: 180 },
});
