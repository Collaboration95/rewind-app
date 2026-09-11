import { useMemo, useState, type ReactNode } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { DemoProfilePicker } from './src/profiles/DemoProfilePicker';
import { DemoProfileProvider } from './src/profiles/DemoProfileProvider';
import { CapsuleProvider, useCapsule } from './src/capsule/CapsuleProvider';
import { CapsuleSummary } from './src/capsule/CapsuleSummary';
import type { CycleRepository } from './src/domain/cycles';
import type {
  AsyncGroupRepository,
  CreateGroupInput,
  GroupRepository,
} from './src/domain/profiles';
import { COLORS } from './src/theme';
import { createConfiguredRuntime } from './src/runtime/config';
import type { RuntimeClient } from './src/runtime/local-runtime-client';
import { createRuntimeRepositories } from './src/runtime/runtime-repositories';
import { RuntimeStatusCard } from './src/runtime/RuntimeStatusCard';
import { DemoSessionProvider, useDemoSession } from './src/session/DemoSessionProvider';
import { CameraCaptureScreen, DemoCameraPlatform, type CameraPlatform } from './src/capture';
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

const lockedMoments = [1, 2, 3];

const ROUTES = [
  { key: 'home', label: 'Home' },
  { key: 'camera', label: 'Camera' },
  { key: 'chat', label: 'Chat' },
  { key: 'archive', label: 'Archive' },
  { key: 'settings', label: 'Settings' },
] as const;

type RouteKey = (typeof ROUTES)[number]['key'];
type UnavailableRouteKey = Exclude<RouteKey, 'home' | 'settings' | 'camera'>;

const unavailableScreens: Record<UnavailableRouteKey, { description: string; title: string }> = {
  archive: {
    description:
      'Archive playback is not implemented. Locked moments remain unavailable until reveal.',
    title: 'Archive',
  },
  chat: {
    description: 'Chat is not implemented. No messages are being sent or stored.',
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
}

export default function App({
  clock = Date.now,
  cycleRepository,
  groupRepository,
  runtimeClient,
  cameraPlatform,
}: AppProps = {}) {
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
      <DemoSessionProvider runtimeClient={configuredRuntime?.client ?? null}>
        <DemoProfileProvider>
          <SessionGate
            clock={clock}
            cycleRepository={cycleRepository}
            groupRepository={groupRepository}
            runtimeClient={configuredRuntime?.client ?? null}
            cameraPlatform={cameraPlatform}
          />
        </DemoProfileProvider>
      </DemoSessionProvider>
    </SafeAreaProvider>
  );
}

function SessionGate({
  clock,
  cycleRepository,
  groupRepository,
  runtimeClient,
  cameraPlatform,
}: {
  clock: () => number;
  cycleRepository?: CycleRepository;
  groupRepository?: GroupRepository | AsyncGroupRepository;
  runtimeClient: RuntimeClient | null;
  cameraPlatform?: CameraPlatform;
}) {
  const { status, session } = useDemoSession();
  const sessionRepositories = useMemo(
    () =>
      runtimeClient && session ? createRuntimeRepositories(runtimeClient, session.id) : null,
    [runtimeClient, session?.id],
  );
  if (status === 'loading') return <SessionLoadingScreen />;
  if (status === 'entry' || status === 'error') return <DemoAccessEntry />;
  return (
    <CapsuleProvider
      groupRepository={groupRepository ?? sessionRepositories?.groupRepository}
      cycleRepository={cycleRepository ?? sessionRepositories?.cycleRepository}
    >
      <ActiveAppShell cameraPlatform={cameraPlatform} clock={clock} runtimeClient={runtimeClient} />
    </CapsuleProvider>
  );
}

function SessionLoadingScreen() {
  return (
    <SafeAreaFrame>
      <View style={styles.entryContent}>
        <AppHeader />
        <Text style={styles.label}>DEMO ACCESS</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Restoring local access…
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.bodyText}>
          Checking the saved synthetic session on this device.
        </Text>
      </View>
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
  runtimeClient,
  cameraPlatform,
}: {
  clock: () => number;
  runtimeClient: RuntimeClient | null;
  cameraPlatform?: CameraPlatform;
}) {
  const [activeRoute, setActiveRoute] = useState<RouteKey | 'create-group'>('home');
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
    <SafeAreaFrame>
      <View style={styles.activeShell}>
        {activeRoute === 'home' ? (
          <HomeScreen clock={clock} runtimeClient={runtimeClient} />
        ) : activeRoute === 'settings' ? (
          <SettingsScreen
            onCreateGroup={() => setActiveRoute('create-group')}
            runtimeClient={runtimeClient}
          />
        ) : activeRoute === 'create-group' ? (
          <GroupCreateScreen
            onCancel={() => setActiveRoute('settings')}
            onCreated={() => setActiveRoute('home')}
            runtimeClient={runtimeClient}
          />
        ) : activeRoute === 'camera' ? (
          <CameraCaptureScreen platform={resolvedCameraPlatform} />
        ) : (
          <UnavailableScreen route={activeRoute as UnavailableRouteKey} />
        )}
        <MainNavigation
          activeRoute={activeRoute === 'create-group' ? 'settings' : activeRoute}
          onNavigate={setActiveRoute}
        />
      </View>
    </SafeAreaFrame>
  );
}

function AppHeader() {
  return (
    <View style={styles.topBar}>
      <Text style={styles.wordmark}>REWIND</Text>
      <View accessibilityLabel="Local demo data" style={styles.demoBadge}>
        <Text style={styles.demoBadgeText}>LOCAL DEMO</Text>
      </View>
    </View>
  );
}

function DemoAccessEntry() {
  const { profiles, chooseMember, error, pending, retryRestore } = useDemoSession();

  return (
    <SafeAreaFrame>
      <ScrollView contentContainerStyle={styles.entryContent}>
        <AppHeader />
        <View style={styles.entryIntro}>
          <Text style={styles.label}>DEMO ACCESS</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Choose who you are showing
          </Text>
          <Text style={styles.bodyText}>
            Pick a synthetic member to enter the local Demo. This is not a secure account or
            sign-in.
          </Text>
        </View>
        {error ? (
          <View accessible accessibilityLabel="Demo access error" style={styles.errorPanel}>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <Pressable accessibilityRole="button" onPress={retryRestore} style={styles.retryButton}>
              <Text style={styles.retryButtonText}>Retry Demo access</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.entryChoices}>
          {profiles.map((profile) => (
            <Pressable
              accessibilityHint="Starts local Demo access for this synthetic member"
              accessibilityLabel={`Enter Demo as ${profile.displayName}, sample member`}
              accessibilityRole="button"
              disabled={pending}
              key={profile.id}
              onPress={() => void chooseMember(profile.id)}
              style={[styles.entryChoice, pending && styles.disabledChoice]}
              testID={`demo-entry-${profile.id}`}
            >
              <Text style={styles.entryChoiceName}>{profile.displayName}</Text>
              <Text style={styles.entryChoiceBody}>Sample member · local only</Text>
            </Pressable>
          ))}
        </View>
        {pending ? (
          <Text accessibilityLiveRegion="polite" style={styles.bodyText}>
            Starting Demo access…
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaFrame>
  );
}

function SettingsScreen({
  onCreateGroup,
  runtimeClient,
}: {
  onCreateGroup: () => void;
  runtimeClient: RuntimeClient | null;
}) {
  const { session, signOut, resetDemoData, pending, error } = useDemoSession();
  const { state } = useCapsule();
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!session) return null;
  const groupName = state.group?.name ?? session.groupId;
  const role = state.group?.actingMemberRole ?? 'member';

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.homeScroll}>
      <AppHeader />
      <View>
        <Text style={styles.label}>SETTINGS</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Local Demo
        </Text>
      </View>
      <View accessible style={styles.settingsPanel} testID="settings-identity">
        <Text style={styles.label}>CURRENT ACCESS</Text>
        <Text style={styles.panelTitle}>{session.actor.displayName}</Text>
        <Text style={styles.bodyText}>Synthetic member · Demo access</Text>
      </View>
      <View accessible style={styles.settingsPanel} testID="settings-group">
        <Text style={styles.label}>CURRENT GROUP</Text>
        <Text style={styles.panelTitle}>{groupName}</Text>
        <Text style={styles.bodyText}>{role === 'owner' ? 'Owner' : 'Member'} · local group</Text>
      </View>
      <InvitePanel groupId={session.groupId} runtimeClient={runtimeClient} />
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
        style={styles.dangerButton}
        testID="reset-demo-data"
      >
        <Text style={styles.dangerButtonText}>Reset local Demo data</Text>
      </Pressable>
      <Text style={styles.helperText}>
        Reset removes local Demo access, groups, and camera files on this device, then restores the
        deterministic fixture.
      </Text>
      <Modal
        accessibilityViewIsModal
        animationType="fade"
        onRequestClose={() => setConfirmOpen(false)}
        transparent
        visible={confirmOpen}
      >
        <View style={styles.modalBackdrop}>
          <View
            accessibilityViewIsModal
            accessibilityRole="alert"
            style={styles.modalCard}
            testID="reset-confirmation"
          >
            <Text accessibilityRole="header" style={styles.panelTitle}>
              Reset local Demo data?
            </Text>
            <Text style={styles.bodyText}>
              This removes the saved Demo session, locally created groups, accepted still metadata,
              and app-owned cached camera files on this device. It restores the deterministic
              five-member fixture. Nothing remote or source-controlled is changed.
            </Text>
            {error ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {error}
              </Text>
            ) : null}
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                disabled={pending}
                onPress={() => setConfirmOpen(false)}
                style={styles.outlineButton}
              >
                <Text style={styles.outlineButtonText}>Keep local data</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={pending}
                onPress={async () => {
                  const reset = await resetDemoData();
                  if (reset) setConfirmOpen(false);
                }}
                style={styles.dangerButton}
                testID="reset-confirm-action"
              >
                <Text style={styles.dangerButtonText}>
                  {pending ? 'Resetting local Demo data…' : 'Reset local Demo data'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function InvitePanel({
  groupId,
  runtimeClient,
}: {
  groupId: string;
  runtimeClient: RuntimeClient | null;
}) {
  const { session, updateGroup } = useDemoSession();
  const { state, retry } = useCapsule();
  const [invite, setInvite] = useState<Awaited<ReturnType<NonNullable<RuntimeClient['createInvite']>>> | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
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
      setFeedback(error instanceof Error ? error.message : 'The invitation code could not be created.');
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

  const accept = async () => {
    if (!runtimeClient?.acceptInvite || !session) {
      setFeedback('Connect the local runtime to accept an invitation code.');
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const result = await runtimeClient.acceptInvite(session.id, code, groupId);
      await updateGroup(result.session.groupId);
      retry();
      setCode('');
      setFeedback(`Joined ${result.group.name}. The code is now used.`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The invitation code could not be accepted.');
    } finally {
      setPending(false);
    }
  };

  return (
    <View accessible style={styles.settingsPanel} testID="settings-invites">
      <Text style={styles.label}>LOCAL INVITATIONS</Text>
      {owner ? (
        <>
          <Text style={styles.bodyText}>Generate one bounded code for this group. It expires in 24 hours or after one use.</Text>
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => void generate()}
            style={styles.primaryButton}
            testID="generate-invite"
          >
            <Text style={styles.primaryButtonText}>{pending ? 'Generating…' : 'Generate invite code'}</Text>
          </Pressable>
          {invite ? (
            <>
              <Text accessibilityLabel={`Invite code ${invite.code}`} style={styles.inviteCode}>
                {invite.code}
              </Text>
              <Text style={styles.bodyText}>Expires {new Date(invite.expiresAt).toLocaleString()} · Active</Text>
              <Pressable accessibilityRole="button" onPress={() => void copy()} style={styles.outlineButton}>
                <Text style={styles.outlineButtonText}>Copy invite code</Text>
              </Pressable>
            </>
          ) : null}
        </>
      ) : null}
      <Text style={styles.fieldLabel}>Have an invite?</Text>
      <TextInput
        accessibilityLabel="Invite code"
        autoCapitalize="characters"
        maxLength={8}
        onChangeText={setCode}
        placeholder="8-character code"
        placeholderTextColor={COLORS.muted}
        style={styles.textInput}
        testID="invite-code-input"
        value={code}
      />
      <Pressable
        accessibilityRole="button"
        disabled={pending || code.trim().length === 0}
        onPress={() => void accept()}
        style={styles.outlineButton}
        testID="accept-invite"
      >
        <Text style={styles.outlineButtonText}>Accept invitation</Text>
      </Pressable>
      {feedback ? (
        <Text accessibilityRole="alert" style={styles.bodyText}>
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
        <Text accessibilityRole="header" style={styles.title}>
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
  runtimeClient,
}: {
  clock: () => number;
  runtimeClient: RuntimeClient | null;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      style={styles.homeScroll}
      testID="home-scroll"
    >
      <AppHeader />

      <RuntimeStatusCard client={runtimeClient} />

      <DemoProfilePicker />

      <CapsuleSummary clock={clock} />

      <View style={styles.section}>
        <Text style={styles.label}>SEALED MOMENTS</Text>
        <View accessibilityLabel="Three sealed local demo moments" style={styles.momentRow}>
          {lockedMoments.map((moment) => (
            <View
              accessible
              accessibilityLabel={`Locked demo moment ${moment} of 3`}
              key={moment}
              style={styles.momentPlaceholder}
            >
              <Text style={styles.lockedText}>LOCKED</Text>
            </View>
          ))}
        </View>
      </View>

      <Pressable
        accessibilityLabel="Add a moment"
        accessibilityRole="button"
        accessibilityState={{ disabled: true }}
        disabled
        style={styles.disabledButton}
      >
        <Text style={styles.disabledButtonText}>Add a moment</Text>
      </Pressable>
      <Text style={styles.helperText} testID="home-content-end">
        Camera capture stays local and starts from the Camera tab.
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
        <Text accessibilityRole="header" style={styles.title}>
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
  onNavigate,
}: {
  activeRoute: RouteKey;
  onNavigate: (route: RouteKey) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.navigation} testID="main-navigation">
      {ROUTES.map((route) => {
        const isSelected = route.key === activeRoute;

        return (
          <Pressable
            accessibilityHint={`Shows the ${route.label} area`}
            accessibilityLabel={route.label}
            accessibilityRole="tab"
            accessibilityState={{ selected: isSelected }}
            key={route.key}
            onPress={() => onNavigate(route.key)}
            style={[styles.tab, isSelected && styles.selectedTab]}
            testID={`nav-${route.key}`}
          >
            <Text style={[styles.tabLabel, isSelected && styles.selectedTabLabel]}>
              {route.label}
            </Text>
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
  wordmark: {
    color: COLORS.ink,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 2,
  },
  demoBadge: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.accent,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  demoBadgeText: {
    color: COLORS.accent,
    fontSize: 10,
    fontWeight: '700',
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
  tabState: {
    color: COLORS.accent,
    fontSize: 8,
    fontWeight: '700',
    marginTop: 4,
  },
  activeShell: { flex: 1 },
  entryContent: { flexGrow: 1, gap: 24, padding: 24, paddingBottom: 36 },
  entryIntro: { gap: 8 },
  entryChoices: { gap: 12 },
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
    backgroundColor: 'rgba(29, 27, 30, 0.82)',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: COLORS.paper,
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
