import { useRef } from 'react';

import { useRealAccount } from '../auth/RealAccountProvider';
import type { AuthenticatedRequest } from '../capture/real-account-video-runtime';

export interface ReminderContext {
  accountId: string | undefined;
  request: AuthenticatedRequest;
  groupId: string | undefined;
  revision: number;
}

/**
 * Refs shared by the group hooks so a late response can tell it belongs to a
 * context (account, group, mount) that has since changed.
 */
export function useGroupContextRefs() {
  const auth = useRealAccount();
  const groupContextVersionRef = useRef(0);
  const groupMutationPendingRef = useRef(false);
  const selectedGroupIdRef = useRef<string | null>(null);
  const captureMountedRef = useRef(true);
  const reminderContextRef = useRef<ReminderContext>({
    accountId: auth.session?.account.id,
    request: auth.authenticatedRequest,
    groupId: undefined,
    revision: 0,
  });
  return {
    groupContextVersionRef,
    groupMutationPendingRef,
    selectedGroupIdRef,
    captureMountedRef,
    reminderContextRef,
  };
}

export type GroupContextRefs = ReturnType<typeof useGroupContextRefs>;
