import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { DemoProfileProvider } from './src/profiles/DemoProfileProvider';
import { CapsuleProvider, useCapsule } from './src/capsule/CapsuleProvider';
import type { HomeDebugScenario } from './src/capsule/CapsuleSummary';
import type { CycleRepository } from './src/domain/cycles';
import {
  revealStateForCycle,
  revealStateForPremiere,
  type RevealEducationState,
} from './src/domain/reveal-education';
import type { AsyncGroupRepository, GroupRepository } from './src/domain/profiles';
import { COLORS } from './src/theme';
import { createConfiguredRuntime } from './src/runtime/config';
import type { RuntimeClient } from './src/runtime/local-runtime-client';
import { createRuntimeRepositories } from './src/runtime/runtime-repositories';
import { DemoSessionProvider, useDemoSession } from './src/session/DemoSessionProvider';
import {
  CameraCaptureScreen,
  ContributionStatusProvider,
  DemoCameraPlatform,
  VideoCaptureScreen,
  type CameraPlatform,
} from './src/capture';
import type { CameraDebugScenario } from './src/capture/CameraCaptureScreen';
import type { VideoDebugScenario } from './src/capture/VideoCaptureScreen';
import { isInviteLinkCandidate, parseInviteLink } from './src/invites/deep-links';
import { ChatScreen, type ChatDebugScenario } from './src/chat/ChatScreen';
import { ChatUnreadProvider } from './src/chat/unread';
import { ArchiveScreen, type ArchiveDebugScenario } from './src/archive/ArchiveScreen';
import { DebugProvider, useDebugOfflineRuntime, useDebugScenario } from './src/debug/DebugProvider';
import { DebugSheet } from './src/debug/DebugSheet';
import { debugContributionStatus } from './src/debug/fixtures';
import type { DebugScreen } from './src/debug/scenarios';
import {
  DemoAccessChooser,
  SessionRestoring,
  type EntryDebugScenario,
} from './src/entry/DemoAccessEntry';
import {
  GroupCreateScreen,
  JoinGroupScreen,
  type GroupDebugScenario,
  type InviteLinkIntent,
  type JoinDebugScenario,
} from './src/groups/GroupScreens';
import { HomeScreen } from './src/home/HomeScreen';
import { LanguageProvider } from './src/i18n/LanguageProvider';
import { SettingsScreen, type SettingsDebugScenario } from './src/settings/SettingsScreen';
import { AppHeader, MainNavigation, type RouteKey } from './src/shell/AppChrome';
import { kitStyles } from './src/ui/kit';

type ShellRoute = RouteKey | 'create-group' | 'video' | 'join' | 'entry-preview';

const DEBUG_SCREEN_FOR_ROUTE: Record<ShellRoute, DebugScreen> = {
  archive: 'archive',
  camera: 'camera',
  chat: 'chat',
  'create-group': 'group',
  'entry-preview': 'entry',
  home: 'home',
  join: 'join',
  settings: 'settings',
  video: 'video',
};

const ROUTE_FOR_DEBUG_SCREEN: Record<DebugScreen, ShellRoute> = {
  archive: 'archive',
  camera: 'camera',
  chat: 'chat',
  entry: 'entry-preview',
  group: 'create-group',
  home: 'home',
  join: 'join',
  settings: 'settings',
  video: 'video',
};

export interface AppProps {
  clock?: () => number;
  cycleRepository?: CycleRepository;
  groupRepository?: GroupRepository | AsyncGroupRepository;
  runtimeClient?: RuntimeClient | null;
  /** Inject a deterministic fixture platform for simulator evidence/tests. */
  cameraPlatform?: CameraPlatform;
}

export default function App({
  clock = Date.now,
  cycleRepository,
  groupRepository,
  runtimeClient,
  cameraPlatform,
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
    <LanguageProvider>
      <DebugProvider>
        <SafeAreaProvider>
          <DemoSessionProvider runtimeClient={configuredRuntime?.client ?? null}>
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
        </SafeAreaProvider>
      </DebugProvider>
    </LanguageProvider>
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
  const sessionRepositories = useMemo(
    () => (runtimeClient && session ? createRuntimeRepositories(runtimeClient, session.id) : null),
    [runtimeClient, session],
  );
  if (status === 'loading') return <SessionLoadingScreen />;
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
      <AppHeader />
      <View style={kitStyles.content}>
        <SessionRestoring />
      </View>
    </SafeAreaFrame>
  );
}

function DemoAccessEntry() {
  return (
    <SafeAreaFrame>
      <AppHeader />
      <ScrollView contentContainerStyle={kitStyles.content} style={kitStyles.scroll}>
        <DemoAccessChooser />
      </ScrollView>
    </SafeAreaFrame>
  );
}

function SafeAreaFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView
        edges={['top', 'right', 'bottom', 'left']}
        style={styles.page}
        testID="application-safe-area"
      >
        <View style={styles.screen}>{children}</View>
      </SafeAreaView>
    </>
  );
}

function ActiveAppShell({
  clock,
  inviteLink,
  runtimeClient: configuredRuntimeClient,
  cameraPlatform,
}: {
  clock: () => number;
  inviteLink: InviteLinkIntent | null;
  runtimeClient: RuntimeClient | null;
  cameraPlatform?: CameraPlatform;
}) {
  const [activeRoute, setActiveRoute] = useState<ShellRoute>(() => (inviteLink ? 'join' : 'home'));
  const [confirmResetDialogOpen, setConfirmResetDialogOpen] = useState(false);
  // Local still acceptance is shown for the member/group that accepted it.
  const [stillSavedScope, setStillSavedScope] = useState<string | null>(null);
  const previousRoute = useRef(activeRoute);
  const initialFocusPending = useRef(true);
  const { retry: refreshCapsule, state: capsuleState } = useCapsule();
  const { session } = useDemoSession();
  const debugOffline = useDebugOfflineRuntime();
  // Debug "offline" hides the configured runtime from product screens only;
  // the session and capsule repositories keep their real data source.
  const runtimeClient = debugOffline ? null : configuredRuntimeClient;
  const homeDebug = useDebugScenario<HomeDebugScenario>('home');
  const cameraDebug = useDebugScenario<CameraDebugScenario>('camera');
  const videoDebug = useDebugScenario<VideoDebugScenario>('video');
  const chatDebug = useDebugScenario<ChatDebugScenario>('chat');
  const archiveDebug = useDebugScenario<ArchiveDebugScenario>('archive');
  const settingsDebug = useDebugScenario<SettingsDebugScenario>('settings');
  const groupDebug = useDebugScenario<GroupDebugScenario>('group');
  const joinDebug = useDebugScenario<JoinDebugScenario>('join');
  const entryDebug = useDebugScenario<EntryDebugScenario>('entry');
  const debugContribution = debugContributionStatus(videoDebug.scenario);
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
  const homeForcedReveal =
    homeDebug.scenario === 'processing' ||
    homeDebug.scenario === 'delayed' ||
    homeDebug.scenario === 'released'
      ? homeDebug.scenario
      : null;

  const sessionScope = session ? `${session.id}:${session.groupId}` : null;
  const stillSaved = Boolean(sessionScope && stillSavedScope === sessionScope);

  useEffect(() => {
    const shouldFocus = initialFocusPending.current || previousRoute.current !== activeRoute;
    previousRoute.current = activeRoute;
    initialFocusPending.current = false;
    if (Platform.OS !== 'web' || !shouldFocus) return;
    if (typeof document === 'undefined') return;
    const route = document.getElementById(`screen-route-${activeRoute}`);
    if (!route) return;
    const focusHeading = () => {
      const heading = route.querySelector<HTMLElement>(
        `[data-testid="route-heading-${activeRoute}"]`,
      );
      if (!heading) return false;
      heading.tabIndex = -1;
      heading.focus();
      return true;
    };
    if (focusHeading()) return;
    let timeout: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      if (focusHeading()) {
        observer.disconnect();
        clearTimeout(timeout);
      }
    });
    timeout = setTimeout(() => observer.disconnect(), 5000);
    observer.observe(route, { childList: true, subtree: true });
    if (focusHeading()) {
      observer.disconnect();
      clearTimeout(timeout);
    }
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
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

  const debugScreen = DEBUG_SCREEN_FOR_ROUTE[activeRoute];
  const navRoute: RouteKey =
    activeRoute === 'create-group' || activeRoute === 'join' || activeRoute === 'entry-preview'
      ? 'settings'
      : activeRoute === 'video'
        ? 'camera'
        : activeRoute;

  return (
    <ChatUnreadProvider
      activeGroupId={activeRoute === 'chat' ? (session?.groupId ?? null) : null}
      enabled={chatStreamEnabled}
      runtimeClient={runtimeClient}
      session={unreadSession}
    >
      <SafeAreaFrame>
        <View style={styles.activeShell}>
          <AppHeader debugScreen={debugScreen} />
          <View nativeID={`screen-route-${activeRoute}`} style={styles.routeContent}>
            {activeRoute === 'home' ? (
              <HomeScreen
                clock={clock}
                contributionStatusOverride={debugContribution ?? undefined}
                debugScenario={homeDebug.scenario}
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
                onOpenSettings={() => setActiveRoute('settings')}
                revealState={homeForcedReveal ?? revealState}
                runtimeClient={runtimeClient}
                stillSaved={stillSaved || cameraDebug.scenario === 'saved'}
              />
            ) : activeRoute === 'settings' ? (
              <SettingsScreen
                confirmResetDialogOpen={confirmResetDialogOpen}
                debugScenario={settingsDebug.scenario}
                onConfirmResetDialogOpenChange={setConfirmResetDialogOpen}
                onCreateGroup={() => setActiveRoute('create-group')}
                onJoinGroup={() => setActiveRoute('join')}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'create-group' ? (
              <GroupCreateScreen
                debugScenario={groupDebug.scenario}
                onCancel={() => setActiveRoute('settings')}
                onCreated={() => setActiveRoute('home')}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'join' ? (
              <JoinGroupScreen
                debugScenario={joinDebug.scenario}
                inviteLink={inviteLink}
                onCancel={() => setActiveRoute('settings')}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'entry-preview' ? (
              <ScrollView contentContainerStyle={kitStyles.content} style={kitStyles.scroll}>
                <DemoAccessChooser
                  debugScenario={entryDebug.scenario}
                  onEntered={() => setActiveRoute('home')}
                />
              </ScrollView>
            ) : activeRoute === 'camera' ? (
              <CameraCaptureScreen
                autoRequestPermission={Platform.OS !== 'web'}
                debug={cameraDebug}
                onAccepted={() => setStillSavedScope(sessionScope)}
                onRecordClip={() => setActiveRoute('video')}
                onOpenArchive={() => setActiveRoute('archive')}
                revealState={homeForcedReveal ?? revealState}
                platform={resolvedCameraPlatform}
              />
            ) : activeRoute === 'video' ? (
              <VideoCaptureScreen
                autoRequestPermission={Platform.OS !== 'web'}
                contributionStatusOverride={debugContribution ?? undefined}
                debug={videoDebug}
                onBack={() => setActiveRoute('camera')}
                onContributionDeleted={refreshCapsule}
                platform={resolvedCameraPlatform}
                runtimeClient={runtimeClient}
              />
            ) : activeRoute === 'chat' ? (
              <ChatScreen debugScenario={chatDebug.scenario} runtimeClient={runtimeClient} />
            ) : (
              <ArchiveScreen debug={archiveDebug} runtimeClient={runtimeClient} />
            )}
          </View>
          <MainNavigation
            activeRoute={navRoute}
            backgroundHidden={confirmResetDialogOpen}
            onNavigate={setActiveRoute}
          />
        </View>
        <DebugSheet
          currentScreen={debugScreen}
          onNavigate={(screen) => setActiveRoute(ROUTE_FOR_DEBUG_SCREEN[screen])}
        />
      </SafeAreaFrame>
    </ChatUnreadProvider>
  );
}

const styles = StyleSheet.create({
  page: {
    alignItems: 'center',
    backgroundColor: COLORS.deep,
    flex: 1,
  },
  screen: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.line,
    borderWidth: 1,
    flex: 1,
    maxWidth: 390,
    width: '100%',
  },
  activeShell: { flex: 1, minHeight: 0 },
  routeContent: { flex: 1, minHeight: 0 },
});
