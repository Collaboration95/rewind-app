import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState, type ElementRef, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ArchiveScreen } from '../archive/ArchiveScreen';
import { useCapsule } from '../capsule/CapsuleProvider';
import {
  CameraCaptureScreen,
  DemoCameraPlatform,
  VideoCaptureScreen,
  type CameraPlatform,
} from '../capture';
import { ChatScreen } from '../chat/ChatScreen';
import { ChatUnreadProvider, useChatUnread } from '../chat/unread';
import { demoRepository, hydrateLocalDemoData, listLocalDemoGroups } from '../data/demo-repository';
import { localGroupStore } from '../data/local-group-store';
import type { DemoRevealState } from '../domain/cycles';
import {
  BUILT_IN_PROMPTS,
  GROUP_NAME_MAX_LENGTH,
  PROMPT_MAX_LENGTH,
  groupInputErrorMessage,
  validateGroupInput,
} from '../domain/groups';
import { isValidInviteCode, normalizeInviteCode } from '../domain/invites';
import type { CreateGroupInput } from '../domain/profiles';
import {
  revealStateForCycle,
  revealStateForPremiere,
  type RevealEducationState,
} from '../domain/reveal-education';
import {
  createInviteLink,
  inviteLinkErrorMessage,
  type InviteLinkParseResult,
} from '../invites/deep-links';
import { DemoProfilePicker } from '../profiles/DemoProfilePicker';
import { FilmScreen } from '../real/Film';
import { ReminderSettings } from '../reminders/ReminderSettings';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { RuntimeStatusCard } from '../runtime/RuntimeStatusCard';
import { useDemoSession } from '../session/DemoSessionProvider';
import { Avatar, Glass, Glow, ToastProvider, rw, useScreenInsets } from '../ui/primitives';
import { FONT, LAYOUT, WARM, serif } from '../ui/tokens';
import { createDemoArchiveClient } from './demo-archive-client';
import { DemoHome } from './DemoHome';
import { DemoMoments } from './DemoMoments';

import { ScreenFades, TabColumn } from '../real/Shell';
import { Icon } from '../ui/Icon';
import { SegmentRing } from '../ui/Ring';
const lockedMoments = [1, 2, 3];
type RouteKey = 'home' | 'camera' | 'chat' | 'archive' | 'settings';
type UnavailableRouteKey = 'chat';
type InviteLinkIntent = InviteLinkParseResult & { intentId: number };
const unavailableScreens = {
  chat: { title: 'Chat', description: 'Chat is not available in this area.' },
};
function SafeAreaFrame({ children }: { children: ReactNode }) {
  return (
    <View style={{ flex: 1, backgroundColor: WARM.bg }} testID="application-safe-area">
      <StatusBar style="dark" />
      <ToastProvider>{children}</ToastProvider>
    </View>
  );
}
export function DemoExperience({
  clock,
  inviteLink,
  runtimeClient,
  cameraPlatform,
}: {
  clock: () => number;
  inviteLink: InviteLinkIntent | null;
  runtimeClient: RuntimeClient | null;
  cameraPlatform?: CameraPlatform;
}) {
  const [activeRoute, setActiveRoute] = useState<
    RouteKey | 'create-group' | 'video' | 'moments' | 'film'
  >(() => (inviteLink ? 'settings' : 'home'));
  const insets = useScreenInsets();
  const { session } = useDemoSession();
  const [filmTarget, setFilmTarget] = useState<{ cycleId: string; label: string } | null>(null);
  const filmClient = useMemo(
    () => (runtimeClient && session ? createDemoArchiveClient(runtimeClient, session.id) : null),
    [runtimeClient, session],
  );
  const [routeOffset] = useState(() => new Animated.Value(0));
  const routeMounted = useRef(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [confirmResetDialogOpen, setConfirmResetDialogOpen] = useState(false);
  const previousRoute = useRef(activeRoute);
  const initialFocusPending = useRef(true);
  const { retry: refreshCapsule, state: capsuleState } = useCapsule();
  const navigate = (route: typeof activeRoute) => {
    // Moments reloads its own ledger after corrections. Refresh the capsule
    // only on departure so its successful-delete state survives until retake.
    if (activeRoute === 'moments' && route !== 'moments') refreshCapsule();
    setActiveRoute(route);
  };
  const chatGroup = 'group' in capsuleState ? capsuleState.group : null;
  const chatStreamEnabled = Boolean(session && chatGroup?.id === session.groupId);
  const unreadSession = capsuleState.status === 'denied' ? null : session;
  const cycleRevealState =
    capsuleState.status === 'ready' ? revealStateForCycle(capsuleState.cycle) : 'locked';
  const cycle = capsuleState.status === 'ready' ? capsuleState.cycle : null;
  const group = capsuleState.status === 'ready' ? capsuleState.group : null;
  const [premiereEducation, setPremiereEducation] = useState<{
    cycleId: string;
    state: RevealEducationState;
  } | null>(null);
  const revealState =
    runtimeClient?.getPremiere &&
    session &&
    cycle &&
    group &&
    premiereEducation?.cycleId === cycle.id
      ? premiereEducation.state
      : cycleRevealState;

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!routeMounted.current) {
      routeMounted.current = true;
      return;
    }
    if (reduceMotion) {
      routeOffset.setValue(0);
      return;
    }
    routeOffset.setValue(6);
    const animation = Animated.timing(routeOffset, {
      toValue: 0,
      duration: 160,
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [activeRoute, reduceMotion, routeOffset]);

  useEffect(() => {
    const shouldFocus = initialFocusPending.current || previousRoute.current !== activeRoute;
    previousRoute.current = activeRoute;
    initialFocusPending.current = false;
    if (Platform.OS !== 'web' || !shouldFocus) return;
    if (typeof document === 'undefined') return;
    const route = document.getElementById(`screen-route-${activeRoute}`);
    if (!route) return;
    const findHeading = () =>
      route.querySelector<HTMLElement>(`[data-testid="route-heading-${activeRoute}"]`) ??
      (activeRoute === 'home'
        ? document.querySelector<HTMLElement>('[data-testid="route-heading-home"]')
        : null);
    let focusedHeading = findHeading();
    if (focusedHeading) {
      focusedHeading.tabIndex = -1;
      focusedHeading.focus();
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const observer = new MutationObserver(() => {
      const heading = findHeading();
      if (!heading) return;
      if (!focusedHeading) {
        focusedHeading = heading;
        heading.tabIndex = -1;
        heading.focus();
        return;
      }
      if (
        heading !== focusedHeading &&
        !focusedHeading.isConnected &&
        document.activeElement === document.body
      ) {
        focusedHeading = heading;
        heading.tabIndex = -1;
        heading.focus();
        stopObserving();
      }
    });
    const stopObserving = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      document.removeEventListener('focusin', handleFocusIn);
      if (timeout) clearTimeout(timeout);
    };
    const handleFocusIn = (event: FocusEvent) => {
      // A loading route can temporarily return focus to body when its heading
      // is replaced. Keep observing that transition, but respect focus moving
      // to another interactive element.
      if (event.target !== focusedHeading && event.target !== document.body) stopObserving();
    };
    timeout = setTimeout(stopObserving, 5000);
    document.addEventListener('focusin', handleFocusIn);
    observer.observe(route, { childList: true, subtree: true });
    return stopObserving;
  }, [activeRoute]);

  useEffect(() => {
    const routeUsesRevealEducation =
      activeRoute === 'home' || activeRoute === 'camera' || activeRoute === 'archive';
    if (!routeUsesRevealEducation || !runtimeClient?.getPremiere || !session || !cycle || !group) {
      return;
    }

    let cancelled = false;
    void runtimeClient
      .getPremiere(session.id, group.id, cycle.id)
      .then((premiere) => {
        if (!cancelled) {
          setPremiereEducation({ cycleId: cycle.id, state: revealStateForPremiere(premiere) });
        }
      })
      .catch(() => {
        if (!cancelled) setPremiereEducation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRoute, cycle, group, runtimeClient, session]);
  const resolvedCameraPlatform = useMemo(() => {
    if (cameraPlatform) return cameraPlatform;
    if (typeof process !== 'undefined') {
      const cameraMode = process.env.EXPO_PUBLIC_CAMERA_MODE;
      if (cameraMode === 'demo') return new DemoCameraPlatform();
      if (cameraMode === 'demo-denied') {
        return new DemoCameraPlatform({
          permissions: { camera: 'denied', microphone: 'granted' },
        });
      }
    }
    return undefined;
  }, [cameraPlatform]);

  return (
    <ChatUnreadProvider
      activeGroupId={activeRoute === 'chat' ? (session?.groupId ?? null) : null}
      enabled={chatStreamEnabled}
      runtimeClient={runtimeClient}
      session={unreadSession}
    >
      <SafeAreaFrame>
        <TabColumn>
          <Glow />
          {activeRoute !== 'film' &&
            activeRoute !== 'camera' &&
            activeRoute !== 'video' &&
            activeRoute !== 'moments' && (
              <View nativeID="demo-header" style={[styles.demoTop, { paddingTop: insets.top }]}>
                <View style={{ width: 36 }} />
                <Text
                  accessibilityRole={activeRoute === 'home' ? 'header' : undefined}
                  testID={activeRoute === 'home' && group ? 'route-heading-home' : undefined}
                  style={styles.demoBrand}
                >
                  {activeRoute === 'home' || activeRoute === 'chat' || activeRoute === 'archive'
                    ? (group?.name ?? 'Rewind')
                    : 'Rewind'}
                </Text>
                <View accessibilityRole="tablist">
                  <Pressable
                    accessibilityLabel="Settings"
                    accessibilityRole="tab"
                    aria-selected={activeRoute === 'settings' || activeRoute === 'create-group'}
                    accessibilityState={{
                      selected: activeRoute === 'settings' || activeRoute === 'create-group',
                    }}
                    onPress={() => navigate('settings')}
                    style={styles.demoSettingsButton}
                    testID="nav-settings"
                  >
                    <Avatar glass name={session?.actor.displayName ?? 'Demo'} />
                  </Pressable>
                </View>
              </View>
            )}
          <Animated.View
            nativeID={`screen-route-${activeRoute}`}
            style={[styles.routeContent, { transform: [{ translateY: routeOffset }] }]}
          >
            {activeRoute === 'home' ? (
              <HomeScreen
                clock={clock}
                onAddMoment={() => navigate('camera')}
                onOpenMoments={() => navigate('moments')}
                onOpenArchive={() => navigate('archive')}
                revealState={revealState}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'film' && filmTarget && filmClient && group ? (
              <FilmScreen
                client={filmClient}
                request={async () => {
                  throw new Error('Reporting is unavailable in Demo.');
                }}
                groupId={group.id}
                cycleId={filmTarget.cycleId}
                label={filmTarget.label}
                isOwner={false}
                onClose={() => navigate('archive')}
                onChat={() => navigate('chat')}
              />
            ) : activeRoute === 'moments' ? (
              <DemoMoments
                key={`${session?.id}:${group?.id}:${cycle?.id}`}
                runtimeClient={runtimeClient}
                clock={clock}
                onBack={() => navigate('home')}
                onRetake={() => navigate('camera')}
                onReloadCapsule={refreshCapsule}
              />
            ) : activeRoute === 'settings' ? (
              <SettingsScreen
                confirmResetDialogOpen={confirmResetDialogOpen}
                onConfirmResetDialogOpenChange={setConfirmResetDialogOpen}
                onCreateGroup={() => navigate('create-group')}
                inviteLink={inviteLink}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'create-group' ? (
              <GroupCreateScreen
                onCancel={() => navigate('settings')}
                onCreated={() => navigate('home')}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'camera' ? (
              <CameraCaptureScreen
                onRecordClip={() => navigate('video')}
                onOpenArchive={() => navigate('archive')}
                revealState={revealState}
                platform={resolvedCameraPlatform}
              />
            ) : activeRoute === 'video' ? (
              <VideoCaptureScreen
                onBack={() => navigate('camera')}
                onContributionDeleted={refreshCapsule}
                platform={resolvedCameraPlatform}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'chat' ? (
              <ChatScreen runtimeClient={runtimeClient} />
            ) : activeRoute === 'archive' ? (
              <ArchiveScreen
                runtimeClient={runtimeClient}
                onOpenFilm={(cycleId, label) => {
                  setFilmTarget({ cycleId, label });
                  navigate('film');
                }}
              />
            ) : (
              <UnavailableScreen route={activeRoute as UnavailableRouteKey} />
            )}
          </Animated.View>
          {activeRoute !== 'film' && <ScreenFades />}
          {activeRoute !== 'film' && (
            <MainNavigation
              activeRoute={
                activeRoute === 'moments'
                  ? 'home'
                  : activeRoute === 'create-group'
                    ? 'settings'
                    : activeRoute === 'video'
                      ? 'camera'
                      : activeRoute
              }
              backgroundHidden={confirmResetDialogOpen}
              onNavigate={navigate}
            />
          )}
        </TabColumn>
      </SafeAreaFrame>
    </ChatUnreadProvider>
  );
}

function AppHeader() {
  return null;
}

function SettingsScreen({
  confirmResetDialogOpen: confirmOpen,
  onConfirmResetDialogOpenChange: setConfirmOpen,
  inviteLink,
  onCreateGroup,
  runtimeClient,
}: {
  confirmResetDialogOpen: boolean;
  onConfirmResetDialogOpenChange: (open: boolean) => void;
  inviteLink: InviteLinkIntent | null;
  onCreateGroup: () => void;
  runtimeClient: RuntimeClient | null;
}) {
  const { session, signOut, resetDemoData, pending, error } = useDemoSession();
  const { state } = useCapsule();
  const resetTriggerRef = useRef<ElementRef<typeof Pressable>>(null);
  const restoreResetTrigger = () => {
    if (Platform.OS !== 'web') return;
    setTimeout(() => (resetTriggerRef.current as unknown as HTMLElement | null)?.focus(), 0);
  };
  useEffect(() => {
    if (Platform.OS !== 'web' || !confirmOpen || typeof document === 'undefined') return;

    const background = [
      document.getElementById('settings-background'),
      document.getElementById('main-navigation'),
      document.getElementById('demo-header'),
    ].filter((element): element is HTMLElement => element instanceof HTMLElement);
    const priorInert = background.map((element) => element.inert);
    background.forEach((element) => {
      element.inert = true;
    });

    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Reset local Demo data confirmation"]',
    );
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

  return (
    <View style={styles.settingsScreen}>
      <ScrollView
        accessibilityElementsHidden={confirmOpen}
        aria-hidden={Platform.OS === 'web' ? confirmOpen : undefined}
        importantForAccessibility={confirmOpen ? 'no-hide-descendants' : 'auto'}
        contentContainerStyle={styles.content}
        nativeID="settings-background"
        style={styles.homeScroll}
      >
        <AppHeader />
        <View>
          <Text style={styles.label}>SETTINGS</Text>
          <Text
            accessibilityRole="header"
            nativeID="screen-heading-settings"
            style={styles.title}
            testID="route-heading-settings"
          >
            Settings
          </Text>
        </View>
        <Glass accessible style={styles.settingsPanel} testID="settings-identity">
          <Text style={styles.label}>CURRENT ACCESS</Text>
          <Text style={styles.panelTitle}>{session.actor.displayName}</Text>
          <Text style={styles.bodyText}>Synthetic member · Demo access</Text>
        </Glass>
        <DemoProfilePicker />
        <Glass accessible style={styles.settingsPanel} testID="settings-group">
          <Text style={styles.label}>CURRENT GROUP</Text>
          <Text style={styles.panelTitle}>{groupName}</Text>
          <Text style={styles.bodyText}>{role === 'owner' ? 'Owner' : 'Member'} · local group</Text>
        </Glass>
        <RuntimeStatusCard client={runtimeClient} />
        <ReminderSettings />
        <InvitePanel
          groupId={session.groupId}
          inviteLink={inviteLink}
          runtimeClient={runtimeClient}
        />
        <DemoRevealPanel groupId={session.groupId} runtimeClient={runtimeClient} />
        {error ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
        ) : null}
        <Pressable accessibilityRole="button" onPress={onCreateGroup} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Create a local group</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void signOut()}
          style={styles.outlineButton}
          testID="sign-out"
        >
          <Text style={styles.outlineButtonText}>
            {pending ? 'Ending Demo access…' : 'Sign out of Demo'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => setConfirmOpen(true)}
          ref={resetTriggerRef}
          style={styles.dangerButton}
          testID="reset-demo-data"
        >
          <Text style={styles.dangerButtonText}>Reset local Demo data</Text>
        </Pressable>
      </ScrollView>
      <Modal
        animationType="none"
        accessibilityLabel="Reset local Demo data confirmation"
        onRequestClose={() => {
          setConfirmOpen(false);
          restoreResetTrigger();
        }}
        transparent
        visible={confirmOpen}
      >
        <View accessible={false} style={styles.modalBackdrop} testID="reset-confirmation">
          <View style={styles.modalCard}>
            <Text accessibilityRole="header" style={[styles.dialogTitle, { color: WARM.ink }]}>
              Reset local Demo data?
            </Text>
            <ScrollView style={styles.dialogCopy}>
              <Text style={[styles.dialogBodyText, { color: WARM.ink }]}>
                This removes the saved Demo session, locally created groups, accepted still
                metadata, and app-owned cached camera files on this device. It restores the
                deterministic five-member fixture. Nothing remote or source-controlled is changed.
              </Text>
            </ScrollView>
            {error ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {error}
              </Text>
            ) : null}
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                disabled={pending}
                onPress={() => {
                  setConfirmOpen(false);
                  restoreResetTrigger();
                }}
                style={styles.dialogButton}
              >
                <Text style={[styles.dialogButtonText, { color: WARM.ink }]}>Keep local data</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={pending}
                onPress={async () => {
                  const reset = await resetDemoData();
                  if (reset) {
                    setConfirmOpen(false);
                    restoreResetTrigger();
                  }
                }}
                style={styles.dialogButton}
                testID="reset-confirm-action"
              >
                <Text style={[styles.dialogDangerButtonText, { color: WARM.ink }]}>
                  {pending ? 'Resetting local Demo data…' : 'Reset local Demo data'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function DemoRevealPanel({
  groupId,
  runtimeClient,
}: {
  groupId: string;
  runtimeClient: RuntimeClient | null;
}) {
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
    <Glass accessible={false} style={styles.settingsPanel} testID="settings-local-reveal">
      <Text style={styles.label}>LOCAL REVEAL CONTROL</Text>
      <Text style={styles.bodyText}>{status}</Text>
      {reveal?.state !== 'released' ? (
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void progress()}
          style={styles.primaryButton}
          testID="progress-local-reveal"
        >
          <Text style={styles.primaryButtonText}>{pending ? 'Progressing…' : actionLabel}</Text>
        </Pressable>
      ) : null}
      {feedback ? (
        <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.bodyText}>
          {feedback}
        </Text>
      ) : null}
    </Glass>
  );
}

function InvitePanel({
  groupId,
  inviteLink,
  runtimeClient,
}: {
  groupId: string;
  inviteLink: InviteLinkIntent | null;
  runtimeClient: RuntimeClient | null;
}) {
  const { session, updateGroup } = useDemoSession();
  const { state, retry } = useCapsule();
  const [invite, setInvite] = useState<Awaited<
    ReturnType<NonNullable<RuntimeClient['createInvite']>>
  > | null>(null);
  const initialLinkedCode = inviteLink?.kind === 'valid' ? inviteLink.code : null;
  const initialLinkedExpiry = inviteLink?.kind === 'valid' ? inviteLink.expiresAt : null;
  const initialFeedback = inviteLink
    ? inviteLink.kind === 'valid'
      ? 'Invite link ready. Review it below and accept the invitation.'
      : inviteLinkErrorMessage(inviteLink.reason)
    : null;
  const [code, setCode] = useState(initialLinkedCode ?? '');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(initialFeedback);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [linkedCode, setLinkedCode] = useState<string | null>(initialLinkedCode);
  const [linkedExpiry, setLinkedExpiry] = useState<string | null>(initialLinkedExpiry);
  const owner = state.group?.actingMemberRole === 'owner';

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
        message: `Join my Rewind group with this invitation link: ${inviteLinkUrl}`,
        url: inviteLinkUrl,
      });
      setFeedback('Invitation link ready to share.');
    } catch {
      setFeedback('Share is unavailable here; copy the invitation link to share it locally.');
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

  const accept = async () => {
    const normalizedCode = normalizeInviteCode(code);
    if (!isValidInviteCode(normalizedCode)) {
      setCodeError('Enter the eight-character invite code using letters and numbers.');
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
      setFeedback(`Joined ${result.group.name}. The code is now used.`);
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : 'The invitation code could not be accepted.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Glass accessible={false} style={styles.settingsPanel} testID="settings-invites">
      <Text style={styles.label}>LOCAL INVITATIONS</Text>
      {owner ? (
        <>
          <Text style={styles.bodyText}>
            Generate one bounded code for this group. It expires in 24 hours or after one use.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => void generate()}
            style={styles.primaryButton}
            testID="generate-invite"
          >
            <Text style={styles.primaryButtonText}>
              {pending ? 'Generating…' : 'Generate invite code'}
            </Text>
          </Pressable>
          {invite ? (
            <>
              <Text accessibilityLabel={`Invite code ${invite.code}`} style={styles.inviteCode}>
                {invite.code}
              </Text>
              <Text style={styles.bodyText}>
                Expires {new Date(invite.expiresAt).toLocaleString()} · Active
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void copy()}
                style={styles.outlineButton}
              >
                <Text style={styles.outlineButtonText}>Copy invite code</Text>
              </Pressable>
              {inviteLinkUrl ? (
                <>
                  <Text selectable style={styles.inviteLink} testID="invite-link">
                    {inviteLinkUrl}
                  </Text>
                  {Platform.OS === 'web' ? (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void copyLink()}
                        style={styles.outlineButton}
                        testID="copy-invite-link"
                      >
                        <Text style={styles.outlineButtonText}>Copy invite link</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={openLink}
                        style={styles.outlineButton}
                        testID="open-invite-link"
                      >
                        <Text style={styles.outlineButtonText}>Open invite link</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void shareLink()}
                      style={styles.primaryButton}
                      testID="share-invite-link"
                    >
                      <Text style={styles.primaryButtonText}>Share invite link</Text>
                    </Pressable>
                  )}
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      <Text style={styles.fieldLabel}>Have an invite?</Text>
      <TextInput
        accessibilityLabel="Invite code"
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
        placeholder="8-character code"
        placeholderTextColor={WARM.muted}
        style={styles.textInput}
        testID="invite-code-input"
        value={code}
      />
      <Pressable
        accessibilityRole="button"
        disabled={pending || code.length === 0}
        onPress={() => void accept()}
        style={styles.outlineButton}
        testID="accept-invite"
      >
        <Text style={styles.outlineButtonText}>Accept invitation</Text>
      </Pressable>
      {codeError ? (
        <Text
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
          nativeID="invite-code-error"
          style={styles.fieldError}
          testID="invite-code-error"
        >
          {codeError}
        </Text>
      ) : null}
      {feedback ? (
        <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.bodyText}>
          {feedback}
        </Text>
      ) : null}
    </Glass>
  );
}

function GroupCreateScreen({
  onCancel,
  onCreated,
  runtimeClient,
}: {
  onCancel: () => void;
  onCreated: () => void;
  runtimeClient: RuntimeClient | null;
}) {
  const { session, updateGroup } = useDemoSession();
  const { retry } = useCapsule();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState<string>(BUILT_IN_PROMPTS[0]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<'name' | 'prompt', string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!session) return null;

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
          : 'The local group could not be created. Retry when ready.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.homeScroll}>
      <AppHeader />
      <View>
        <Text style={styles.label}>NEW LOCAL GROUP</Text>
        <Text accessibilityRole="header" style={styles.title} testID="route-heading-create-group">
          Create a group
        </Text>
        <Text style={styles.bodyText}>
          You will be the owner. The first collection cycle lasts one day.
        </Text>
      </View>
      {formError ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {formError}
        </Text>
      ) : null}
      <View style={styles.formPanel}>
        <Text style={styles.fieldLabel}>Group name</Text>
        <TextInput
          accessibilityLabel="Group name"
          aria-invalid={Boolean(errors.name)}
          maxLength={GROUP_NAME_MAX_LENGTH + 1}
          onChangeText={(value) => {
            setName(value);
            if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
          }}
          placeholder="e.g. Saturday table"
          placeholderTextColor={WARM.muted}
          style={styles.textInput}
          testID="group-name-input"
          value={name}
        />
        <Text style={styles.counter}>
          {name.length}/{GROUP_NAME_MAX_LENGTH}
        </Text>
        {errors.name ? (
          <Text accessibilityRole="alert" style={styles.fieldError}>
            {errors.name}
          </Text>
        ) : null}
      </View>
      <View style={styles.formPanel}>
        <Text style={styles.fieldLabel}>Prompt</Text>
        {BUILT_IN_PROMPTS.map((builtIn) => {
          const selected = !useCustomPrompt && prompt === builtIn;
          return (
            <Pressable
              accessibilityLabel={builtIn}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              key={builtIn}
              onPress={() => {
                setPrompt(builtIn);
                setUseCustomPrompt(false);
              }}
              style={[styles.promptChoice, selected && styles.promptChoiceSelected]}
            >
              <Text style={[styles.bodyText, styles.promptChoiceText]}>{builtIn}</Text>
              <Text style={styles.radioState}>{selected ? 'Selected' : 'Choose'}</Text>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityLabel="Write a custom prompt"
          accessibilityRole="radio"
          accessibilityState={{ selected: useCustomPrompt }}
          onPress={() => setUseCustomPrompt(true)}
          style={[styles.promptChoice, useCustomPrompt && styles.promptChoiceSelected]}
        >
          <Text style={[styles.bodyText, styles.promptChoiceText]}>Write a custom prompt</Text>
          <Text style={styles.radioState}>{useCustomPrompt ? 'Selected' : 'Choose'}</Text>
        </Pressable>
        {useCustomPrompt ? (
          <>
            <TextInput
              accessibilityLabel="Custom prompt"
              aria-invalid={Boolean(errors.prompt)}
              multiline
              maxLength={PROMPT_MAX_LENGTH + 1}
              onChangeText={(value) => {
                setCustomPrompt(value);
                if (errors.prompt) setErrors((current) => ({ ...current, prompt: undefined }));
              }}
              placeholder="Write a short prompt"
              placeholderTextColor={WARM.muted}
              style={[styles.textInput, styles.promptInput]}
              testID="custom-prompt-input"
              value={customPrompt}
            />
            <Text style={styles.counter}>
              {customPrompt.length}/{PROMPT_MAX_LENGTH}
            </Text>
          </>
        ) : null}
        {errors.prompt ? (
          <Text accessibilityRole="alert" style={styles.fieldError}>
            {errors.prompt}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={pending}
        onPress={() => void submit()}
        style={styles.primaryButton}
        testID="create-group-submit"
      >
        <Text style={styles.primaryButtonText}>
          {pending ? 'Creating group…' : 'Create local group'}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={pending}
        onPress={onCancel}
        style={styles.outlineButton}
      >
        <Text style={styles.outlineButtonText}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}

function HomeScreen({
  clock,
  onAddMoment,
  onOpenMoments,
  onOpenArchive,
  revealState,
  runtimeClient,
}: {
  clock: () => number;
  onAddMoment: () => void;
  onOpenMoments: () => void;
  onOpenArchive: () => void;
  revealState: RevealEducationState;
  runtimeClient: RuntimeClient | null;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      style={styles.homeScroll}
      tabIndex={Platform.OS === 'web' ? 0 : undefined}
      testID="home-scroll"
    >
      <AppHeader />

      <DemoHome
        clock={clock}
        runtimeClient={runtimeClient}
        onAddMoment={onAddMoment}
        onOpenMoments={onOpenMoments}
        onOpenArchive={onOpenArchive}
        revealState={revealState}
      />

      <View style={styles.section}>
        <Text style={styles.label}>SEALED MOMENTS</Text>
        <View accessibilityLabel="Three sealed moments" style={styles.momentRow}>
          {lockedMoments.map((moment) => (
            <View
              accessible
              accessibilityLabel={`Locked moment ${moment} of 3`}
              key={moment}
              style={styles.momentPlaceholder}
            >
              <Text style={styles.lockedText}>LOCKED</Text>
            </View>
          ))}
        </View>
      </View>

      <Glass style={styles.settingsPanel}>
        <Text style={styles.bodyText}>
          Demo · synthetic members. Camera capture stays local until submitted to the Demo runtime.
        </Text>
      </Glass>
      <Text style={styles.helperText} testID="home-content-end">
        Camera capture stays local. Choose a capture type on the Camera screen.
      </Text>
    </ScrollView>
  );
}

function UnavailableScreen({ route }: { route: UnavailableRouteKey }) {
  const screen = unavailableScreens[route];

  return (
    <View style={styles.unavailableScreen}>
      <AppHeader />
      <View>
        <Text style={styles.label}>{screen.title.toUpperCase()}</Text>
        <Text accessibilityRole="header" style={styles.title} testID={`route-heading-${route}`}>
          {screen.title}
        </Text>
      </View>
      <View
        accessible
        accessibilityLabel={`${screen.title} unavailable status`}
        style={styles.unavailablePanel}
      >
        <Text style={styles.panelTitle}>Not available yet</Text>
        <Text style={styles.bodyText}>{screen.description}</Text>
      </View>
    </View>
  );
}

function MainNavigation({
  activeRoute,
  backgroundHidden,
  onNavigate,
}: {
  activeRoute: RouteKey;
  backgroundHidden: boolean;
  onNavigate: (route: RouteKey) => void;
}) {
  const { unreadCount } = useChatUnread();
  const { state } = useCapsule();
  const cycle = state.status === 'ready' ? state.cycle : null;
  return (
    <View
      accessibilityElementsHidden={backgroundHidden}
      aria-hidden={Platform.OS === 'web' ? backgroundHidden : undefined}
      accessibilityRole="tablist"
      importantForAccessibility={backgroundHidden ? 'no-hide-descendants' : 'auto'}
      nativeID="main-navigation"
      style={styles.navigation}
      testID="main-navigation"
    >
      <Glass style={styles.demoTabs}>
        {(['home', 'chat', 'archive'] as const).map((key) => {
          const selected = activeRoute === key;
          const label = key === 'home' ? 'Home' : key === 'chat' ? 'Chat' : 'Archive';
          return (
            <Pressable
              key={key}
              accessibilityHint={`Shows the ${label} area`}
              accessibilityLabel={
                key === 'chat' && unreadCount > 0
                  ? `Chat, ${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}`
                  : label
              }
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              aria-selected={selected}
              aria-current={selected ? 'page' : undefined}
              onPress={() => onNavigate(key)}
              style={[styles.tab, selected && styles.selectedTab]}
              testID={`nav-${key}`}
              {...(selected ? rw('lens') : {})}
            >
              <View>
                <Icon
                  color={selected ? WARM.ink : WARM.muted}
                  name={key === 'home' ? 'home' : key === 'chat' ? 'chat' : 'archive'}
                  size={20}
                />
                {key === 'chat' && unreadCount > 0 ? (
                  <Text style={styles.unreadBadge} testID="chat-unread-badge">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </Text>
                ) : null}
              </View>
              <Text style={[styles.tabLabel, selected && styles.selectedTabLabel]}>{label}</Text>
            </Pressable>
          );
        })}
      </Glass>
      <Pressable
        accessibilityLabel="Camera"
        accessibilityHint="Add a photo or video moment"
        accessibilityRole="tab"
        accessibilityState={{ selected: activeRoute === 'camera' }}
        aria-selected={activeRoute === 'camera'}
        onPress={() => onNavigate('camera')}
        style={styles.demoShutter}
        testID="nav-camera"
        {...rw('shutter')}
      >
        <SegmentRing
          used={cycle?.contributionUsage.countUsed ?? 0}
          total={cycle?.quota.maxCount ?? 5}
        />
        <View style={styles.demoCore} {...rw('shutter-core')}>
          <Icon name="camera" color={WARM.peachInk} size={24} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  demoTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: LAYOUT.gutter,
    minHeight: 56,
    zIndex: 8,
  },
  demoBrand: { color: WARM.ink, ...serif(22), flex: 1, textAlign: 'center' },
  demoSettingsButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
    minHeight: 44,
  },
  demoShutter: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WARM.peachSoft,
    borderRadius: 38,
    width: 76,
    height: 76,
  },
  content: {
    flexGrow: 1,
    gap: 18,
    padding: 24,
    paddingBottom: 32,
  },
  homeScroll: {
    flex: 1,
  },
  label: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  title: { color: WARM.ink, ...serif(30) },
  panelTitle: {
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 22,
    fontWeight: '700',
  },
  bodyText: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 14,
  },
  section: {
    gap: 8,
  },
  momentRow: {
    flexDirection: 'row',
    gap: 8,
  },
  momentPlaceholder: {
    alignItems: 'center',
    minHeight: 44,
    backgroundColor: WARM.sheet,
    borderColor: WARM.line,
    borderRadius: 6,

    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
  },
  lockedText: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 10,
    fontWeight: '700',
  },
  helperText: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 12,
    marginTop: -12,
    textAlign: 'center',
  },
  dialogBodyText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 14, lineHeight: 21 },
  dialogCopy: { maxHeight: 180 },
  dialogTitle: { color: WARM.ink, fontFamily: FONT.body, fontSize: 22, fontWeight: '700' },
  dialogButtonText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 15, fontWeight: '700' },
  dialogDangerButtonText: {
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 15,
    fontWeight: '700',
  },
  dialogButton: {
    alignItems: 'center',
    backgroundColor: WARM.sheet,
    borderColor: WARM.dangerInk,
    borderRadius: 24,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  unavailableScreen: {
    flex: 1,
    gap: 24,
    padding: 24,
  },
  unavailablePanel: {
    backgroundColor: WARM.sheet,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    gap: 10,
    padding: 20,
  },
  navigation: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    height: 76,
    marginHorizontal: 16,
    marginBottom: 16,
    zIndex: 7,
  },
  demoTabs: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 32,
    height: 64,
    padding: 6,
  },
  demoCore: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: WARM.peachSoft,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 4,
    height: 52,
    borderRadius: 26,
    gap: 3,
  },
  selectedTab: {
    backgroundColor: WARM.sheet,
    borderRadius: 26,
  },
  tabLabel: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 10.5,
    fontWeight: '500',
  },
  selectedTabLabel: {
    color: WARM.ink,
  },
  unreadBadge: {
    backgroundColor: WARM.dangerInk,
    borderRadius: 24,
    color: WARM.sheet,
    fontFamily: FONT.body,
    fontSize: 11,
    fontWeight: '800',
    position: 'absolute',
    left: 11,
    top: -8,
    minWidth: 20,
    overflow: 'hidden',
    paddingHorizontal: 5,
    textAlign: 'center',
  },
  routeContent: { flex: 1, minHeight: 0 },
  settingsScreen: { flex: 1 },
  errorText: { color: WARM.dangerInk, fontFamily: FONT.body, fontSize: 14, lineHeight: 21 },
  settingsPanel: {
    backgroundColor: WARM.sheet,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    gap: 7,
    padding: 16,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: WARM.peachSoft,
    borderRadius: 24,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: WARM.peachInk,
    fontFamily: FONT.body,
    fontSize: 15,
    fontWeight: '800',
  },
  inviteCode: {
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 4,
    paddingVertical: 8,
  },
  inviteLink: { color: WARM.muted, fontFamily: FONT.body, fontSize: 12, lineHeight: 18 },
  outlineButton: {
    alignItems: 'center',
    backgroundColor: WARM.sheet,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  outlineButtonText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 15, fontWeight: '700' },
  dangerButton: {
    alignItems: 'center',
    backgroundColor: WARM.sheet,
    borderColor: WARM.dangerInk,
    borderRadius: 24,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  dangerButtonText: {
    color: WARM.dangerInk,
    fontFamily: FONT.body,
    fontSize: 15,
    fontWeight: '700',
  },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(51, 35, 26, 0.35)',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: WARM.bg,
    borderColor: WARM.line,
    borderRadius: 28,
    borderWidth: 1,
    gap: 14,
    maxWidth: 360,
    padding: 20,
    width: '100%',
  },
  modalActions: { gap: 10 },
  formPanel: {
    backgroundColor: WARM.sheet,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  fieldLabel: { color: WARM.ink, fontFamily: FONT.body, fontSize: 15, fontWeight: '700' },
  textInput: {
    backgroundColor: WARM.bg,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  promptInput: { minHeight: 96, textAlignVertical: 'top' },
  counter: { color: WARM.muted, fontFamily: FONT.body, fontSize: 12, textAlign: 'right' },
  fieldError: { color: WARM.dangerInk, fontFamily: FONT.body, fontSize: 13, lineHeight: 19 },
  promptChoice: {
    alignItems: 'center',
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  promptChoiceText: { flex: 1, flexShrink: 1 },
  promptChoiceSelected: { backgroundColor: WARM.sheet, borderColor: WARM.dangerInk },
  radioState: { color: WARM.dangerInk, fontFamily: FONT.body, fontSize: 12, fontWeight: '700' },
});
