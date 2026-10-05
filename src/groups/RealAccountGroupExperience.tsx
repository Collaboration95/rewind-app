import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as Clipboard from 'expo-clipboard';
import { Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

import { useRealAccount } from '../auth/RealAccountProvider';
import type { InviteLinkPayload } from '../invites/deep-links';
import { VideoCaptureScreen } from '../capture/VideoCaptureScreen';
import { CameraCaptureScreen } from '../capture/CameraCaptureScreen';
import { RealAccountChatScreen } from '../chat/RealAccountChatScreen';
import { useRealChatUnread } from '../chat/real-chat-client';
import { useComposerKeyboard } from '../chat/use-composer-keyboard';
import type { ContributionLedgerPage } from '../domain/contributions';
import {
  ContributionStatusProvider,
  type ContributionStatus,
} from '../capture/contribution-status';
import { createRealAccountVideoRuntimeClient } from '../capture/real-account-video-runtime';
import { DEFAULT_CAPTURE_MODE, type PendingClipUpload } from '../domain/video';
import {
  createPrivateReminderClient,
  type PrivateReminderClient,
} from '../reminders/private-reminder-client';
import { subscribeToReminderIntents } from '../reminders/reminder-intents';
import { createRealAccountArchiveClient } from '../auth/real-account-client';
import { ArchiveScreen } from '../real/Archive';
import { FilmScreen } from '../real/Film';
import { markEnd, markLaunchReady, markStart } from '../runtime/timing';
import { CreateGroupScreen, JoinScreen, type NewGroupInput } from '../real/GroupFlows';
import { HomeBody, HomeState, LoadingState } from '../real/Home';
import {
  cycleWeek,
  daysUntil,
  filmCountdown,
  homeCards,
  momentDay,
  premiereLeft,
  premiereRelease,
  shutterState,
} from '../real/home-model';
import { MomentsScreen, weekMoments } from '../real/Moments';
import { listBlocked } from '../real/safety';
import { SettingsScreen, type SettingsStep } from '../real/Settings';
import {
  Dock,
  GroupMenu,
  ScreenFades,
  TabColumn,
  TopBar,
  type MenuGroup,
  type ShellTab,
} from '../real/Shell';
import { Button, Glass, Glow, rw, useNow, useScreenInsets, useToast } from '../ui/primitives';
import { FONT, LAYOUT, WARM } from '../ui/tokens';

type PhotoJobStatus = PendingClipUpload['job']['status'];
type PhotoStatusDetails = Pick<
  ContributionStatus,
  'contributionId' | 'createdAt' | 'durationSeconds' | 'jobId'
>;

export function photoContributionStatusForJob(
  status: PhotoJobStatus,
  details: PhotoStatusDetails,
): ContributionStatus {
  if (status === 'ready') return { state: 'sealed', ...details, retryable: false };
  if (status === 'failed' || status === 'cancelled') {
    return {
      state: 'failed',
      ...details,
      message: 'The photo could not be processed. Retry this contribution.',
      retryable: true,
    };
  }
  return {
    state: status === 'pending' ? 'queued' : 'processing',
    ...details,
    retryable: false,
  };
}

interface RealInvite extends InviteLinkPayload {
  id: string;
  groupId: string;
  status: 'active';
  createdAt: string;
}

function displayInviteCode(code: string): string {
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{6}$/.test(normalized)
    ? `${normalized.slice(0, 3)}-${normalized.slice(3)}`
    : normalized;
}

interface RealGroup {
  memberId?: string;
  group: {
    id: string;
    name: string;
    role: 'owner' | 'member';
    maxMembers: number;
    timeZone?: string;
  };
  cycle: {
    id: string;
    prompt: string;
    startsAt: string;
    endsAt: string;
    quota: { maxCount: number; maxSeconds: number };
    contributionUsage: { countUsed: number; secondsUsed: number };
    contributionCount: number;
  };
  releases?: RealGroupRelease[];
}

interface RealGroupRelease {
  cycleId: string;
  endsAt: string;
  publishedAt: string | null;
  state: 'processing' | 'delayed' | 'premiere' | 'archived';
}

interface RealGroupMembers {
  group: { id: string; name: string };
  members: { memberId: string; displayName: string; role: 'owner' | 'member'; joinedAt: string }[];
  pendingInviteCount: number;
}

async function readGroup(response: Response): Promise<RealGroup | null> {
  if (!response.ok) throw new Error('Your group could not be loaded. Retry when connected.');
  const body = (await response.json()) as { group?: RealGroup | null };
  return body.group ?? null;
}

async function readGroupMembers(response: Response): Promise<RealGroupMembers> {
  if (!response.ok) throw new Error('Group members could not be loaded. Retry when connected.');
  return (await response.json()) as RealGroupMembers;
}

type Push =
  | { kind: 'settings'; step: SettingsStep }
  | { kind: 'mine' }
  | { kind: 'capture' }
  | { kind: 'join' }
  | { kind: 'create' }
  | { kind: 'film'; cycleId: string; label: string };

export function RealAccountGroupExperience({
  displayName,
  inviteIntent,
}: {
  displayName: string;
  inviteIntent?: (InviteLinkPayload & { groupId: string }) | null;
  inviteWebOrigin?: string;
}) {
  const auth = useRealAccount();
  const toast = useToast();
  const insets = useScreenInsets();
  const now = useNow();
  const [group, setGroup] = useState<RealGroup | null>(null);
  const [transferMode, setTransferMode] = useState<'server' | 'direct'>('server');
  const mediaClient = useMemo(
    () => createRealAccountVideoRuntimeClient(auth.authenticatedRequest, { transferMode }),
    [auth.authenticatedRequest, transferMode],
  );
  const [captureMode, setCaptureMode] = useState<'photo' | 'video'>('photo');
  const loadContributionLedger = useCallback(
    () =>
      group
        ? mediaClient.getContributionLedger(group.group.id)
        : Promise.reject(new Error('No active group.')),
    [group, mediaClient],
  );
  const [memberGroups, setMemberGroups] = useState<RealGroup[]>([]);
  const [groupMembers, setGroupMembers] = useState<RealGroupMembers | null>(null);
  const [groupMembersError, setGroupMembersError] = useState<string | null>(null);
  const groupContextVersion = useRef(0);
  const groupMembersRequest = useRef(0);
  const groupMutationPending = useRef(false);
  const selectedGroupId = useRef<string | null>(null);
  const [screen, setScreen] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tab, setTab] = useState<ShellTab>('home');
  const [stack, setStack] = useState<Push[]>([]);
  const top = stack[stack.length - 1] ?? null;
  const chatKeyboard = useComposerKeyboard(tab === 'chat' && !top);
  const pushScreen = useCallback((next: Push) => setStack((current) => [...current, next]), []);
  const popScreen = useCallback(() => setStack((current) => current.slice(0, -1)), []);
  const replaceScreen = (next: Push) => setStack((current) => [...current.slice(0, -1), next]);
  const [menuOpen, setMenuOpen] = useState(false);
  const goHome = useCallback(() => {
    setStack([]);
    setTab('home');
    setMenuOpen(false);
  }, []);
  const [rollKey, setRollKey] = useState(0);
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinFeedback, setJoinFeedback] = useState<string | null>(null);
  const [joinedName, setJoinedName] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set());
  const [chatUnreadAtOpen, setChatUnreadAtOpen] = useState(0);
  const archiveClient = useMemo(
    () =>
      auth.baseUrl ? createRealAccountArchiveClient(auth.baseUrl, auth.authenticatedRequest) : null,
    [auth.authenticatedRequest, auth.baseUrl],
  );
  const [ledger, setLedger] = useState<ContributionLedgerPage | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const ledgerRequest = useRef(0);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [invite, setInvite] = useState<RealInvite | null>(null);
  const [inviteFeedback, setInviteFeedback] = useState<string | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  const [acceptPending, setAcceptPending] = useState(false);
  const [capturePending, setCapturePending] = useState(false);
  const captureRequest = useRef(0);
  const captureMounted = useRef(true);
  const captureAccount = useRef(auth.session?.account.id);
  const [reminderRevision, setReminderRevision] = useState(0);
  const reminderContext = useRef({
    accountId: auth.session?.account.id,
    request: auth.authenticatedRequest,
    groupId: group?.group.id,
    revision: reminderRevision,
  });
  useLayoutEffect(() => {
    reminderContext.current = {
      accountId: auth.session?.account.id,
      request: auth.authenticatedRequest,
      groupId: group?.group.id,
      revision: reminderRevision,
    };
  }, [auth.session?.account.id, auth.authenticatedRequest, group?.group.id, reminderRevision]);
  const [reminderScope, setReminderScope] = useState<{
    client: PrivateReminderClient;
    accountId: string;
    groupId: string;
    request: typeof auth.authenticatedRequest;
    revision: number;
  } | null>(null);
  const reminderClient =
    reminderScope &&
    reminderScope.accountId === auth.session?.account.id &&
    reminderScope?.groupId === group?.group.id &&
    reminderScope?.request === auth.authenticatedRequest &&
    reminderScope?.revision === reminderRevision
      ? reminderScope.client
      : null;
  useEffect(() => {
    let active = true;
    const accountId = auth.session?.account.id;
    const groupId = group?.group.id;
    if (!accountId || !groupId) return;
    const request = auth.authenticatedRequest;
    const version = groupContextVersion.current;
    const client = createPrivateReminderClient({
      accountId,
      groupId,
      authenticatedRequest: request,
      isCurrentContext: () =>
        captureMounted.current &&
        version === groupContextVersion.current &&
        reminderContext.current.accountId === accountId &&
        reminderContext.current.request === request &&
        reminderContext.current.groupId === groupId &&
        reminderContext.current.revision === reminderRevision &&
        selectedGroupId.current === groupId,
    });
    void Promise.resolve().then(() => {
      if (active)
        setReminderScope({ client, accountId, groupId, request, revision: reminderRevision });
    });
    return () => {
      active = false;
      void client.revoke();
    };
  }, [auth.session?.account.id, auth.authenticatedRequest, group?.group.id, reminderRevision]);

  const revokeReminderBeforeGroupChange = async () => {
    const accountId = auth.session?.account.id;
    const request = auth.authenticatedRequest;
    const groupId = selectedGroupId.current;
    const version = groupContextVersion.current;
    if (!reminderClient) {
      if (auth.session?.account.id && group)
        throw new Error('Device reminder support is still being checked. Retry shortly.');
      return;
    }
    const result = await reminderClient.revoke();
    if (
      !captureMounted.current ||
      reminderContext.current.accountId !== accountId ||
      reminderContext.current.request !== request ||
      selectedGroupId.current !== groupId ||
      groupContextVersion.current !== version
    )
      throw new Error('Your group context changed. Open the current group and retry.');
    if (result.state !== 'revoked')
      throw new Error('Device reminder removal is unconfirmed. Check reminder support and retry.');
  };
  const signOut = () => {
    const context = reminderContext.current;
    const version = groupContextVersion.current;
    // Fence pending opt-ins immediately. Server session revocation stops sends;
    // a network-dependent device cleanup must not delay native privacy closure.
    const removal = reminderClient?.revoke();
    void Promise.allSettled([removal, auth.signOut()]).then(() => {
      // Browser revocation or native recovery-marker persistence can fail and
      // retain this session. Replace its closed client after cleanup settles;
      // durable unconfirmed-removal metadata is recovered by the new client.
      if (
        captureMounted.current &&
        groupContextVersion.current === version &&
        reminderContext.current.accountId === context.accountId &&
        reminderContext.current.request === context.request &&
        reminderContext.current.groupId === context.groupId &&
        reminderContext.current.revision === context.revision
      )
        setReminderRevision((revision) => revision + 1);
    });
  };
  const currentMutationAccount = () =>
    captureMounted.current &&
    reminderContext.current.accountId === auth.session?.account.id &&
    reminderContext.current.request === auth.authenticatedRequest;
  useEffect(() => {
    let active = true;
    const request = auth.authenticatedRequest;
    const accountId = auth.session?.account.id;
    if (!accountId) return;
    const unsubscribe = subscribeToReminderIntents(async (intent) => {
      const context = groupContextVersion.current;
      try {
        const response = await request('/real/groups/current');
        const current = await readGroup(response);
        if (
          !active ||
          !captureMounted.current ||
          context !== groupContextVersion.current ||
          reminderContext.current.accountId !== accountId ||
          reminderContext.current.request !== request
        )
          return;
        if (
          current?.group.id === intent.groupId &&
          (!selectedGroupId.current || selectedGroupId.current === intent.groupId)
        ) {
          selectedGroupId.current = current.group.id;
          setMessage(null);
          setGroup(current);
          setScreen('ready');
          goHome();
        } else {
          setMessage('This reminder is for another group. Choose a group you belong to.');
        }
      } catch {
        if (
          active &&
          captureMounted.current &&
          context === groupContextVersion.current &&
          reminderContext.current.accountId === accountId &&
          reminderContext.current.request === request
        )
          setMessage('Your reminder could not be opened. Reconnect and check your current group.');
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [auth.session?.account.id, auth.authenticatedRequest, goHome]);

  useEffect(() => {
    captureMounted.current = true;
    return () => {
      captureMounted.current = false;
      captureRequest.current += 1;
    };
  }, []);
  useEffect(() => {
    captureAccount.current = auth.session?.account.id;
  }, [auth.session?.account.id]);
  useEffect(() => () => mediaClient.dispose(), [mediaClient]);
  useEffect(() => {
    if (top?.kind !== 'capture') mediaClient.cancelDirectTransfers();
    return () => mediaClient.cancelDirectTransfers();
  }, [mediaClient, top?.kind, group?.group.id, auth.session?.account.id]);

  const openCapture = async () => {
    if (!group) return;
    const request = ++captureRequest.current;
    const context = groupContextVersion.current;
    const groupId = group.group.id;
    const accountId = auth.session?.account.id;
    setCapturePending(true);
    setMessage(null);
    try {
      const response = await auth.authenticatedRequest('/real/media/config?uploadProtocol=2');
      let mode: 'server' | 'direct' = 'server';
      if (response.status !== 404) {
        if (!response.ok)
          throw new Error(
            'Capture settings are unavailable. Reconnect or sign in again, then retry.',
          );
        const config = (await response.json()) as { directTransfer?: unknown };
        if (typeof config.directTransfer !== 'boolean')
          throw new Error('Capture settings could not be verified. Retry when connected.');
        mode = config.directTransfer ? 'direct' : 'server';
      }
      if (
        !captureMounted.current ||
        request !== captureRequest.current ||
        context !== groupContextVersion.current ||
        selectedGroupId.current !== groupId ||
        captureAccount.current !== accountId
      )
        return;
      setTransferMode(mode);
      setMenuOpen(false);
      pushScreen({ kind: 'capture' });
    } catch (error) {
      if (
        captureMounted.current &&
        request === captureRequest.current &&
        context === groupContextVersion.current
      )
        setMessage(
          error instanceof Error
            ? error.message
            : 'Capture settings are unavailable. Retry when connected.',
        );
    } finally {
      if (captureMounted.current && request === captureRequest.current) setCapturePending(false);
    }
  };

  const loadGroupMembers = useCallback(
    async (groupId: string, contextVersion: number, quiet = false) => {
      if (contextVersion !== groupContextVersion.current || selectedGroupId.current !== groupId)
        return;
      const requestId = ++groupMembersRequest.current;
      // A quiet refresh keeps the current list on screen until the new one arrives.
      if (!quiet) {
        setGroupMembers(null);
        setGroupMembersError(null);
      }
      try {
        const response = await auth.authenticatedRequest(
          `/real/groups/${encodeURIComponent(groupId)}/members`,
        );
        const summary = await readGroupMembers(response);
        if (summary.group.id !== groupId)
          throw new Error('Group members could not be matched to the selected group.');
        if (
          contextVersion === groupContextVersion.current &&
          selectedGroupId.current === groupId &&
          requestId === groupMembersRequest.current
        )
          setGroupMembers(summary);
      } catch (error) {
        if (
          !quiet &&
          contextVersion === groupContextVersion.current &&
          selectedGroupId.current === groupId &&
          requestId === groupMembersRequest.current
        )
          setGroupMembersError(
            error instanceof Error ? error.message : 'Group members could not be loaded.',
          );
      }
    },
    [auth],
  );

  const load = useCallback(async () => {
    const contextVersion = groupContextVersion.current;
    markStart('home-load');
    try {
      const [currentResponse, membershipsResponse] = await Promise.all([
        auth.authenticatedRequest('/real/groups/current'),
        auth.authenticatedRequest('/real/groups'),
      ]);
      const result = await readGroup(currentResponse);
      if (!membershipsResponse.ok)
        throw new Error('Your groups could not be loaded. Retry when connected.');
      const memberships = (await membershipsResponse.json()) as { groups?: RealGroup[] };
      if (contextVersion !== groupContextVersion.current) return;
      setMemberGroups(memberships.groups ?? []);
      selectedGroupId.current = result?.group.id ?? null;
      setGroup(result);
      setScreen('ready');
      markEnd('home-load');
      markLaunchReady();
      if (result) await loadGroupMembers(result.group.id, contextVersion);
      else {
        groupMembersRequest.current += 1;
        setGroupMembers(null);
        setGroupMembersError(null);
      }
    } catch (error) {
      if (contextVersion !== groupContextVersion.current) return;
      setMessage(error instanceof Error ? error.message : 'Your group could not be loaded.');
      setScreen('error');
    }
  }, [auth, loadGroupMembers]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const ledgerGroupId = group?.group.id ?? null;
  const refreshLedger = useCallback(async (): Promise<ContributionLedgerPage | null> => {
    if (!ledgerGroupId) return null;
    const requestId = ++ledgerRequest.current;
    try {
      const page = await mediaClient.getContributionLedger(ledgerGroupId);
      if (requestId !== ledgerRequest.current || selectedGroupId.current !== ledgerGroupId)
        return null;
      setLedger(page);
      setLedgerError(null);
      return page;
    } catch {
      if (requestId === ledgerRequest.current)
        setLedgerError('Your moments could not be loaded. Retry when connected.');
      return null;
    }
  }, [ledgerGroupId, mediaClient]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      setLedger(null);
      return refreshLedger();
    });
  }, [refreshLedger]);

  // Blocked people are fetched when Members opens; the server already hides
  // their messages and moments everywhere else.
  const membersOpen = top?.kind === 'settings' && top.step === 'members';
  useEffect(() => {
    if (!membersOpen) return;
    let active = true;
    void listBlocked(auth.authenticatedRequest)
      .then((ids) => {
        if (active) setBlocked(ids);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [auth.authenticatedRequest, membersOpen]);

  const closeCapture = () => {
    const before = ledger?.allowance.countUsed ?? 0;
    popScreen();
    void refreshLedger().then((page) => {
      // A moment was sealed: the allowance row rolls and the shutter says "Sealed".
      if (page && page.allowance.countUsed > before) setRollKey((key) => key + 1);
    });
  };

  const create = async ({ name: cleanName, prompt: cleanPrompt, maxMembers }: NewGroupInput) => {
    if (groupMutationPending.current) return;
    groupMutationPending.current = true;
    setPending(true);
    setCreateError(null);
    try {
      await revokeReminderBeforeGroupChange();
      const response = await auth.authenticatedRequest('/real/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName, prompt: cleanPrompt, maxMembers }),
      });
      if (!response.ok)
        throw new Error('The group could not be created. Check the details and retry.');
      const created = (await response.json()) as RealGroup;
      if (!currentMutationAccount()) return;
      const contextVersion = ++groupContextVersion.current;
      selectedGroupId.current = created.group.id;
      setGroup(created);
      setMemberGroups((current) => [...current, created]);
      setScreen('ready');
      goHome();
      toast(`Created “${created.group.name}”.`);
      await loadGroupMembers(created.group.id, contextVersion);
    } catch (error) {
      if (currentMutationAccount())
        setCreateError(error instanceof Error ? error.message : 'The group could not be created.');
    } finally {
      groupMutationPending.current = false;
      if (currentMutationAccount()) {
        setPending(false);
        setReminderRevision((value) => value + 1);
      }
    }
  };

  const createInvitation = async () => {
    if (!group || group.group.role !== 'owner') return;
    setInvitePending(true);
    setInviteFeedback(null);
    try {
      const response = await auth.authenticatedRequest(
        `/real/groups/${encodeURIComponent(group.group.id)}/invites`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      const body = (await response.json()) as { invite?: RealInvite; message?: string };
      if (!response.ok || !body.invite) {
        throw new Error(
          body.message ?? 'The invitation could not be created. Retry when connected.',
        );
      }
      setInvite(body.invite);
    } catch (error) {
      setInviteFeedback(
        error instanceof Error ? error.message : 'The invitation could not be created.',
      );
    } finally {
      setInvitePending(false);
    }
  };

  const revokeInvitation = async () => {
    if (!group || !invite || group.group.role !== 'owner' || invitePending) return;
    setInvitePending(true);
    setInviteFeedback(null);
    try {
      const response = await auth.authenticatedRequest(
        `/real/groups/${encodeURIComponent(group.group.id)}/invites/${encodeURIComponent(invite.id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) throw new Error('The invitation could not be revoked. Try again.');
      setInvite(null);
      toast('Code revoked. Make a new one when you need it.');
      await loadGroupMembers(group.group.id, groupContextVersion.current);
    } catch (error) {
      setInviteFeedback(
        error instanceof Error ? error.message : 'The invitation could not be revoked.',
      );
    } finally {
      setInvitePending(false);
    }
  };

  const copyInvitation = async () => {
    if (!invite) return;
    try {
      await Clipboard.setStringAsync(displayInviteCode(invite.code));
      setInviteFeedback(null);
      toast('Invitation code copied.');
    } catch {
      setInviteFeedback('Copy is unavailable here. Select the invitation code to copy it.');
    }
  };

  const shareInvitation = async () => {
    if (!invite) return;
    try {
      await Share.share({
        message: `Join my Rewind group with code ${displayInviteCode(invite.code)}. Open Rewind and choose Have an invite?`,
      });
      setInviteFeedback(null);
    } catch {
      setInviteFeedback('Share is unavailable here. Copy the invitation code to share it.');
    }
  };

  const acceptInvitation = async (rawCode: string, requestedGroupId?: string) => {
    if (acceptPending || groupMutationPending.current) return;
    const code = rawCode.replace(/[\s-]/g, '').toUpperCase();
    if (!/^(?:[A-Z]{6}|[A-Z0-9]{8})$/.test(code)) {
      setJoinFeedback('Enter the six-letter invitation code, like ABC-DEF.');
      return;
    }
    groupMutationPending.current = true;
    setAcceptPending(true);
    setJoinFeedback(null);
    try {
      await revokeReminderBeforeGroupChange();
      const response = await auth.authenticatedRequest('/real/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, ...(requestedGroupId ? { groupId: requestedGroupId } : {}) }),
      });
      const body = (await response.json()) as {
        status?: string;
        group?: RealGroup;
        message?: string;
      };
      if (!response.ok || !body.group) {
        throw new Error(body.message ?? 'The invitation could not be accepted.');
      }
      if (!currentMutationAccount()) return;
      const contextVersion = ++groupContextVersion.current;
      selectedGroupId.current = body.group.group.id;
      setGroup(body.group);
      setInvite(null);
      await loadGroupMembers(body.group.group.id, contextVersion);
      setMemberGroups((current) =>
        current.some((membership) => membership.group.id === body.group?.group.id)
          ? current
          : [...current, body.group!],
      );
      setScreen('ready');
      if (requestedGroupId) goHome();
      else setJoinedName(body.group.group.name);
    } catch (error) {
      if (currentMutationAccount())
        setJoinFeedback(
          error instanceof Error ? error.message : 'The invitation could not be accepted.',
        );
    } finally {
      groupMutationPending.current = false;
      if (currentMutationAccount()) {
        setAcceptPending(false);
        setReminderRevision((value) => value + 1);
      }
    }
  };

  const switchGroup = async (groupId: string): Promise<boolean> => {
    if (pending || acceptPending || groupMutationPending.current) return false;
    groupMutationPending.current = true;
    const previousGroupId = selectedGroupId.current;
    let contextVersion = groupContextVersion.current;
    setPending(true);
    setMessage(null);
    try {
      await revokeReminderBeforeGroupChange();
      contextVersion = ++groupContextVersion.current;
      const response = await auth.authenticatedRequest('/real/groups/current', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });
      const selected = await readGroup(response);
      if (!selected) throw new Error('That group is not available to this account.');
      if (contextVersion !== groupContextVersion.current || !currentMutationAccount()) return false;
      selectedGroupId.current = selected.group.id;
      setGroup(selected);
      setInvite(null);
      setTab('home');
      await loadGroupMembers(selected.group.id, contextVersion);
      return true;
    } catch (error) {
      if (contextVersion !== groupContextVersion.current || !currentMutationAccount()) return false;
      setMessage(error instanceof Error ? error.message : 'The group could not be selected.');
      if (previousGroupId) await loadGroupMembers(previousGroupId, contextVersion);
      return false;
    } finally {
      groupMutationPending.current = false;
      if (currentMutationAccount()) {
        if (contextVersion === groupContextVersion.current) setPending(false);
        setReminderRevision((value) => value + 1);
      }
    }
  };

  const captureView = group ? (
    <ContributionStatusProvider
      scope={{
        sessionId: 'real-account-session',
        groupId: group.group.id,
        memberId: auth.session?.account.id ?? '',
      }}
      loadStatus={loadContributionLedger}
    >
      {captureMode === 'photo' ? (
        <CameraCaptureScreen
          allowance={ledger?.allowance ?? null}
          groupName={group.group.name}
          onBack={closeCapture}
          onRecordClip={() => setCaptureMode('video')}
          onSubmitPhoto={async (
            metadata,
            base64,
            onProgress,
            replacesContributionId,
            look = { mode: DEFAULT_CAPTURE_MODE, clientProcessed: false },
          ) => {
            if (!mediaClient.uploadClip || !mediaClient.processClipJob) {
              throw new Error('Photo contribution upload is unavailable. Retry shortly.');
            }
            const { mimeType } = metadata;
            // Client-graded bytes differ per look, so each look gets its own key.
            const idempotencyKey = look.clientProcessed
              ? `${metadata.id}-${look.mode}`
              : metadata.id;
            const staged = await mediaClient.stagePhotoSource(
              'real-account-session',
              group.group.id,
              idempotencyKey,
              base64,
              mimeType,
            );
            const upload = await mediaClient.uploadClip('real-account-session', group.group.id, {
              mediaType: 'photo',
              idempotencyKey,
              sourceUri: staged.uri,
              mimeType,
              byteLength: staged.byteLength,
              durationSeconds: 3,
              width: metadata.width,
              height: metadata.height,
              hasAudio: true,
              mode: look.mode,
              ...(look.clientProcessed ? { clientProcessed: true } : {}),
              trimStartSeconds: 0,
              trimEndSeconds: 3,
              ...(replacesContributionId ? { replacesContributionId } : {}),
            });
            const sharedStatus = {
              contributionId: upload.contribution.id,
              jobId: upload.job.id,
              durationSeconds: 3,
              createdAt: upload.contribution.createdAt,
              retryable: true,
            };
            onProgress({ state: 'queued', ...sharedStatus });
            onProgress({ state: 'processing', ...sharedStatus });
            const job = await mediaClient.processClipJob(
              'real-account-session',
              group.group.id,
              upload.job.id,
            );
            const finalStatus = photoContributionStatusForJob(job.status, sharedStatus);
            onProgress(finalStatus);
            if (finalStatus.state === 'failed') {
              throw new Error(
                finalStatus.message ?? 'The photo could not be processed. Retry this photo.',
              );
            }
            return finalStatus;
          }}
          onDeletePhotoContribution={(contributionId) =>
            mediaClient.deleteContribution('real-account-session', group.group.id, contributionId)
          }
        />
      ) : (
        <VideoCaptureScreen
          allowance={ledger?.allowance ?? null}
          onBack={() => setCaptureMode('photo')}
          onClose={closeCapture}
          realAccount={{
            groupId: group.group.id,
            authenticatedRequest: auth.authenticatedRequest,
            transferMode,
          }}
        />
      )}
    </ContributionStatusProvider>
  ) : null;

  const signOutNotice =
    auth.notice === 'sign-out-marker-unavailable'
      ? 'Sign-out did not start because this device could not save its recovery state. You are still signed in. Retry sign out.'
      : auth.notice === 'revocation-unconfirmed'
        ? Platform.OS === 'web'
          ? 'We could not confirm sign-out. You are still signed in on this browser; retry when the service is reachable.'
          : 'This device signed out, but server revocation was not confirmed. Another device may remain signed in until expiry or account reset.'
        : null;
  const signOutLabel = auth.pending
    ? 'Signing out…'
    : signOutNotice
      ? 'Retry sign out'
      : 'Sign out';

  const chatUnread = useRealChatUnread({
    groupId: screen === 'ready' ? (group?.group.id ?? null) : null,
    memberId: group?.memberId ?? null,
    chatActive: tab === 'chat' && !top,
  });
  const week = group ? cycleWeek(group.cycle, now) : null;
  const moments = weekMoments(ledger, week?.windowStart ?? 0);
  const failedMoment = moments.find((entry) => entry.state === 'failed') ?? null;
  const allowance = ledger?.allowance ?? null;
  const shutter = group && week ? shutterState(allowance, week.resetDays) : null;
  const premiere = group ? premiereRelease(group.releases, group.cycle.id) : undefined;
  const menuGroups: MenuGroup[] = memberGroups.map((membership) => ({
    id: membership.group.id,
    name: membership.group.name,
  }));
  if (group && !menuGroups.some((item) => item.id === group.group.id))
    menuGroups.unshift({ id: group.group.id, name: group.group.name });

  const watchPremiere = () => {
    if (premiere)
      pushScreen({
        kind: 'film',
        cycleId: premiere.cycleId,
        label: `Premiere · ${premiereLeft(premiere, now)}`,
      });
  };
  const pickGroup = async (groupId: string) => {
    setMenuOpen(false);
    const name = memberGroups.find((membership) => membership.group.id === groupId)?.group.name;
    if ((await switchGroup(groupId)) && name) toast(`Switched to ${name}.`);
  };
  const header = (
    <TopBar
      accountName={displayName}
      groupName={group ? group.group.name : null}
      menuOpen={menuOpen}
      onOpenSettings={() => {
        setMenuOpen(false);
        pushScreen({ kind: 'settings', step: 'main' });
      }}
      onToggleMenu={() => setMenuOpen((open) => !open)}
    />
  );
  const inviteIntentCard = inviteIntent ? (
    <Glass style={styles.notice} testID="real-invite-intent">
      <Text style={styles.noticeTitle}>You have an invitation</Text>
      <Text style={styles.noticeBody}>
        Expires {new Date(inviteIntent.expiresAt).toLocaleString()}. Accept it to join this private
        group.
      </Text>
      <Button
        busy={acceptPending}
        busyLabel="Joining…"
        label="Accept invitation"
        onPress={() => void acceptInvitation(inviteIntent.code, inviteIntent.groupId)}
        testID="real-invite-accept"
        variant="primary"
      />
      {joinFeedback ? (
        <Text accessibilityRole="alert" style={styles.noticeBody} testID="real-invite-feedback">
          {joinFeedback}
        </Text>
      ) : null}
    </Glass>
  ) : null;
  const notices = (
    <>
      {inviteIntentCard}
      {signOutNotice ? (
        <Text accessibilityRole="alert" style={styles.alert} testID="logout-unconfirmed">
          {signOutNotice}
        </Text>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" style={styles.alert} testID="real-group-switch-error">
          {message}
        </Text>
      ) : null}
    </>
  );

  let body: ReactNode;
  if (screen === 'loading') body = <LoadingState header={header} />;
  else if (screen === 'error')
    body = (
      <HomeState
        action="Try again"
        actionTestID="real-group-retry"
        body="Check your connection and try again."
        dim
        header={header}
        onAction={() => {
          setMessage(null);
          setScreen('loading');
          void load();
        }}
        testID="real-group-error"
        title="Couldn’t load your group"
      />
    );
  else if (!group)
    body = (
      <HomeState
        action="Have an invite?"
        actionTestID="real-group-join-start"
        alt="Create a group"
        altTestID="real-group-create-choice"
        body="Join one with an invite code, or start your own."
        header={header}
        onAction={() => pushScreen({ kind: 'join' })}
        onAlt={() => pushScreen({ kind: 'create' })}
        primary
        testID="real-group-none"
        title="You’re not in a group yet"
      >
        {notices}
      </HomeState>
    );
  else if (tab === 'chat')
    body = (
      <View style={styles.fill}>
        <View style={[styles.pinnedHeader, { paddingTop: insets.top }]}>{header}</View>
        <RealAccountChatScreen
          key={`${group.group.id}:${group.memberId ?? ''}`}
          groupId={group.group.id}
          groupName={group.group.name}
          members={groupMembers?.members ?? []}
          memberProfilesError={groupMembersError}
          currentMemberId={group.memberId}
          blocked={blocked}
          onBlocked={(memberId) => setBlocked((current) => new Set(current).add(memberId))}
          unreadOnOpen={chatUnreadAtOpen}
          premiere={premiere ? { left: premiereLeft(premiere, now), onWatch: watchPremiere } : null}
          bottomInset={chatKeyboard.keyboardOpen ? 8 : LAYOUT.dockHeight + insets.bottom + 12}
          keyboardOpen={chatKeyboard.keyboardOpen}
          onComposerFocus={chatKeyboard.onFocus}
          onComposerBlur={chatKeyboard.onBlur}
          onUnknownAuthor={() =>
            void loadGroupMembers(group.group.id, groupContextVersion.current, true)
          }
        />
      </View>
    );
  else if (tab === 'archive')
    body = (
      <ArchiveScreen
        key={`${group.group.id}:${auth.session?.account.id ?? ''}`}
        bottomInset={LAYOUT.dockHeight + insets.bottom + 40}
        client={archiveClient}
        currentCycleId={group.cycle.id}
        daysLeft={daysUntil(group.cycle.endsAt, now)}
        groupId={group.group.id}
        header={header}
        onOpenFilm={(cycleId, label) => pushScreen({ kind: 'film', cycleId, label })}
        prompt={group.cycle.prompt}
        releases={group.releases ?? []}
        topInset={insets.top}
      />
    );
  else
    body = (
      <ScrollView
        contentContainerStyle={[styles.tabContent, { paddingTop: insets.top }]}
        showsVerticalScrollIndicator={false}
        style={styles.fill}
        testID="real-group-experience"
      >
        <HomeBody
          cards={homeCards(group.releases, group.cycle.id, Boolean(failedMoment))}
          countUsed={allowance?.countUsed ?? null}
          countdown={filmCountdown(group.cycle.endsAt, now)}
          header={header}
          maxCount={allowance?.maxCount ?? group.cycle.quota.maxCount}
          maxSeconds={allowance?.maxSeconds ?? group.cycle.quota.maxSeconds}
          moments={
            ledger
              ? moments.map((entry) => ({
                  id: entry.contributionId,
                  mediaType: entry.mediaType,
                  seconds: Math.round(entry.durationSeconds),
                  day: momentDay(entry.createdAt, now),
                  failed: entry.state === 'failed',
                }))
              : null
          }
          notices={notices}
          onOpenMoments={() => pushScreen({ kind: 'mine' })}
          onRetryFailed={() => pushScreen({ kind: 'mine' })}
          onWatch={watchPremiere}
          premiereLeft={premiere ? premiereLeft(premiere, now) : null}
          prompt={group.cycle.prompt}
          resetDays={week?.resetDays ?? 7}
          rollKey={rollKey}
          secondsUsed={allowance?.secondsUsed ?? null}
          week={week?.week ?? 1}
        />
      </ScrollView>
    );

  if (screen !== 'ready' || !group)
    body = (
      <ScrollView
        contentContainerStyle={[styles.tabContent, styles.stateContent, { paddingTop: insets.top }]}
        style={styles.fill}
      >
        {body}
      </ScrollView>
    );

  const settingsTop = top?.kind === 'settings' ? top : null;
  let pushed: ReactNode = null;
  if (top?.kind === 'capture' && group) pushed = <View style={styles.camera}>{captureView}</View>;
  else if (settingsTop)
    pushed = (
      <SettingsScreen
        account={{
          displayName,
          username: auth.session?.account.username ?? displayName,
          id: auth.session?.account.id ?? '',
        }}
        authenticatedRequest={auth.authenticatedRequest}
        blocked={blocked}
        group={group}
        groups={menuGroups}
        invite={{
          code: invite ? displayInviteCode(invite.code) : null,
          pending: invitePending,
          feedback: inviteFeedback,
          create: () => void createInvitation(),
          revoke: () => void revokeInvitation(),
          copy: () => void copyInvitation(),
          share: () => void shareInvitation(),
        }}
        members={groupMembers?.members ?? null}
        membersError={groupMembersError}
        pendingInvites={groupMembers ? groupMembers.pendingInviteCount : null}
        notice={signOutNotice}
        onBack={popScreen}
        onBlockedChange={(profileId, isBlocked) =>
          setBlocked((current) => {
            const next = new Set(current);
            if (isBlocked) next.add(profileId);
            else next.delete(profileId);
            return next;
          })
        }
        onCreate={() => pushScreen({ kind: 'create' })}
        onDeleteAccount={auth.deleteAccount}
        onGroupUpdated={(updated) =>
          setGroup((current) =>
            current ? { ...updated, releases: updated.releases ?? current.releases } : updated,
          )
        }
        onJoin={() => pushScreen({ kind: 'join' })}
        onNavigate={(step) => replaceScreen({ kind: 'settings', step })}
        onSwitchGroup={switchGroup}
        reminderClient={reminderClient}
        signOut={{ label: signOutLabel, pending: auth.pending, onSignOut: signOut }}
        step={settingsTop.step}
        switchPending={pending}
      />
    );
  else if (top?.kind === 'film' && group && archiveClient)
    pushed = (
      <FilmScreen
        client={archiveClient}
        cycleId={top.cycleId}
        groupId={group.group.id}
        isOwner={group.group.role === 'owner'}
        label={top.label}
        onChat={() => {
          setStack([]);
          setTab('chat');
        }}
        onClose={popScreen}
        request={auth.authenticatedRequest}
      />
    );
  else if (top?.kind === 'mine')
    pushed = (
      <MomentsScreen
        error={ledgerError}
        onBack={popScreen}
        onReload={() => void refreshLedger()}
        onDelete={async (entry) => {
          if (!group) return;
          await mediaClient.deleteContribution(
            'real-account-session',
            group.group.id,
            entry.contributionId,
          );
          await refreshLedger();
        }}
        onRetake={() => {
          popScreen();
          void openCapture();
        }}
        onRetry={async (entry) => {
          if (!group || !entry.jobId || !mediaClient.processClipJob) return;
          await mediaClient.processClipJob('real-account-session', group.group.id, entry.jobId);
          await refreshLedger();
        }}
        page={ledger}
        resetDays={week?.resetDays ?? 7}
        windowStart={week?.windowStart ?? 0}
      />
    );
  else if (top?.kind === 'join')
    pushed = (
      <JoinScreen
        error={joinFeedback}
        joinedName={joinedName}
        onBack={() => {
          setJoinFeedback(null);
          setJoinedName(null);
          popScreen();
        }}
        onGoToGroup={() => {
          setJoinedName(null);
          goHome();
        }}
        onJoin={(code) => void acceptInvitation(code)}
        pending={acceptPending}
      />
    );
  else if (top?.kind === 'create')
    pushed = (
      <CreateGroupScreen
        error={createError}
        onBack={() => {
          setCreateError(null);
          popScreen();
        }}
        onCreate={(input) => void create(input)}
        pending={pending}
      />
    );

  const docked = screen === 'ready' && group;
  return (
    <View
      style={[
        styles.root,
        chatKeyboard.keyboardOpen && { maxHeight: chatKeyboard.height ?? undefined },
      ]}
      testID="real-group-shell"
      {...rw('clip')}
    >
      {tab === 'home' || !group ? <Glow /> : null}
      <TabColumn>{body}</TabColumn>
      {docked && !chatKeyboard.keyboardOpen ? <ScreenFades /> : null}
      {docked && !chatKeyboard.keyboardOpen ? (
        <Dock
          active={tab}
          chatUnread={chatUnread}
          newFilm={Boolean(premiere)}
          onSelect={(next) => {
            setMenuOpen(false);
            if (next === 'chat' && tab !== 'chat') setChatUnreadAtOpen(chatUnread);
            setTab(next);
          }}
          onShutter={() => void openCapture()}
          shutter={shutter}
          shutterPending={capturePending}
          sealedTip={rollKey}
        />
      ) : null}
      {menuOpen && group ? (
        <GroupMenu
          currentId={group.group.id}
          disabled={pending}
          groups={menuGroups}
          onClose={() => setMenuOpen(false)}
          onCreate={() => {
            setMenuOpen(false);
            pushScreen({ kind: 'create' });
          }}
          onJoin={() => {
            setMenuOpen(false);
            pushScreen({ kind: 'join' });
          }}
          onPick={(groupId) => void pickGroup(groupId)}
        />
      ) : null}
      {pushed ? (
        <View key={stack.length} style={styles.pushed} {...rw('push')}>
          {pushed}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: WARM.bg, flex: 1, overflow: 'hidden' },
  fill: { flex: 1 },
  tabContent: { paddingBottom: 150, paddingHorizontal: LAYOUT.gutter },
  stateContent: { paddingBottom: 40 },
  pinnedHeader: { paddingHorizontal: LAYOUT.gutter },
  pushed: { ...StyleSheet.absoluteFill, zIndex: 10 },
  camera: { backgroundColor: '#000', flex: 1 },
  notice: { gap: 8, marginBottom: 14, padding: 18 },
  noticeTitle: { color: WARM.ink, fontFamily: FONT.body, fontSize: 16, fontWeight: '600' },
  noticeBody: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13.5, lineHeight: 19 },
  alert: {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderColor: 'rgba(194, 69, 47, 0.35)',
    borderRadius: 14,
    borderWidth: 1,
    color: '#6b2a1a',
    fontFamily: FONT.body,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
});
