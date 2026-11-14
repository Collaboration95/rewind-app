import { useCallback, useEffect, useRef, useState } from 'react';

import { useRealAccount } from '../auth/RealAccountProvider';
import type { createRealAccountVideoRuntimeClient } from '../capture/real-account-video-runtime';
import type { ContributionLedgerPage } from '../domain/contributions';
import type { GroupContextRefs } from './use-group-context-refs';

/**
 * The member's contribution ledger for the current group, with a last-good page
 * kept on screen when a refresh fails.
 */
export function useContributionLedger({
  groupId: ledgerGroupId,
  mediaClient,
  refs,
}: {
  groupId: string | null;
  mediaClient: ReturnType<typeof createRealAccountVideoRuntimeClient>;
  refs: GroupContextRefs;
}) {
  const auth = useRealAccount();
  const { selectedGroupIdRef } = refs;
  // Keyed by group id, not the snapshot, so a quiet refresh never re-hydrates the status provider.
  const loadContributionLedger = useCallback(
    () =>
      ledgerGroupId
        ? mediaClient.getContributionLedger(ledgerGroupId)
        : Promise.reject(new Error('No active group.')),
    [ledgerGroupId, mediaClient],
  );
  const [ledger, setLedger] = useState<ContributionLedgerPage | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const ledgerRequest = useRef(0);

  const accountId = auth.session?.account.id ?? null;
  const ledgerOwner = ledgerGroupId ? `${accountId}:${ledgerGroupId}` : null;
  const ledgerOwnerRef = useRef<string | null>(null);
  const ledgerInflight = useRef<{
    id: number;
    promise: Promise<ContributionLedgerPage | null>;
  } | null>(null);
  // `join` shares a request already in flight; the default always asks again.
  const refreshLedger = useCallback(
    (join = false): Promise<ContributionLedgerPage | null> => {
      if (!ledgerGroupId) return Promise.resolve(null);
      if (join && ledgerInflight.current) return ledgerInflight.current.promise;
      const requestId = ++ledgerRequest.current;
      const current = () =>
        requestId === ledgerRequest.current &&
        selectedGroupIdRef.current === ledgerGroupId &&
        ledgerOwnerRef.current === ledgerOwner;
      const promise = (async () => {
        try {
          const page = await mediaClient.getContributionLedger(ledgerGroupId);
          if (!current()) return null;
          setLedger(page);
          setLedgerError(null);
          return page;
        } catch {
          // The last confirmed allowance stays; clearing it would make the shutter look ready.
          if (current()) setLedgerError('Your moments could not be loaded. Retry when connected.');
          return null;
        } finally {
          if (ledgerInflight.current?.id === requestId) ledgerInflight.current = null;
        }
      })();
      ledgerInflight.current = { id: requestId, promise };
      return promise;
    },
    [ledgerGroupId, ledgerOwner, mediaClient, selectedGroupIdRef],
  );
  useEffect(() => {
    void Promise.resolve().then(() => {
      if (ledgerOwnerRef.current !== ledgerOwner) {
        ledgerOwnerRef.current = ledgerOwner;
        setLedger(null);
        setLedgerError(null);
      }
      return refreshLedger();
    });
  }, [ledgerOwner, refreshLedger]);

  return { ledger, ledgerError, ledgerOwner, loadContributionLedger, refreshLedger };
}
