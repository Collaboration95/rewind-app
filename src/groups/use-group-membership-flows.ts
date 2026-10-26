import { useState, type Dispatch, type SetStateAction } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Platform, Share } from 'react-native';

import { useRealAccount } from '../auth/RealAccountProvider';
import { rateLimitMessage } from '../auth/real-account-client';
import { userMessage } from '../domain/user-message';
import { createInviteLink } from '../invites/deep-links';
import type { ShellTab } from '../real/Shell';
import { postJson } from '../real/request';
import type { NewGroupInput } from '../real/GroupFlows';
import { useToast } from '../ui/primitives';
import { displayInviteCode, readGroup, type RealGroup, type RealInvite } from './real-group-model';
import type { GroupContextRefs } from './use-group-context-refs';
import type { useGroupReminders } from './use-group-reminders';

/**
 * Creating, joining and switching groups, and the owner's invitation code
 * (create, revoke, copy, share). Group changes first remove the device reminder.
 */
export function useGroupMembershipFlows({
  group,
  refs,
  reminders,
  loadGroupMembers,
  goHome,
  setGroup,
  setMemberGroups,
  setScreen,
  setMessage,
  setTab,
}: {
  group: RealGroup | null;
  refs: GroupContextRefs;
  reminders: Pick<
    ReturnType<typeof useGroupReminders>,
    'currentMutationAccount' | 'revokeReminderBeforeGroupChange' | 'setReminderRevision'
  >;
  loadGroupMembers: (groupId: string, contextVersion: number, quiet?: boolean) => Promise<void>;
  goHome: () => void;
  setGroup: Dispatch<SetStateAction<RealGroup | null>>;
  setMemberGroups: Dispatch<SetStateAction<RealGroup[]>>;
  setScreen: Dispatch<SetStateAction<'loading' | 'ready' | 'error'>>;
  setMessage: Dispatch<SetStateAction<string | null>>;
  setTab: Dispatch<SetStateAction<ShellTab>>;
}) {
  const auth = useRealAccount();
  const toast = useToast();
  const { groupContextVersionRef, groupMutationPendingRef, selectedGroupIdRef } = refs;
  const { currentMutationAccount, revokeReminderBeforeGroupChange, setReminderRevision } =
    reminders;
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinFeedback, setJoinFeedback] = useState<string | null>(null);
  const [joinedName, setJoinedName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [invite, setInvite] = useState<RealInvite | null>(null);
  const [inviteFeedback, setInviteFeedback] = useState<string | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  const [acceptPending, setAcceptPending] = useState(false);

  const create = async ({ name: cleanName, prompt: cleanPrompt, maxMembers }: NewGroupInput) => {
    if (groupMutationPendingRef.current) return;
    groupMutationPendingRef.current = true;
    setPending(true);
    setCreateError(null);
    try {
      await revokeReminderBeforeGroupChange();
      const response = await auth.authenticatedRequest(
        '/real/groups',
        postJson({ name: cleanName, prompt: cleanPrompt, maxMembers }),
      );
      if (!response.ok)
        throw new Error(
          await rateLimitMessage(
            response,
            'The group could not be created. Check the details and retry.',
          ),
        );
      const created = (await response.json()) as RealGroup;
      if (!currentMutationAccount()) return;
      const contextVersion = ++groupContextVersionRef.current;
      selectedGroupIdRef.current = created.group.id;
      setGroup(created);
      setMemberGroups((current) => [...current, created]);
      setScreen('ready');
      goHome();
      toast(`Created “${created.group.name}”.`);
      await loadGroupMembers(created.group.id, contextVersion);
    } catch (error) {
      if (currentMutationAccount())
        setCreateError(userMessage(error, 'The group could not be created.'));
    } finally {
      groupMutationPendingRef.current = false;
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
        postJson(),
      );
      const body = (await response.json()) as { invite?: RealInvite; message?: string };
      if (!response.ok || !body.invite) {
        throw new Error(
          body.message ?? 'The invitation could not be created. Retry when connected.',
        );
      }
      setInvite(body.invite);
    } catch (error) {
      setInviteFeedback(userMessage(error, 'The invitation could not be created.'));
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
      await loadGroupMembers(group.group.id, groupContextVersionRef.current);
    } catch (error) {
      setInviteFeedback(userMessage(error, 'The invitation could not be revoked.'));
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
      // On the web the link opens Rewind with the invitation filled in.
      const link =
        Platform.OS === 'web' && typeof window !== 'undefined'
          ? createInviteLink(invite, {
              platform: 'web',
              webOrigin: window.location.origin,
              groupId: invite.groupId,
            })
          : null;
      await Share.share({
        message: `Join my Rewind group with code ${displayInviteCode(invite.code)}. ${
          link ?? 'Open Rewind and choose Have an invite?'
        }`,
      });
      setInviteFeedback(null);
    } catch {
      setInviteFeedback('Share is unavailable here. Copy the invitation code to share it.');
    }
  };

  const acceptInvitation = async (rawCode: string, requestedGroupId?: string) => {
    if (acceptPending || groupMutationPendingRef.current) return;
    const code = rawCode.replace(/[\s-]/g, '').toUpperCase();
    if (!/^(?:[A-Z]{6}|[A-Z0-9]{8})$/.test(code)) {
      setJoinFeedback('Enter the six-letter invitation code, like ABC-DEF.');
      return;
    }
    groupMutationPendingRef.current = true;
    setAcceptPending(true);
    setJoinFeedback(null);
    try {
      await revokeReminderBeforeGroupChange();
      const response = await auth.authenticatedRequest(
        '/real/invites/accept',
        postJson({ code, ...(requestedGroupId ? { groupId: requestedGroupId } : {}) }),
      );
      const body = (await response.json()) as {
        status?: string;
        group?: RealGroup;
        message?: string;
      };
      if (!response.ok || !body.group) {
        throw new Error(body.message ?? 'The invitation could not be accepted.');
      }
      if (!currentMutationAccount()) return;
      const contextVersion = ++groupContextVersionRef.current;
      selectedGroupIdRef.current = body.group.group.id;
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
        setJoinFeedback(userMessage(error, 'The invitation could not be accepted.'));
    } finally {
      groupMutationPendingRef.current = false;
      if (currentMutationAccount()) {
        setAcceptPending(false);
        setReminderRevision((value) => value + 1);
      }
    }
  };

  const switchGroup = async (groupId: string): Promise<boolean> => {
    if (pending || acceptPending || groupMutationPendingRef.current) return false;
    groupMutationPendingRef.current = true;
    const previousGroupId = selectedGroupIdRef.current;
    let contextVersion = groupContextVersionRef.current;
    setPending(true);
    setMessage(null);
    try {
      await revokeReminderBeforeGroupChange();
      contextVersion = ++groupContextVersionRef.current;
      const response = await auth.authenticatedRequest(
        '/real/groups/current',
        postJson({ groupId }),
      );
      const selected = await readGroup(response);
      if (!selected) throw new Error('That group is not available to this account.');
      if (contextVersion !== groupContextVersionRef.current || !currentMutationAccount())
        return false;
      selectedGroupIdRef.current = selected.group.id;
      setGroup(selected);
      setInvite(null);
      setTab('home');
      await loadGroupMembers(selected.group.id, contextVersion);
      return true;
    } catch (error) {
      if (contextVersion !== groupContextVersionRef.current || !currentMutationAccount())
        return false;
      setMessage(userMessage(error, 'The group could not be selected.'));
      if (previousGroupId) await loadGroupMembers(previousGroupId, contextVersion);
      return false;
    } finally {
      groupMutationPendingRef.current = false;
      if (currentMutationAccount()) {
        if (contextVersion === groupContextVersionRef.current) setPending(false);
        setReminderRevision((value) => value + 1);
      }
    }
  };

  return {
    pending,
    acceptPending,
    createError,
    setCreateError,
    joinFeedback,
    setJoinFeedback,
    joinedName,
    setJoinedName,
    invite,
    inviteFeedback,
    invitePending,
    create,
    createInvitation,
    revokeInvitation,
    copyInvitation,
    shareInvitation,
    acceptInvitation,
    switchGroup,
  };
}
