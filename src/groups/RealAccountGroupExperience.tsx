import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { useRealAccount } from '../auth/RealAccountProvider';
import { BUILT_IN_PROMPTS, GROUP_NAME_MAX_LENGTH, PROMPT_MAX_LENGTH } from '../domain/groups';
import { createInviteLink, type InviteLinkPayload } from '../invites/deep-links';
import { COLORS } from '../theme';
import { VideoCaptureScreen } from '../capture/VideoCaptureScreen';
import { CameraCaptureScreen } from '../capture/CameraCaptureScreen';
import { RealAccountChatScreen } from '../chat/RealAccountChatScreen';
import { ContributionLedgerSection } from '../contributions/ContributionLedgerSection';
import type { ContributionLedgerAllowance, ContributionLedgerPage } from '../domain/contributions';
import {
  ContributionStatusProvider,
  type ContributionStatus,
} from '../capture/contribution-status';
import { createRealAccountVideoRuntimeClient } from '../capture/real-account-video-runtime';
import type { PendingClipUpload } from '../domain/video';

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

interface RealGroup {
  memberId?: string;
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

function remainingLabel(endsAt: string): string {
  const milliseconds = Date.parse(endsAt) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'Cycle ended';
  const days = Math.ceil(milliseconds / (24 * 60 * 60 * 1000));
  return `${days} ${days === 1 ? 'day' : 'days'} remaining`;
}

export function RealAccountGroupExperience({
  displayName,
  inviteIntent,
  inviteWebOrigin,
}: {
  displayName: string;
  inviteIntent?: (InviteLinkPayload & { groupId: string }) | null;
  inviteWebOrigin?: string;
}) {
  const auth = useRealAccount();
  const mediaClient = useMemo(
    () => createRealAccountVideoRuntimeClient(auth.authenticatedRequest),
    [auth.authenticatedRequest],
  );
  const [captureMode, setCaptureMode] = useState<'photo' | 'video'>('photo');
  const [group, setGroup] = useState<RealGroup | null>(null);
  const [homeAllowance, setHomeAllowance] = useState<ContributionLedgerAllowance | null>(null);
  const loadContributionLedger = useCallback(
    () =>
      group
        ? mediaClient.getContributionLedger(group.group.id)
        : Promise.reject(new Error('No active group.')),
    [group, mediaClient],
  );
  const handleHomeLedgerPage = useCallback((page: ContributionLedgerPage | null) => {
    setHomeAllowance(page?.allowance ?? null);
  }, []);
  const [memberGroups, setMemberGroups] = useState<RealGroup[]>([]);
  const [groupMembers, setGroupMembers] = useState<RealGroupMembers | null>(null);
  const [groupMembersError, setGroupMembersError] = useState<string | null>(null);
  const groupContextVersion = useRef(0);
  const groupMembersRequest = useRef(0);
  const selectedGroupId = useRef<string | null>(null);
  const [screen, setScreen] = useState<
    'loading' | 'choices' | 'create' | 'home' | 'capture' | 'chat' | 'error'
  >('loading');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState<string>(BUILT_IN_PROMPTS[0]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [maxMembers, setMaxMembers] = useState(10);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [invite, setInvite] = useState<RealInvite | null>(null);
  const [inviteFeedback, setInviteFeedback] = useState<string | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  const [acceptPending, setAcceptPending] = useState(false);

  const loadGroupMembers = useCallback(
    async (groupId: string, contextVersion: number) => {
      if (contextVersion !== groupContextVersion.current || selectedGroupId.current !== groupId)
        return;
      const requestId = ++groupMembersRequest.current;
      setGroupMembers(null);
      setGroupMembersError(null);
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
      setScreen(result ? 'home' : 'choices');
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

  if (screen === 'capture' && group) {
    return (
      <View style={styles.captureContainer}>
        <Text style={styles.label} testID="real-group-capture-context">
          ACTIVE GROUP · {group.group.name}
        </Text>
        <View style={styles.captureModes}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setScreen('home')}
            style={styles.modeButton}
          >
            <Text style={styles.modeButtonText}>Back to group</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setCaptureMode('photo')}
            style={styles.modeButton}
          >
            <Text style={styles.modeButtonText}>Photo</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setCaptureMode('video')}
            style={styles.modeButton}
          >
            <Text style={styles.modeButtonText}>Video</Text>
          </Pressable>
        </View>
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
              onRecordClip={() => setCaptureMode('video')}
              onSubmitPhoto={async (metadata, base64, onProgress, replacesContributionId) => {
                if (!mediaClient.uploadClip || !mediaClient.processClipJob) {
                  throw new Error('Photo contribution upload is unavailable. Retry shortly.');
                }
                const { id: idempotencyKey, mimeType } = metadata;
                const staged = await mediaClient.stagePhotoSource(
                  'real-account-session',
                  group.group.id,
                  idempotencyKey,
                  base64,
                  mimeType,
                );
                const upload = await mediaClient.uploadClip(
                  'real-account-session',
                  group.group.id,
                  {
                    mediaType: 'photo',
                    idempotencyKey,
                    sourceUri: staged.uri,
                    mimeType,
                    byteLength: staged.byteLength,
                    durationSeconds: 3,
                    width: metadata.width,
                    height: metadata.height,
                    hasAudio: true,
                    mode: 'soft-focus',
                    trimStartSeconds: 0,
                    trimEndSeconds: 3,
                    ...(replacesContributionId ? { replacesContributionId } : {}),
                  },
                );
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
                mediaClient.deleteContribution(
                  'real-account-session',
                  group.group.id,
                  contributionId,
                )
              }
            />
          ) : (
            <VideoCaptureScreen
              onBack={() => setCaptureMode('photo')}
              realAccount={{
                groupId: group.group.id,
                authenticatedRequest: auth.authenticatedRequest,
              }}
            />
          )}
        </ContributionStatusProvider>
      </View>
    );
  }

  if (screen === 'chat' && group) {
    return (
      <View style={styles.captureContainer}>
        <View style={styles.brand}>
          <Text style={styles.wordmark}>REWIND</Text>
          <Text style={styles.label}>REAL ACCOUNT · {displayName}</Text>
        </View>
        <RealAccountChatScreen
          key={`${group.group.id}:${group.memberId ?? ''}`}
          groupId={group.group.id}
          groupName={group.group.name}
          members={groupMembers?.members ?? []}
          memberProfilesError={groupMembersError}
          currentMemberId={group.memberId}
          onBack={() => setScreen('home')}
        />
      </View>
    );
  }

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
      const contextVersion = ++groupContextVersion.current;
      selectedGroupId.current = created.group.id;
      setGroup(created);
      setScreen('home');
      await loadGroupMembers(created.group.id, contextVersion);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The group could not be created.');
    } finally {
      setPending(false);
    }
  };

  const createInvitation = async () => {
    if (!group || group.group.role !== 'owner') return;
    if (!inviteWebOrigin) {
      setInviteFeedback(
        'Invitation links are unavailable because this app has no configured public HTTPS web origin.',
      );
      return;
    }
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

  const inviteLink = invite
    ? createInviteLink(invite, {
        platform: 'web',
        webOrigin: inviteWebOrigin,
        groupId: invite.groupId,
      })
    : null;

  const copyInvitation = async () => {
    if (!inviteLink) return;
    try {
      await Clipboard.setStringAsync(inviteLink);
      setInviteFeedback('Invitation link copied.');
    } catch {
      setInviteFeedback('Copy is unavailable here. Select the invitation link to copy it.');
    }
  };

  const shareInvitation = async () => {
    if (!inviteLink) return;
    try {
      await Share.share({
        message: `Join my Rewind group with this invitation link: ${inviteLink}`,
        url: inviteLink,
      });
      setInviteFeedback('Invitation link ready to share.');
    } catch {
      setInviteFeedback('Share is unavailable here. Copy the invitation link to share it.');
    }
  };

  const acceptInvitation = async () => {
    if (!inviteIntent || acceptPending) return;
    setAcceptPending(true);
    setInviteFeedback(null);
    try {
      const response = await auth.authenticatedRequest('/real/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: inviteIntent.code, groupId: inviteIntent.groupId }),
      });
      const body = (await response.json()) as {
        status?: string;
        group?: RealGroup;
        message?: string;
      };
      if (!response.ok || !body.group) {
        throw new Error(body.message ?? 'The invitation could not be accepted.');
      }
      const contextVersion = ++groupContextVersion.current;
      selectedGroupId.current = body.group.group.id;
      setGroup(body.group);
      await loadGroupMembers(body.group.group.id, contextVersion);
      setMemberGroups((current) =>
        current.some((membership) => membership.group.id === body.group?.group.id)
          ? current
          : [...current, body.group!],
      );
      setScreen('home');
      setInviteFeedback('Invitation accepted. You joined the group.');
    } catch (error) {
      setInviteFeedback(
        error instanceof Error ? error.message : 'The invitation could not be accepted.',
      );
    } finally {
      setAcceptPending(false);
    }
  };

  const switchGroup = async (groupId: string) => {
    const previousGroupId = selectedGroupId.current;
    const contextVersion = ++groupContextVersion.current;
    setPending(true);
    setMessage(null);
    try {
      const response = await auth.authenticatedRequest('/real/groups/current', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });
      const selected = await readGroup(response);
      if (!selected) throw new Error('That group is not available to this account.');
      if (contextVersion !== groupContextVersion.current) return;
      selectedGroupId.current = selected.group.id;
      setGroup(selected);
      await loadGroupMembers(selected.group.id, contextVersion);
    } catch (error) {
      if (contextVersion !== groupContextVersion.current) return;
      setMessage(error instanceof Error ? error.message : 'The group could not be selected.');
      if (previousGroupId) await loadGroupMembers(previousGroupId, contextVersion);
    } finally {
      if (contextVersion === groupContextVersion.current) setPending(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} testID="real-group-experience">
      <View style={styles.brand}>
        <Text style={styles.wordmark}>REWIND</Text>
        <Text style={styles.label}>REAL ACCOUNT · {displayName}</Text>
      </View>
      {inviteIntent ? (
        <View style={styles.inviteIntent} testID="real-invite-intent">
          <Text style={styles.panelTitle}>Invitation retained</Text>
          <Text style={styles.body}>Group {inviteIntent.groupId}</Text>
          <Text style={styles.body}>
            Expires {new Date(inviteIntent.expiresAt).toLocaleString()}
          </Text>
          <Text style={styles.body}>
            Sign-in is complete. Accept the invitation to join this private group.
          </Text>
          <Action
            title={acceptPending ? 'Joining…' : 'Accept invitation'}
            disabled={acceptPending}
            onPress={() => void acceptInvitation()}
            testID="real-invite-accept"
          />
          {inviteFeedback ? (
            <Text accessibilityRole="alert" style={styles.body} testID="real-invite-feedback">
              {inviteFeedback}
            </Text>
          ) : null}
        </View>
      ) : null}
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
            title={inviteIntent ? 'Invitation shown above' : 'Open an invitation link to join'}
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
          <Text style={styles.body}>You are the first member in this private group.</Text>
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
          <Text style={styles.label} testID="real-group-active-context">
            ACTIVE GROUP · {group.group.name}
          </Text>
          <Text accessibilityRole="header" style={styles.title} testID="real-group-name-heading">
            {group.group.name}
          </Text>
          <Text style={styles.body}>Up to {group.group.maxMembers} members</Text>
          <View style={styles.invitationPanel} testID="real-group-members">
            <Text accessibilityRole="header" style={styles.label}>
              {groupMembers
                ? `MEMBERS · ${groupMembers.members.length}/${group.group.maxMembers}`
                : 'MEMBERS'}
            </Text>
            {groupMembers?.members.length ? (
              groupMembers.members.map((member, index) => (
                <Text
                  key={`${member.role}-${member.joinedAt}-${index}`}
                  accessibilityLabel={`${member.displayName}, ${member.role}`}
                  style={styles.body}
                  testID={`real-group-member-${index}`}
                >
                  {member.displayName} · {member.role === 'owner' ? 'Owner' : 'Member'}
                </Text>
              ))
            ) : (
              <Text style={styles.body} testID="real-group-members-empty">
                {groupMembers
                  ? 'No member profiles are available.'
                  : (groupMembersError ?? 'Loading group members…')}
              </Text>
            )}
            <Text style={styles.body} testID="real-group-pending-invites">
              {groupMembers?.pendingInviteCount
                ? `${groupMembers.pendingInviteCount} pending ${groupMembers.pendingInviteCount === 1 ? 'invitation' : 'invitations'}`
                : groupMembers
                  ? 'No pending invitations'
                  : groupMembersError
                    ? 'Invitation status unavailable.'
                    : 'Loading invitation status…'}
            </Text>
          </View>
          {message ? (
            <Text accessibilityRole="alert" style={styles.error} testID="real-group-switch-error">
              {message}
            </Text>
          ) : null}
          {memberGroups.length > 1 ? (
            <View style={styles.invitationPanel} testID="real-group-switcher">
              <Text style={styles.label}>YOUR GROUPS</Text>
              {memberGroups
                .filter((membership) => membership.group.id !== group.group.id)
                .map((membership) => (
                  <Action
                    key={membership.group.id}
                    title={`Switch to ${membership.group.name}`}
                    disabled={pending}
                    onPress={() => void switchGroup(membership.group.id)}
                    testID={`switch-real-group-${membership.group.id}`}
                  />
                ))}
            </View>
          ) : null}
          {group.group.role === 'owner' ? (
            <View style={styles.invitationPanel} testID="real-group-invitations">
              <Text style={styles.label}>GROUP INVITATION</Text>
              <Text style={styles.body}>
                Create a private invite link that expires in 24 hours.
              </Text>
              <Action
                title={invitePending ? 'Creating invitation…' : 'Create invitation link'}
                disabled={invitePending}
                onPress={() => void createInvitation()}
                testID="real-group-create-invite"
              />
              {invite ? (
                <>
                  <Text style={styles.body} testID="real-group-invite-expiry">
                    Expires {new Date(invite.expiresAt).toLocaleString()} · Active
                  </Text>
                  {inviteLink ? (
                    <>
                      <Text selectable style={styles.body} testID="real-group-invite-link">
                        {inviteLink}
                      </Text>
                      <Action
                        title="Copy invitation link"
                        onPress={() => void copyInvitation()}
                        testID="real-group-copy-invite"
                      />
                      <Action
                        title="Share invitation link"
                        onPress={() => void shareInvitation()}
                        testID="real-group-share-invite"
                      />
                    </>
                  ) : (
                    <Text accessibilityRole="alert" style={styles.error}>
                      A secure HTTPS link is unavailable. Connect the app to its HTTPS web origin.
                    </Text>
                  )}
                </>
              ) : null}
              {inviteFeedback ? (
                <Text
                  accessibilityLiveRegion="polite"
                  accessibilityRole="alert"
                  style={styles.body}
                >
                  {inviteFeedback}
                </Text>
              ) : null}
            </View>
          ) : null}
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
          <Text style={styles.body} testID="real-group-allowance">
            {homeAllowance
              ? `${homeAllowance.countUsed} of ${homeAllowance.maxCount} contributions · ${homeAllowance.secondsUsed} of ${homeAllowance.maxSeconds} seconds used`
              : 'Loading allowance…'}
          </Text>
          <ContributionLedgerSection
            cycleId={group.cycle.id}
            groupId={group.group.id}
            loadPage={loadContributionLedger}
            onPageLoaded={handleHomeLedgerPage}
            memberId={group.memberId ?? auth.session?.account.id ?? ''}
            sessionId="real-account-session"
          />
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
              setHomeAllowance(null);
              setScreen('capture');
            }}
            testID="real-group-capture-action"
          />
          <Action
            title="Chat"
            onPress={() => {
              setHomeAllowance(null);
              setScreen('chat');
            }}
            testID="real-group-chat-action"
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
      ) : null}
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
  captureContainer: { flex: 1, gap: 12 },
  captureModes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeButton: { borderColor: COLORS.edge, borderRadius: 8, borderWidth: 1, padding: 10 },
  modeButtonText: { color: COLORS.ink, fontWeight: '700' },
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
  invitationPanel: {
    backgroundColor: COLORS.paper,
    borderRadius: 12,
    gap: 10,
    marginTop: 8,
    padding: 14,
  },
  inviteIntent: {
    backgroundColor: COLORS.paper,
    borderRadius: 12,
    gap: 8,
    padding: 16,
  },
});
