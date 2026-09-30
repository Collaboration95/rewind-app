import { useEffect, useMemo, useRef, useState, type ElementRef, type ReactNode } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import {
  AccessibilityInfo,
  Animated,
  Linking,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { DemoProfilePicker } from './src/profiles/DemoProfilePicker';
import { DemoProfileProvider } from './src/profiles/DemoProfileProvider';
import { CapsuleProvider, useCapsule } from './src/capsule/CapsuleProvider';
import { CapsuleSummary } from './src/capsule/CapsuleSummary';
import { ContributionLedgerSection } from './src/contributions/ContributionLedgerSection';
import type { CycleRepository, DemoRevealState } from './src/domain/cycles';
import {
  revealStateForCycle,
  revealStateForPremiere,
  type RevealEducationState,
} from './src/domain/reveal-education';
import type {
  AsyncGroupRepository,
  CreateGroupInput,
  GroupRepository,
} from './src/domain/profiles';
import { COLORS } from './src/theme';
import {
  createConfiguredRuntime,
  getConfiguredInviteWebOrigin,
  isDemoAccessEnabled,
} from './src/runtime/config';
import type { RuntimeClient } from './src/runtime/local-runtime-client';
import { createRuntimeRepositories } from './src/runtime/runtime-repositories';
import { RuntimeStatusCard } from './src/runtime/RuntimeStatusCard';
import { DemoSessionProvider, useDemoSession } from './src/session/DemoSessionProvider';
import type { DemoSessionStore } from './src/domain/session';
import {
  CameraCaptureScreen,
  ContributionStatusProvider,
  DemoCameraPlatform,
  VideoCaptureScreen,
  type CameraPlatform,
} from './src/capture';
import {
  demoRepository,
  hydrateLocalDemoData,
  listLocalDemoGroups,
} from './src/data/demo-repository';
import { localGroupStore } from './src/data/local-group-store';
import {
  BUILT_IN_PROMPTS,
  GROUP_NAME_MAX_LENGTH,
  PROMPT_MAX_LENGTH,
  groupInputErrorMessage,
  validateGroupInput,
} from './src/domain/groups';
import { isValidInviteCode, normalizeInviteCode } from './src/domain/invites';
import {
  createInviteLink,
  inviteLinkErrorMessage,
  isInviteLinkCandidate,
  parseInviteLink,
  type InviteLinkParseResult,
} from './src/invites/deep-links';
import { ChatScreen } from './src/chat/ChatScreen';
import { ChatUnreadProvider, useChatUnread } from './src/chat/unread';
import { ArchiveScreen } from './src/archive/ArchiveScreen';
import { ReminderSettings } from './src/reminders/ReminderSettings';
import { RealAccountProvider, useRealAccount } from './src/auth/RealAccountProvider';
import { RealAccountGroupExperience } from './src/groups/RealAccountGroupExperience';

const lockedMoments = [1, 2, 3];
const COLD_LAUNCH_MINIMUM_MS = 600;

function interactionFeedback({ pressed }: { pressed: boolean }) {
  return [pressed && styles.pressedControl];
}

const ROUTES = [
  { key: 'home', label: 'Home' },
  { key: 'camera', label: 'Camera' },
  { key: 'chat', label: 'Chat' },
  { key: 'archive', label: 'Archive' },
  { key: 'settings', label: 'Settings' },
] as const;

type RouteKey = (typeof ROUTES)[number]['key'];
type UnavailableRouteKey = Exclude<RouteKey, 'home' | 'settings' | 'camera' | 'archive'>;
type InviteLinkIntent = InviteLinkParseResult & { intentId: number };

const unavailableScreens: Record<UnavailableRouteKey, { description: string; title: string }> = {
  chat: {
    description: 'Chat is not available in this area.',
    title: 'Chat',
  },
};

export interface AppProps {
  clock?: () => number;
  cycleRepository?: CycleRepository;
  groupRepository?: GroupRepository | AsyncGroupRepository;
  runtimeClient?: RuntimeClient | null;
  /** Inject a deterministic fixture platform for simulator evidence/tests. */
  cameraPlatform?: CameraPlatform;
  /** Session persistence adapter for deterministic restoration and entry flows. */
  sessionStore?: DemoSessionStore;
}

export default function App({
  clock = Date.now,
  cycleRepository,
  groupRepository,
  runtimeClient,
  cameraPlatform,
  sessionStore,
}: AppProps = {}) {
  const inviteLink = useInviteLinkIntent();
  const configuredRuntime = useMemo(
    () =>
      runtimeClient === undefined
        ? createConfiguredRuntime()
        : runtimeClient
          ? { baseUrl: runtimeClient.baseUrl, client: runtimeClient }
          : null,
    [runtimeClient],
  );
  return (
    <SafeAreaProvider>
      <RealAccountProvider baseUrl={configuredRuntime?.baseUrl ?? null}>
        <DemoSessionProvider
          runtimeClient={configuredRuntime?.client ?? null}
          {...(sessionStore ? { store: sessionStore } : {})}
        >
          <DemoProfileProvider>
            <SessionGate
              clock={clock}
              cycleRepository={cycleRepository}
              groupRepository={groupRepository}
              inviteLink={inviteLink}
              runtimeClient={configuredRuntime?.client ?? null}
              cameraPlatform={cameraPlatform}
            />
          </DemoProfileProvider>
        </DemoSessionProvider>
      </RealAccountProvider>
    </SafeAreaProvider>
  );
}

function useInviteLinkIntent(): InviteLinkIntent | null {
  const [inviteLink, setInviteLink] = useState<InviteLinkIntent | null>(null);
  const intentSequence = useRef(0);

  useEffect(() => {
    let mounted = true;
    const receive = (url: string | null) => {
      if (!mounted || !url || !isInviteLinkCandidate(url)) return;
      const parsed = parseInviteLink(url);
      if (parsed.kind === 'valid' || parsed.reason === 'expired' || parsed.reason === 'malformed') {
        setInviteLink({ ...parsed, intentId: ++intentSequence.current });
      }
    };

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      receive(window.location.href);
      return () => {
        mounted = false;
      };
    }

    void Linking.getInitialURL()
      .then(receive)
      .catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => receive(url));
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return inviteLink;
}

function SessionGate({
  clock,
  cycleRepository,
  groupRepository,
  inviteLink,
  runtimeClient,
  cameraPlatform,
}: {
  clock: () => number;
  cycleRepository?: CycleRepository;
  groupRepository?: GroupRepository | AsyncGroupRepository;
  inviteLink: InviteLinkIntent | null;
  runtimeClient: RuntimeClient | null;
  cameraPlatform?: CameraPlatform;
}) {
  const { status, session } = useDemoSession();
  const realAccount = useRealAccount();
  const [coldLaunchMinimumElapsed, setColdLaunchMinimumElapsed] = useState(false);
  useEffect(() => {
    // SessionGate stays mounted while the app is backgrounded, so this minimum
    // applies to process startup and does not delay a warm foreground resume.
    const timeout = setTimeout(() => setColdLaunchMinimumElapsed(true), COLD_LAUNCH_MINIMUM_MS);
    return () => clearTimeout(timeout);
  }, []);
  const sessionRepositories = useMemo(
    () => (runtimeClient && session ? createRuntimeRepositories(runtimeClient, session.id) : null),
    [runtimeClient, session],
  );
  if (!coldLaunchMinimumElapsed || realAccount.state === 'loading' || status === 'loading') {
    return <SessionLoadingScreen />;
  }
  if (realAccount.state === 'active' && realAccount.session)
    return (
      <SafeAreaFrame>
        <RealAccountGroupExperience
          displayName={realAccount.session.account.displayName}
          inviteIntent={
            inviteLink?.kind === 'valid' && typeof inviteLink.groupId === 'string'
              ? {
                  code: inviteLink.code,
                  expiresAt: inviteLink.expiresAt,
                  groupId: inviteLink.groupId,
                }
              : null
          }
          inviteWebOrigin={
            Platform.OS === 'web' && typeof window !== 'undefined'
              ? window.location.origin
              : (getConfiguredInviteWebOrigin() ?? undefined)
          }
        />
      </SafeAreaFrame>
    );
  if (inviteLink?.kind === 'valid' && inviteLink.groupId)
    return <DemoAccessEntry key={inviteLink.intentId} inviteGroupId={inviteLink.groupId} />;
  if (realAccount.state === 'error') return <DemoAccessEntry />;
  if (status === 'entry' || status === 'error' || !session) return <DemoAccessEntry />;
  return (
    <ContributionStatusProvider
      scope={{
        groupId: session.groupId,
        memberId: session.actor.memberId,
        sessionId: session.id,
      }}
    >
      <CapsuleProvider
        groupRepository={groupRepository ?? sessionRepositories?.groupRepository}
        cycleRepository={cycleRepository ?? sessionRepositories?.cycleRepository}
      >
        <ActiveAppShell
          key={inviteLinkKey(inviteLink)}
          cameraPlatform={cameraPlatform}
          clock={clock}
          inviteLink={inviteLink}
          runtimeClient={runtimeClient}
        />
      </CapsuleProvider>
    </ContributionStatusProvider>
  );
}

function inviteLinkKey(inviteLink: InviteLinkIntent | null): string {
  if (!inviteLink) return 'no-invite-link';
  return `invite-link-intent-${inviteLink.intentId}`;
}

function SessionLoadingScreen() {
  return (
    <SafeAreaFrame>
      <View style={styles.entryContent}>
        <View
          accessibilityLabel="Rewind"
          accessibilityRole="progressbar"
          style={styles.loadingBrand}
        >
          <Image
            accessibilityLabel="Rewind mark"
            source={require('./public/icons/rewind-icon-192.png')}
            style={styles.brandMark}
          />
          <Text style={styles.loadingWordmark}>REWIND</Text>
          <Text style={styles.loadingTagline}>PRIVATE MOMENTS, SHARED TOGETHER</Text>
        </View>
      </View>
    </SafeAreaFrame>
  );
}

function SafeAreaFrame({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  return (
    <>
      <StatusBar hidden style="light" />
      <SafeAreaView
        edges={['top', 'right', 'bottom', 'left']}
        style={styles.page}
        testID="application-safe-area"
      >
        <View style={[styles.screen, width >= 900 && styles.wideScreen]}>{children}</View>
      </SafeAreaView>
    </>
  );
}

function ActiveAppShell({
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
  const [activeRoute, setActiveRoute] = useState<RouteKey | 'create-group' | 'video'>(() =>
    inviteLink ? 'settings' : 'home',
  );
  const [routeOffset] = useState(() => new Animated.Value(0));
  const routeMounted = useRef(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [confirmResetDialogOpen, setConfirmResetDialogOpen] = useState(false);
  const previousRoute = useRef(activeRoute);
  const initialFocusPending = useRef(true);
  const { retry: refreshCapsule, state: capsuleState } = useCapsule();
  const { session } = useDemoSession();
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
      route.querySelector<HTMLElement>(`[data-testid="route-heading-${activeRoute}"]`);
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
        <View style={styles.activeShell}>
          <Animated.View
            nativeID={`screen-route-${activeRoute}`}
            style={[styles.routeContent, { transform: [{ translateY: routeOffset }] }]}
          >
            {activeRoute === 'home' ? (
              <HomeScreen
                clock={clock}
                ledgerScope={
                  session && group && cycle
                    ? {
                        sessionId: session.id,
                        groupId: group.id,
                        memberId: session.actor.memberId,
                        cycleId: cycle.id,
                      }
                    : null
                }
                onAddMoment={() => setActiveRoute('camera')}
                onOpenArchive={() => setActiveRoute('archive')}
                revealState={revealState}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'settings' ? (
              <SettingsScreen
                confirmResetDialogOpen={confirmResetDialogOpen}
                onConfirmResetDialogOpenChange={setConfirmResetDialogOpen}
                onCreateGroup={() => setActiveRoute('create-group')}
                inviteLink={inviteLink}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'create-group' ? (
              <GroupCreateScreen
                onCancel={() => setActiveRoute('settings')}
                onCreated={() => setActiveRoute('home')}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'camera' ? (
              <CameraCaptureScreen
                onRecordClip={() => setActiveRoute('video')}
                onOpenArchive={() => setActiveRoute('archive')}
                revealState={revealState}
                platform={resolvedCameraPlatform}
              />
            ) : activeRoute === 'video' ? (
              <VideoCaptureScreen
                onBack={() => setActiveRoute('camera')}
                onContributionDeleted={refreshCapsule}
                platform={resolvedCameraPlatform}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'chat' ? (
              <ChatScreen runtimeClient={runtimeClient} />
            ) : activeRoute === 'archive' ? (
              <ArchiveScreen runtimeClient={runtimeClient} />
            ) : (
              <UnavailableScreen route={activeRoute as UnavailableRouteKey} />
            )}
          </Animated.View>
          <MainNavigation
            activeRoute={
              activeRoute === 'create-group'
                ? 'settings'
                : activeRoute === 'video'
                  ? 'camera'
                  : activeRoute
            }
            backgroundHidden={confirmResetDialogOpen}
            onNavigate={setActiveRoute}
          />
        </View>
      </SafeAreaFrame>
    </ChatUnreadProvider>
  );
}

function AppHeader() {
  return (
    <View style={styles.topBar}>
      <View style={styles.brandLockup}>
        <Image
          accessibilityLabel="Rewind mark"
          source={require('./public/icons/rewind-icon-192.png')}
          style={styles.headerMark}
        />
        <Text style={styles.wordmark}>REWIND</Text>
      </View>
    </View>
  );
}

function DemoAccessEntry({ inviteGroupId }: { inviteGroupId?: string }) {
  const { profiles, chooseMember, error, entryReason, pending, retryRestore } = useDemoSession();
  const auth = useRealAccount();
  const [entryOffset] = useState(() => new Animated.Value(0));
  const entryModeMounted = useRef(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [mode, setMode] = useState<'welcome' | 'demo' | 'sign-in' | 'create-account'>(
    inviteGroupId ? 'sign-in' : 'welcome',
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const registrationPasswordRef = useRef<ElementRef<typeof TextInput>>(null);
  const registrationConfirmationRef = useRef<ElementRef<typeof TextInput>>(null);
  const [authPending, setAuthPending] = useState(false);
  const [registrationComplete, setRegistrationComplete] = useState(false);
  const [registrationError, setRegistrationError] = useState<
    'invalid' | 'duplicate' | 'rate-limited' | 'unavailable' | 'password-mismatch' | null
  >(null);
  const [selectedDemoMemberId, setSelectedDemoMemberId] = useState<string | null>(null);
  const visibleMode = mode;
  const demoAccessEnabled = isDemoAccessEnabled();
  const canRetryDemoStart = visibleMode === 'demo' && selectedDemoMemberId !== null;

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
    if (!entryModeMounted.current) {
      entryModeMounted.current = true;
      return;
    }
    if (reduceMotion) {
      entryOffset.setValue(0);
      return;
    }
    entryOffset.setValue(6);
    const animation = Animated.timing(entryOffset, {
      toValue: 0,
      duration: 160,
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [entryOffset, reduceMotion, visibleMode]);

  const authMessage =
    auth.notice === 'expired'
      ? 'Your session expired or an administrator reset your password. Sign in again to continue.'
      : auth.notice === 'revoked'
        ? 'Your account session was reset by an administrator. Sign in again to continue.'
        : auth.notice === 'sign-in-failed'
          ? 'Sign-in failed. Check your username and password, or try again later.'
          : auth.notice === 'offline'
            ? 'The sign-in service could not be reached. Please try again shortly.'
            : auth.notice === 'revocation-unconfirmed'
              ? Platform.OS === 'web'
                ? 'We could not confirm sign-out. You are still signed in on this browser; try again when the service is reachable.'
                : 'Signed out on this device. The server did not confirm revocation; another device may remain signed in until the session expires or an administrator resets it.'
              : auth.notice === 'local-credential-removal-failed'
                ? 'The server says this session has ended, but this device could not confirm deletion of its saved sign-in. The credential may remain in SecureStore; retry local cleanup before treating this device as signed out.'
                : auth.notice === 'sign-out-incomplete'
                  ? 'Sign-out is incomplete: this device could not confirm deletion of its saved sign-in, and the server did not confirm revocation. The credential may remain and you may still be signed in. Retry sign out.'
                  : auth.notice === 'sign-out-recovery-pending'
                    ? 'Sign-out recovery is pending. This device will not restore a saved sign-in automatically until recovery finishes. Server revocation may still be unconfirmed.'
                    : auth.notice === 'sign-out-marker-unavailable'
                      ? auth.state === 'active'
                        ? 'Sign-out did not start because this device could not save its recovery state. You are still signed in. Retry sign out.'
                        : 'This device could not verify sign-out recovery state, so the saved sign-in was not restored. Retry sign out to recover safely.'
                      : auth.notice === 'sign-out-marker-cleanup-failed'
                        ? 'The server confirmed sign-out and this device deleted its saved sign-in, but it could not clear the recovery marker. Account restore stays blocked on this device until cleanup is retried.'
                        : null;

  const submitSignIn = async () => {
    setAuthPending(true);
    await auth.signIn(username.trim(), password);
    setAuthPending(false);
    setPassword('');
  };

  const submitRegistration = async () => {
    if (
      authPending ||
      registrationComplete ||
      !username.trim() ||
      !password ||
      !passwordConfirmation ||
      !auth.secureTransportAvailable
    ) {
      return;
    }
    setRegistrationError(null);
    if (password !== passwordConfirmation) {
      setRegistrationError('password-mismatch');
      return;
    }
    setAuthPending(true);
    const outcome = await auth.registerAccount(username.trim(), password);
    setAuthPending(false);
    if (outcome === 'created') {
      setPassword('');
      setPasswordConfirmation('');
      setRegistrationComplete(true);
      return;
    }
    setRegistrationError(outcome);
  };

  const startDemo = (memberId: string) => {
    setSelectedDemoMemberId(memberId);
    void chooseMember(memberId);
  };

  const registrationMessage = registrationComplete
    ? inviteGroupId
      ? 'Your account is ready. Sign in to accept the invitation.'
      : 'Your account is ready. Sign in to continue.'
    : registrationError === 'password-mismatch'
      ? 'Passwords do not match.'
      : registrationError === 'duplicate'
        ? 'That username is already in use. Try another.'
        : registrationError === 'invalid'
          ? 'Choose a valid username and a stronger password, then try again.'
          : registrationError === 'rate-limited'
            ? 'Too many account attempts. Wait a moment before trying again.'
            : registrationError === 'unavailable'
              ? 'Account creation is unavailable right now. Please try again shortly.'
              : null;

  return (
    <SafeAreaFrame>
      <Animated.ScrollView
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        contentContainerStyle={styles.entryContent}
        keyboardShouldPersistTaps="handled"
        style={{ transform: [{ translateY: entryOffset }] }}
        testID="entry-mode-content"
      >
        <View style={styles.entryBrand}>
          <View style={styles.brandLockup}>
            <Image
              accessibilityLabel="Rewind mark"
              source={require('./public/icons/rewind-icon-192.png')}
              style={styles.headerMark}
            />
            <Text style={styles.wordmark}>REWIND</Text>
          </View>
          <Text style={styles.entryTagline}>PRIVATE MOMENTS, SHARED TOGETHER</Text>
        </View>
        {visibleMode === 'welcome' ? (
          <View style={styles.welcomeActions} testID="welcome-entry">
            <Pressable
              accessibilityRole="button"
              onPress={() => setMode('create-account')}
              style={({ pressed }) => [
                styles.entryActionButton,
                ...interactionFeedback({ pressed }),
              ]}
            >
              <Text style={styles.entryActionButtonText}>Create account</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setMode('sign-in')}
              style={({ pressed }) => [
                styles.primaryEntryButton,
                ...interactionFeedback({ pressed }),
              ]}
            >
              <Text style={styles.primaryEntryButtonText}>Sign in</Text>
            </Pressable>
          </View>
        ) : visibleMode === 'create-account' ? (
          <View style={styles.entryIntro}>
            <Text style={styles.label}>JOIN REWIND</Text>
            <Text accessibilityRole="header" style={styles.title}>
              Create account
            </Text>
            <Text style={styles.bodyText}>Choose a username and password for your account.</Text>
            {registrationComplete ? (
              <View accessibilityLiveRegion="polite" style={styles.successPanel}>
                <Text style={styles.successText} testID="registration-success">
                  {registrationMessage}
                </Text>
              </View>
            ) : null}
            <Text accessibilityRole="text" style={styles.authFieldLabel}>
              Username
            </Text>
            <TextInput
              accessibilityLabel="Username"
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect={false}
              blurOnSubmit={false}
              editable={!authPending && !registrationComplete}
              onChangeText={setUsername}
              onSubmitEditing={() => registrationPasswordRef.current?.focus()}
              returnKeyType="next"
              style={styles.authInput}
              testID="registration-username"
              textContentType="username"
              value={username}
            />
            <Text accessibilityRole="text" style={styles.authFieldLabel}>
              Password
            </Text>
            <TextInput
              accessibilityLabel="Password"
              autoCapitalize="none"
              autoComplete="new-password"
              blurOnSubmit={false}
              editable={!authPending && !registrationComplete}
              onChangeText={setPassword}
              onSubmitEditing={() => registrationConfirmationRef.current?.focus()}
              ref={registrationPasswordRef}
              returnKeyType="next"
              secureTextEntry
              style={styles.authInput}
              testID="registration-password"
              textContentType="newPassword"
              value={password}
            />
            <Text accessibilityRole="text" style={styles.authFieldLabel}>
              Confirm password
            </Text>
            <TextInput
              accessibilityLabel="Confirm password"
              autoCapitalize="none"
              autoComplete="new-password"
              editable={!authPending && !registrationComplete}
              onChangeText={setPasswordConfirmation}
              onSubmitEditing={() => void submitRegistration()}
              ref={registrationConfirmationRef}
              returnKeyType="go"
              secureTextEntry
              style={styles.authInput}
              testID="registration-password-confirmation"
              textContentType="newPassword"
              value={passwordConfirmation}
            />
            {!auth.secureTransportAvailable ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                Account creation requires the same-origin HTTPS service. Your password will not be
                sent over an insecure connection.
              </Text>
            ) : null}
            {registrationMessage && !registrationComplete ? (
              <Text accessibilityRole="alert" style={styles.errorText} testID="registration-error">
                {registrationMessage}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={
                authPending ||
                registrationComplete ||
                !username.trim() ||
                !password ||
                !passwordConfirmation ||
                !auth.secureTransportAvailable
              }
              onPress={() => void submitRegistration()}
              style={({ pressed }) => [
                styles.primaryEntryButton,
                (authPending ||
                  registrationComplete ||
                  !username.trim() ||
                  !password ||
                  !passwordConfirmation ||
                  !auth.secureTransportAvailable) &&
                  styles.disabledChoice,
                ...interactionFeedback({ pressed }),
              ]}
              testID="registration-submit"
            >
              <Text style={styles.primaryEntryButtonText}>
                {authPending ? 'Creating account…' : 'Create account'}
              </Text>
            </Pressable>
            {registrationComplete ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setRegistrationComplete(false);
                  setRegistrationError(null);
                  setMode('sign-in');
                }}
                style={({ pressed }) => [
                  styles.entryActionButton,
                  ...interactionFeedback({ pressed }),
                ]}
                testID="registration-continue-to-sign-in"
              >
                <Text style={styles.entryActionButtonText}>Sign in</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => setMode('welcome')}
              style={({ pressed }) => [
                styles.entryActionButton,
                ...interactionFeedback({ pressed }),
              ]}
            >
              <Text style={styles.entryActionButtonText}>Back</Text>
            </Pressable>
          </View>
        ) : visibleMode === 'sign-in' ? (
          <View style={styles.entryIntro}>
            <Text style={styles.label}>WELCOME BACK</Text>
            <Text accessibilityRole="header" style={styles.title}>
              Sign in
            </Text>
            <Text style={styles.bodyText}>Enter your Rewind username and password.</Text>
            {inviteGroupId ? (
              <Text style={styles.bodyText} testID="invite-sign-in-intent">
                Invitation for group {inviteGroupId} saved. Sign in to continue.
              </Text>
            ) : null}
            <Text accessibilityRole="text" style={styles.authFieldLabel}>
              Username
            </Text>
            <TextInput
              accessibilityLabel="Username"
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect={false}
              editable={!authPending}
              onChangeText={setUsername}
              returnKeyType="next"
              style={styles.authInput}
              testID="real-account-username"
              textContentType="username"
              value={username}
            />
            <Text accessibilityRole="text" style={styles.authFieldLabel}>
              Password
            </Text>
            <TextInput
              accessibilityLabel="Password"
              autoCapitalize="none"
              autoComplete="current-password"
              editable={!authPending}
              onChangeText={setPassword}
              onSubmitEditing={() => void submitSignIn()}
              returnKeyType="go"
              secureTextEntry
              style={styles.authInput}
              testID="real-account-password"
              textContentType="password"
              value={password}
            />
            {!auth.secureTransportAvailable ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                Sign-in is unavailable until this app is connected to its same-origin HTTPS service.
                Your password will not be sent over an insecure connection.
              </Text>
            ) : null}
            {authMessage &&
            auth.notice !== 'sign-out-recovery-pending' &&
            auth.notice !== 'sign-out-marker-unavailable' &&
            auth.notice !== 'sign-out-marker-cleanup-failed' &&
            auth.notice !== 'local-credential-removal-failed' &&
            !(auth.notice === 'offline' && !auth.secureTransportAvailable) ? (
              <Text
                accessibilityRole="alert"
                style={styles.errorText}
                testID={
                  auth.notice === 'offline'
                    ? 'real-account-offline-status'
                    : 'real-account-session-status'
                }
              >
                {authMessage}
              </Text>
            ) : null}
            {auth.notice === 'offline' ? (
              <Pressable
                accessibilityRole="button"
                onPress={auth.retryRestore}
                style={({ pressed }) => [styles.retryButton, ...interactionFeedback({ pressed })]}
              >
                <Text style={styles.retryButtonText}>Retry session check</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={
                authPending || !username.trim() || !password || !auth.secureTransportAvailable
              }
              onPress={() => void submitSignIn()}
              style={({ pressed }) => [
                styles.primaryEntryButton,
                (authPending || !username.trim() || !password || !auth.secureTransportAvailable) &&
                  styles.disabledChoice,
                ...interactionFeedback({ pressed }),
              ]}
              testID="real-account-submit"
            >
              <Text style={styles.primaryEntryButtonText}>
                {authPending ? 'Signing in…' : 'Sign in'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setMode('welcome')}
              style={({ pressed }) => [
                styles.entryActionButton,
                ...interactionFeedback({ pressed }),
              ]}
            >
              <Text style={styles.entryActionButtonText}>Back to welcome</Text>
            </Pressable>
            {inviteGroupId || !demoAccessEnabled ? null : (
              <Pressable
                accessibilityRole="button"
                disabled={authPending}
                onPress={() => {
                  setSelectedDemoMemberId(null);
                  setMode('demo');
                }}
                style={({ pressed }) => [
                  styles.primaryEntryButton,
                  authPending && styles.disabledChoice,
                  ...interactionFeedback({ pressed }),
                ]}
              >
                <Text style={styles.primaryEntryButtonText}>Try Demo</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              disabled={authPending}
              onPress={() => {
                setRegistrationComplete(false);
                setRegistrationError(null);
                setMode('create-account');
              }}
              style={({ pressed }) => [
                styles.entryActionButton,
                authPending && styles.disabledChoice,
                ...interactionFeedback({ pressed }),
              ]}
              testID="sign-in-create-account"
            >
              <Text style={styles.entryActionButtonText}>Create account</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.entryIntro}>
            <Text style={styles.label}>EXPLORE REWIND</Text>
            <Text accessibilityRole="header" style={styles.title}>
              Choose a Demo member
            </Text>
            <Text style={styles.bodyText}>
              Explore with sample people and moments. Your Demo stays separate from your groups.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setSelectedDemoMemberId(null);
                setMode('sign-in');
              }}
              style={({ pressed }) => [
                styles.entryActionButton,
                ...interactionFeedback({ pressed }),
              ]}
            >
              <Text style={styles.entryActionButtonText}>Back to sign in</Text>
            </Pressable>
          </View>
        )}
        {error && visibleMode !== 'welcome' ? (
          <View
            accessible={false}
            accessibilityLabel={entryReason === 'offline' ? 'Offline status' : 'Session status'}
            style={styles.errorPanel}
            testID="entry-session-status"
          >
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={pending || authPending}
              onPress={() => {
                if (canRetryDemoStart && selectedDemoMemberId) {
                  void chooseMember(selectedDemoMemberId);
                } else {
                  retryRestore();
                }
              }}
              style={({ pressed }) => [styles.retryButton, ...interactionFeedback({ pressed })]}
              testID={canRetryDemoStart ? 'retry-demo-start' : 'retry-session-check'}
            >
              <Text style={styles.retryButtonText}>
                {canRetryDemoStart ? 'Retry Demo start' : 'Retry session check'}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {(auth.notice === 'offline' ||
          auth.notice === 'expired' ||
          auth.notice === 'revoked' ||
          auth.notice === 'revocation-unconfirmed' ||
          auth.notice === 'local-credential-removal-failed' ||
          auth.notice === 'sign-out-incomplete' ||
          auth.notice === 'sign-out-recovery-pending' ||
          auth.notice === 'sign-out-marker-cleanup-failed' ||
          auth.notice === 'sign-out-marker-unavailable') &&
        (visibleMode === 'demo' ||
          visibleMode === 'create-account' ||
          auth.notice === 'sign-out-incomplete' ||
          auth.notice === 'sign-out-recovery-pending' ||
          auth.notice === 'sign-out-marker-cleanup-failed' ||
          auth.notice === 'sign-out-marker-unavailable' ||
          auth.notice === 'local-credential-removal-failed') &&
        !(auth.notice === 'offline' && !auth.secureTransportAvailable) &&
        !(auth.notice === 'offline' && error) ? (
          <View
            style={styles.errorPanel}
            testID={
              auth.notice === 'offline'
                ? 'real-account-offline-status'
                : 'real-account-session-status'
            }
          >
            <Text accessibilityRole="alert" style={styles.errorText}>
              {authMessage}
            </Text>
            {auth.notice === 'offline' ? (
              <Pressable
                accessibilityRole="button"
                onPress={auth.retryRestore}
                style={styles.retryButton}
              >
                <Text style={styles.retryButtonText}>Retry session check</Text>
              </Pressable>
            ) : null}
            {auth.notice === 'local-credential-removal-failed' ? (
              <Pressable
                accessibilityRole="button"
                disabled={auth.pending}
                onPress={auth.retryLocalCredentialRemoval}
                style={styles.retryButton}
              >
                <Text style={styles.retryButtonText}>
                  {auth.pending ? 'Retrying…' : 'Retry local cleanup'}
                </Text>
              </Pressable>
            ) : null}
            {auth.notice === 'sign-out-marker-cleanup-failed' ? (
              <Pressable
                accessibilityRole="button"
                disabled={auth.pending}
                onPress={auth.retryLocalCredentialRemoval}
                style={styles.retryButton}
              >
                <Text style={styles.retryButtonText}>
                  {auth.pending ? 'Retrying…' : 'Retry local cleanup'}
                </Text>
              </Pressable>
            ) : null}
            {auth.notice === 'sign-out-incomplete' ? (
              <Pressable
                accessibilityRole="button"
                disabled={auth.pending}
                onPress={auth.signOut}
                style={styles.retryButton}
              >
                <Text style={styles.retryButtonText}>
                  {auth.pending ? 'Signing out…' : 'Retry sign out'}
                </Text>
              </Pressable>
            ) : null}
            {auth.notice === 'sign-out-recovery-pending' ||
            auth.notice === 'sign-out-marker-unavailable' ? (
              <Pressable
                accessibilityRole="button"
                disabled={auth.pending}
                onPress={auth.signOut}
                style={styles.retryButton}
              >
                <Text style={styles.retryButtonText}>
                  {auth.pending ? 'Signing out…' : 'Retry sign out'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {mode === 'demo' ? (
          <View style={styles.entryChoices}>
            {profiles.map((profile) => (
              <Pressable
                accessibilityHint="Starts local Demo access for this synthetic member"
                accessibilityLabel={`Enter Demo as ${profile.displayName}, sample member`}
                accessibilityRole="button"
                disabled={pending}
                key={profile.id}
                onPress={() => startDemo(profile.id)}
                style={({ pressed }) => [
                  styles.entryChoice,
                  pending && styles.disabledChoice,
                  ...interactionFeedback({ pressed }),
                ]}
                testID={`demo-entry-${profile.id}`}
              >
                <Text style={styles.entryChoiceName}>{profile.displayName}</Text>
                <Text style={styles.entryChoiceBody}>Sample member · local only</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {pending || authPending ? (
          <Text accessibilityLiveRegion="polite" style={styles.bodyText}>
            {authPending ? 'Signing in…' : 'Starting the sample Demo…'}
          </Text>
        ) : null}
      </Animated.ScrollView>
    </SafeAreaFrame>
  );
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
            Local Demo
          </Text>
        </View>
        <View accessible style={styles.settingsPanel} testID="settings-identity">
          <Text style={styles.label}>CURRENT ACCESS</Text>
          <Text style={styles.panelTitle}>{session.actor.displayName}</Text>
          <Text style={styles.bodyText}>Synthetic member · Demo access</Text>
        </View>
        <DemoProfilePicker />
        <View accessible style={styles.settingsPanel} testID="settings-group">
          <Text style={styles.label}>CURRENT GROUP</Text>
          <Text style={styles.panelTitle}>{groupName}</Text>
          <Text style={styles.bodyText}>{role === 'owner' ? 'Owner' : 'Member'} · local group</Text>
        </View>
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
            <Text accessibilityRole="header" style={[styles.dialogTitle, { color: '#fff7ec' }]}>
              Reset local Demo data?
            </Text>
            <ScrollView style={styles.dialogCopy}>
              <Text style={[styles.dialogBodyText, { color: '#fff7ec' }]}>
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
                <Text style={[styles.dialogButtonText, { color: '#fff7ec' }]}>Keep local data</Text>
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
                <Text style={[styles.dialogDangerButtonText, { color: '#fff7ec' }]}>
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
    <View accessible={false} style={styles.settingsPanel} testID="settings-local-reveal">
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
    </View>
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
    <View accessible={false} style={styles.settingsPanel} testID="settings-invites">
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
        placeholderTextColor={COLORS.muted}
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
    </View>
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
          placeholderTextColor={COLORS.muted}
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
              placeholderTextColor={COLORS.muted}
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
  ledgerScope,
  onAddMoment,
  onOpenArchive,
  revealState,
  runtimeClient,
}: {
  clock: () => number;
  ledgerScope: { sessionId: string; groupId: string; memberId: string; cycleId: string } | null;
  onAddMoment: () => void;
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

      <CapsuleSummary
        clock={clock}
        onAddMoment={onAddMoment}
        onOpenArchive={onOpenArchive}
        revealState={revealState}
      />

      {runtimeClient?.getContributionLedger && ledgerScope ? (
        <ContributionLedgerSection client={runtimeClient} {...ledgerScope} />
      ) : null}

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
      {ROUTES.map((route) => {
        const isSelected = route.key === activeRoute;

        return (
          <Pressable
            accessibilityHint={`Shows the ${route.label} area`}
            accessibilityLabel={
              route.key === 'chat' && unreadCount > 0
                ? `Chat, ${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}`
                : route.label
            }
            accessibilityRole="tab"
            accessibilityState={{ selected: isSelected }}
            key={route.key}
            onPress={() => onNavigate(route.key)}
            style={({ pressed }) => [
              styles.tab,
              isSelected && styles.selectedTab,
              ...interactionFeedback({ pressed }),
            ]}
            testID={`nav-${route.key}`}
          >
            <Text style={[styles.tabLabel, isSelected && styles.selectedTabLabel]}>
              {route.label}
            </Text>
            {route.key === 'chat' && unreadCount > 0 ? (
              <Text style={styles.unreadBadge} testID="chat-unread-badge">
                {unreadCount > 99 ? '99+' : unreadCount}
              </Text>
            ) : null}
            <Text style={styles.tabState}>{isSelected ? 'SELECTED' : ' '}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    alignItems: 'center',
    backgroundColor: COLORS.background,
    flex: 1,
  },
  screen: {
    backgroundColor: COLORS.background,
    flex: 1,
    width: '100%',
  },
  wideScreen: { maxWidth: 960 },
  content: {
    flexGrow: 1,
    gap: 18,
    padding: 24,
    paddingBottom: 32,
  },
  homeScroll: {
    flex: 1,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  brandLockup: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  headerMark: { height: 30, width: 30 },
  brandMark: { height: 64, width: 64 },
  loadingBrand: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center' },
  loadingWordmark: { color: COLORS.ink, fontSize: 17, fontWeight: '800', letterSpacing: 3 },
  loadingTagline: { color: COLORS.muted, fontSize: 12, letterSpacing: 1.2, textAlign: 'center' },
  wordmark: {
    color: COLORS.ink,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 2,
  },
  label: {
    color: COLORS.edge,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  title: {
    color: COLORS.ink,
    fontSize: 30,
    fontWeight: '700',
    marginTop: 6,
  },
  mutedText: {
    color: COLORS.muted,
    fontSize: 14,
    marginTop: 4,
  },
  panelTitle: {
    color: COLORS.ink,
    fontSize: 22,
    fontWeight: '700',
  },
  bodyText: {
    color: COLORS.muted,
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
    aspectRatio: 0.75,
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 6,
    borderStyle: 'dashed',
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
  },
  lockedText: {
    color: COLORS.edge,
    fontSize: 10,
    fontWeight: '700',
  },
  disabledButton: {
    alignItems: 'center',
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
  },
  disabledButtonText: {
    color: COLORS.muted,
    fontSize: 15,
    fontWeight: '700',
  },
  helperText: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: -12,
    textAlign: 'center',
  },
  dialogHelperText: { color: COLORS.ink, fontSize: 12, textAlign: 'center' },
  dialogBodyText: { color: COLORS.ink, fontSize: 14, lineHeight: 21 },
  dialogCopy: { maxHeight: 180 },
  dialogTitle: { color: '#fff7ec', fontSize: 22, fontWeight: '700' },
  dialogButtonText: { color: '#fff7ec', fontSize: 15, fontWeight: '700' },
  dialogDangerButtonText: { color: COLORS.ink, fontSize: 15, fontWeight: '700' },
  dialogButton: {
    alignItems: 'center',
    backgroundColor: '#302d30',
    borderColor: COLORS.accent,
    borderRadius: 8,
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
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
    padding: 20,
  },
  navigation: {
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    minHeight: 68,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  selectedTab: {
    backgroundColor: COLORS.paper,
    borderTopColor: COLORS.accent,
    borderTopWidth: 2,
  },
  tabLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  selectedTabLabel: {
    color: COLORS.ink,
  },
  unreadBadge: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    color: COLORS.deep,
    fontSize: 11,
    fontWeight: '800',
    minWidth: 20,
    overflow: 'hidden',
    paddingHorizontal: 5,
    textAlign: 'center',
  },
  tabState: {
    color: COLORS.accent,
    fontSize: 8,
    fontWeight: '700',
    marginTop: 4,
  },
  activeShell: { flex: 1, minHeight: 0 },
  routeContent: { flex: 1, minHeight: 0 },
  settingsScreen: { flex: 1 },
  entryContent: {
    flexGrow: 1,
    gap: 24,
    justifyContent: 'space-between',
    padding: 24,
    paddingBottom: 36,
  },
  entryBrand: { alignItems: 'center', alignSelf: 'stretch', gap: 8 },
  entryTagline: { color: COLORS.muted, fontSize: 12, letterSpacing: 1.2, textAlign: 'center' },
  welcomeActions: { flexGrow: 1, gap: 12, justifyContent: 'flex-end' },
  entryIntro: { gap: 12 },
  authFieldLabel: { color: COLORS.ink, fontSize: 14, fontWeight: '700', marginTop: 4 },
  authInput: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderWidth: 1,
    color: COLORS.ink,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: 14,
  },
  realAccountHome: { justifyContent: 'flex-start' },
  entryChoices: { gap: 12 },
  primaryEntryButton: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  primaryEntryButtonText: { color: COLORS.deep, fontSize: 16, fontWeight: '800' },
  entryActionButton: {
    alignItems: 'center',
    backgroundColor: COLORS.paper,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  entryActionButtonText: { color: COLORS.ink, fontSize: 16, fontWeight: '700' },
  entryChoice: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderWidth: 1,
    gap: 5,
    minHeight: 64,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  disabledChoice: { opacity: 0.55 },
  pressedControl: { opacity: 0.78 },
  successPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
  },
  successText: { color: COLORS.ink, fontSize: 14, lineHeight: 21 },
  entryChoiceName: { color: COLORS.ink, fontSize: 18, fontWeight: '700' },
  entryChoiceBody: { color: COLORS.muted, fontSize: 13 },
  errorPanel: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.accent,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
    padding: 14,
  },
  errorText: { color: COLORS.accent, fontSize: 14, lineHeight: 21 },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: COLORS.background,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  retryButtonText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  settingsPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 7,
    padding: 16,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonText: { color: COLORS.deep, fontSize: 15, fontWeight: '800' },
  inviteCode: {
    color: COLORS.ink,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 4,
    paddingVertical: 8,
  },
  inviteLink: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  outlineButton: {
    alignItems: 'center',
    backgroundColor: COLORS.paper,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  outlineButtonText: { color: COLORS.ink, fontSize: 15, fontWeight: '700' },
  dangerButton: {
    alignItems: 'center',
    backgroundColor: COLORS.deep,
    borderColor: COLORS.accent,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  dangerButtonText: { color: COLORS.accent, fontSize: 15, fontWeight: '700' },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(29, 27, 30, 0.96)',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.edge,
    borderRadius: 12,
    borderWidth: 1,
    gap: 14,
    maxWidth: 360,
    padding: 20,
    width: '100%',
  },
  modalActions: { gap: 10 },
  formPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  fieldLabel: { color: COLORS.ink, fontSize: 15, fontWeight: '700' },
  textInput: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    color: COLORS.ink,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  promptInput: { minHeight: 96, textAlignVertical: 'top' },
  counter: { color: COLORS.muted, fontSize: 12, textAlign: 'right' },
  fieldError: { color: COLORS.accent, fontSize: 13, lineHeight: 19 },
  promptChoice: {
    alignItems: 'center',
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  promptChoiceText: { flex: 1, flexShrink: 1 },
  promptChoiceSelected: { backgroundColor: COLORS.deep, borderColor: COLORS.accent },
  radioState: { color: COLORS.accent, fontSize: 12, fontWeight: '700' },
});
