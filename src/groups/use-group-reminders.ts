import { useEffect, useLayoutEffect, useState, type Dispatch, type SetStateAction } from 'react';

import { useRealAccount } from '../auth/RealAccountProvider';
import {
  createPrivateReminderClient,
  type PrivateReminderClient,
} from '../reminders/private-reminder-client';
import { subscribeToReminderIntents } from '../reminders/reminder-intents';
import { readGroup, type RealGroup } from './real-group-model';
import type { GroupContextRefs } from './use-group-context-refs';

/**
 * The private reminder client for the current account and group, the removal
 * that must finish before the group changes, and sign-out that fences it.
 */
export function useGroupReminders({
  group,
  refs,
}: {
  group: RealGroup | null;
  refs: GroupContextRefs;
}) {
  const auth = useRealAccount();
  const { groupContextVersionRef, selectedGroupIdRef, captureMountedRef, reminderContextRef } =
    refs;
  const [reminderRevision, setReminderRevision] = useState(0);
  useLayoutEffect(() => {
    reminderContextRef.current = {
      accountId: auth.session?.account.id,
      request: auth.authenticatedRequest,
      groupId: group?.group.id,
      revision: reminderRevision,
    };
  }, [
    auth.session?.account.id,
    auth.authenticatedRequest,
    group?.group.id,
    reminderRevision,
    reminderContextRef,
  ]);
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
    const version = groupContextVersionRef.current;
    const client = createPrivateReminderClient({
      accountId,
      groupId,
      authenticatedRequest: request,
      isCurrentContext: () =>
        captureMountedRef.current &&
        version === groupContextVersionRef.current &&
        reminderContextRef.current.accountId === accountId &&
        reminderContextRef.current.request === request &&
        reminderContextRef.current.groupId === groupId &&
        reminderContextRef.current.revision === reminderRevision &&
        selectedGroupIdRef.current === groupId,
    });
    void Promise.resolve().then(() => {
      if (active)
        setReminderScope({ client, accountId, groupId, request, revision: reminderRevision });
    });
    return () => {
      active = false;
      void client.revoke();
    };
  }, [
    auth.session?.account.id,
    auth.authenticatedRequest,
    group?.group.id,
    reminderRevision,
    captureMountedRef,
    groupContextVersionRef,
    reminderContextRef,
    selectedGroupIdRef,
  ]);

  const revokeReminderBeforeGroupChange = async () => {
    const accountId = auth.session?.account.id;
    const request = auth.authenticatedRequest;
    const groupId = selectedGroupIdRef.current;
    const version = groupContextVersionRef.current;
    if (!reminderClient) {
      if (auth.session?.account.id && group)
        throw new Error('Device reminder support is still being checked. Retry shortly.');
      return;
    }
    const result = await reminderClient.revoke();
    if (
      !captureMountedRef.current ||
      reminderContextRef.current.accountId !== accountId ||
      reminderContextRef.current.request !== request ||
      selectedGroupIdRef.current !== groupId ||
      groupContextVersionRef.current !== version
    )
      throw new Error('Your group context changed. Open the current group and retry.');
    if (result.state !== 'revoked')
      throw new Error('Device reminder removal is unconfirmed. Check reminder support and retry.');
  };
  const signOut = () => {
    const context = reminderContextRef.current;
    const version = groupContextVersionRef.current;
    // Fence pending opt-ins immediately. Server session revocation stops sends;
    // a network-dependent device cleanup must not delay native privacy closure.
    const removal = reminderClient?.revoke();
    void Promise.allSettled([removal, auth.signOut()]).then(() => {
      // Browser revocation or native recovery-marker persistence can fail and
      // retain this session. Replace its closed client after cleanup settles;
      // durable unconfirmed-removal metadata is recovered by the new client.
      if (
        captureMountedRef.current &&
        groupContextVersionRef.current === version &&
        reminderContextRef.current.accountId === context.accountId &&
        reminderContextRef.current.request === context.request &&
        reminderContextRef.current.groupId === context.groupId &&
        reminderContextRef.current.revision === context.revision
      )
        setReminderRevision((revision) => revision + 1);
    });
  };
  const currentMutationAccount = () =>
    captureMountedRef.current &&
    reminderContextRef.current.accountId === auth.session?.account.id &&
    reminderContextRef.current.request === auth.authenticatedRequest;
  return {
    reminderClient,
    setReminderRevision,
    revokeReminderBeforeGroupChange,
    signOut,
    currentMutationAccount,
  };
}

/** Opening a reminder for the signed-in account's current group lands on that group's home. */
export function useReminderIntentRouting({
  refs,
  setMessage,
  setGroup,
  setScreen,
  goHome,
}: {
  refs: GroupContextRefs;
  setMessage: Dispatch<SetStateAction<string | null>>;
  setGroup: Dispatch<SetStateAction<RealGroup | null>>;
  setScreen: Dispatch<SetStateAction<'loading' | 'ready' | 'error'>>;
  goHome: () => void;
}) {
  const auth = useRealAccount();
  const { groupContextVersionRef, selectedGroupIdRef, captureMountedRef, reminderContextRef } =
    refs;
  useEffect(() => {
    let active = true;
    const request = auth.authenticatedRequest;
    const accountId = auth.session?.account.id;
    if (!accountId) return;
    const unsubscribe = subscribeToReminderIntents(async (intent) => {
      const context = groupContextVersionRef.current;
      try {
        const response = await request('/real/groups/current');
        const current = await readGroup(response);
        if (
          !active ||
          !captureMountedRef.current ||
          context !== groupContextVersionRef.current ||
          reminderContextRef.current.accountId !== accountId ||
          reminderContextRef.current.request !== request
        )
          return;
        if (
          current?.group.id === intent.groupId &&
          (!selectedGroupIdRef.current || selectedGroupIdRef.current === intent.groupId)
        ) {
          selectedGroupIdRef.current = current.group.id;
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
          captureMountedRef.current &&
          context === groupContextVersionRef.current &&
          reminderContextRef.current.accountId === accountId &&
          reminderContextRef.current.request === request
        )
          setMessage('Your reminder could not be opened. Reconnect and check your current group.');
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    auth.session?.account.id,
    auth.authenticatedRequest,
    goHome,
    captureMountedRef,
    groupContextVersionRef,
    reminderContextRef,
    selectedGroupIdRef,
    setGroup,
    setMessage,
    setScreen,
  ]);
}
