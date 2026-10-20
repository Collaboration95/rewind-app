import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { AppState } from 'react-native';

import { useRealAccount } from '../auth/RealAccountProvider';
import type { ContributionLedgerPage } from '../domain/contributions';
import { awaitingServer, nextBoundary } from '../real/home-model';
import { readGroup, type RealGroup } from './real-group-model';
import type { GroupContextRefs } from './use-group-context-refs';

// Reconcile just after a boundary so the server has crossed it too.
const BOUNDARY_SLACK_MS = 1_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
// While a film is developing or the server is behind, poll gently and give up.
const CATCH_UP_POLL_MS = 30_000;
const CATCH_UP_POLL_LIMIT = 20;

/**
 * Keeps the group and the allowance current: quiet refreshes, a refresh on
 * foreground return, at each cycle boundary, and while the server catches up.
 */
export function useGroupRefresh({
  group,
  screen,
  captureOpen,
  now,
  refs,
  goHome,
  load,
  refreshLedger,
  ledgerOwner,
  setGroup,
}: {
  group: RealGroup | null;
  screen: 'loading' | 'ready' | 'error';
  captureOpen: boolean;
  now: number;
  refs: GroupContextRefs;
  goHome: () => void;
  load: () => Promise<void>;
  refreshLedger: (join?: boolean) => Promise<ContributionLedgerPage | null>;
  ledgerOwner: string | null;
  setGroup: Dispatch<SetStateAction<RealGroup | null>>;
}) {
  const auth = useRealAccount();
  const { groupContextVersionRef, groupMutationPendingRef, selectedGroupIdRef, captureMountedRef } =
    refs;
  const { reminderContextRef } = refs;
  const accountId = auth.session?.account.id ?? null;
  const latestGroup = useRef(group);
  const groupRefresh = useRef<{ id: number; promise: Promise<void> } | null>(null);
  const groupRefreshId = useRef(0);
  const capturing = useRef(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  useLayoutEffect(() => {
    latestGroup.current = group;
    capturing.current = captureOpen;
  });
  // Quietly re-read the current group (cycle, releases) without touching the screen.
  // A newer request supersedes an older one, and `force` skips joining one in flight.
  const refreshGroup = useCallback(
    (force = false): Promise<void> => {
      const groupId = selectedGroupIdRef.current;
      if (!groupId || groupMutationPendingRef.current) return Promise.resolve();
      if (!force && groupRefresh.current) return groupRefresh.current.promise;
      const contextVersion = groupContextVersionRef.current;
      const request = auth.authenticatedRequest;
      const requestId = ++groupRefreshId.current;
      const current = () =>
        captureMountedRef.current &&
        requestId === groupRefreshId.current &&
        contextVersion === groupContextVersionRef.current &&
        selectedGroupIdRef.current === groupId &&
        reminderContextRef.current.accountId === accountId &&
        reminderContextRef.current.request === request;
      const promise = (async () => {
        try {
          const refreshed = await readGroup(await request('/real/groups/current'));
          if (!current()) return;
          if (refreshed?.group.id !== groupId) {
            // Removed from the group, or the server selects another: reload as a fresh start would.
            groupContextVersionRef.current += 1;
            goHome();
            void load();
            return;
          }
          if (latestGroup.current?.cycle.id !== refreshed.cycle.id) void refreshLedger();
          setGroup((previous) =>
            previous && JSON.stringify(previous) === JSON.stringify(refreshed)
              ? previous
              : refreshed,
          );
          setRefreshFailed(false);
        } catch {
          if (current()) setRefreshFailed(true);
        } finally {
          if (groupRefresh.current?.id === requestId) groupRefresh.current = null;
        }
      })();
      groupRefresh.current = { id: requestId, promise };
      return promise;
    },
    [
      accountId,
      auth.authenticatedRequest,
      goHome,
      load,
      refreshLedger,
      captureMountedRef,
      groupContextVersionRef,
      groupMutationPendingRef,
      reminderContextRef,
      selectedGroupIdRef,
      setGroup,
    ],
  );
  // Group and allowance together. An open capture keeps its screen and state; closing it reconciles.
  const reconcile = (force = false): Promise<unknown> =>
    screen !== 'ready' || capturing.current
      ? Promise.resolve()
      : Promise.all([refreshGroup(force), refreshLedger(!force)]);
  const reconcileRef = useRef(reconcile);
  const refreshGroupRef = useRef(refreshGroup);
  useLayoutEffect(() => {
    reconcileRef.current = reconcile;
    refreshGroupRef.current = refreshGroup;
  });

  const [foregroundCount, setForegroundCount] = useState(0);
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && (previous === 'background' || previous === 'inactive')) {
        setForegroundCount((count) => count + 1);
        void reconcileRef.current();
      }
      previous = next;
    });
    return () => subscription.remove();
  }, []);

  const boundary = group ? nextBoundary(group.cycle, group.releases, now) : null;
  useEffect(() => {
    if (boundary === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const wait = boundary + BOUNDARY_SLACK_MS - Date.now();
      timer =
        wait > MAX_TIMER_MS
          ? setTimeout(arm, MAX_TIMER_MS)
          : setTimeout(() => void reconcileRef.current(true), Math.max(0, wait));
    };
    arm();
    return () => clearTimeout(timer);
  }, [boundary, ledgerOwner]);

  const catchingUp = group ? awaitingServer(group.cycle, group.releases, now) : false;
  useEffect(() => {
    if (!catchingUp || !ledgerOwner) return;
    let attempts = 0;
    const timer = setInterval(() => {
      if (attempts >= CATCH_UP_POLL_LIMIT) return clearInterval(timer);
      if (AppState.currentState === 'background' || capturing.current) return;
      attempts += 1;
      void refreshGroupRef.current();
    }, CATCH_UP_POLL_MS);
    return () => clearInterval(timer);
  }, [catchingUp, ledgerOwner, foregroundCount]);

  return { refreshGroup, reconcile, refreshFailed };
}
