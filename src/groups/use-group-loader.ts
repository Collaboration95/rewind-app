import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { useRealAccount } from '../auth/RealAccountProvider';
import { userMessage } from '../domain/user-message';
import { markEnd, markLaunchReady, markStart } from '../runtime/timing';
import {
  readGroup,
  readGroupMembers,
  type RealGroup,
  type RealGroupMembers,
} from './real-group-model';
import type { GroupContextRefs } from './use-group-context-refs';

/**
 * Loads the current group, the groups this account belongs to and the member
 * list, with the error state each of them can end in.
 */
export function useGroupLoader({
  refs,
  setGroup,
  setMemberGroups,
  setScreen,
  setMessage,
}: {
  refs: GroupContextRefs;
  setGroup: Dispatch<SetStateAction<RealGroup | null>>;
  setMemberGroups: Dispatch<SetStateAction<RealGroup[]>>;
  setScreen: Dispatch<SetStateAction<'loading' | 'ready' | 'error'>>;
  setMessage: Dispatch<SetStateAction<string | null>>;
}) {
  const auth = useRealAccount();
  const { groupContextVersionRef, selectedGroupIdRef } = refs;
  const [groupMembers, setGroupMembers] = useState<RealGroupMembers | null>(null);
  const [groupMembersError, setGroupMembersError] = useState<string | null>(null);
  const groupMembersRequest = useRef(0);

  const loadGroupMembers = useCallback(
    async (groupId: string, contextVersion: number, quiet = false) => {
      if (
        contextVersion !== groupContextVersionRef.current ||
        selectedGroupIdRef.current !== groupId
      )
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
          contextVersion === groupContextVersionRef.current &&
          selectedGroupIdRef.current === groupId &&
          requestId === groupMembersRequest.current
        )
          setGroupMembers(summary);
      } catch (error) {
        if (
          !quiet &&
          contextVersion === groupContextVersionRef.current &&
          selectedGroupIdRef.current === groupId &&
          requestId === groupMembersRequest.current
        )
          setGroupMembersError(userMessage(error, 'Group members could not be loaded.'));
      }
    },
    [auth, groupContextVersionRef, selectedGroupIdRef],
  );

  const load = useCallback(async () => {
    const contextVersion = groupContextVersionRef.current;
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
      if (contextVersion !== groupContextVersionRef.current) return;
      setMemberGroups(memberships.groups ?? []);
      selectedGroupIdRef.current = result?.group.id ?? null;
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
      if (contextVersion !== groupContextVersionRef.current) return;
      setMessage(userMessage(error, 'Your group could not be loaded.'));
      setScreen('error');
    }
  }, [
    auth,
    loadGroupMembers,
    groupContextVersionRef,
    selectedGroupIdRef,
    setGroup,
    setMemberGroups,
    setScreen,
    setMessage,
  ]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return { groupMembers, groupMembersError, loadGroupMembers, load };
}
