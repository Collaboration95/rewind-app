import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { demoRepository } from '../data/demo-repository';
import type { Cycle, CycleRepository } from '../domain/cycles';
import type { AsyncGroupRepository, Group, GroupRepository } from '../domain/profiles';
import { useDemoProfile } from '../profiles/DemoProfileProvider';
import { useOptionalDemoSession } from '../session/DemoSessionProvider';

export type CapsuleState =
  | { status: 'loading'; group: Group | null; cycle: null }
  | { status: 'ready'; group: Group; cycle: Cycle }
  | { status: 'empty'; group: Group; cycle: null }
  | { status: 'denied'; group: null; cycle: null }
  | { status: 'error'; group: Group | null; cycle: null };

interface CapsuleContextValue {
  state: CapsuleState;
  retry: () => void;
}

const CapsuleContext = createContext<CapsuleContextValue | null>(null);

export function CapsuleProvider({
  children,
  groupRepository = demoRepository,
  cycleRepository = demoRepository,
}: {
  children: ReactNode;
  groupRepository?: GroupRepository | AsyncGroupRepository;
  cycleRepository?: CycleRepository;
}) {
  const { currentMember } = useDemoProfile();
  const demoSession = useOptionalDemoSession();
  const [state, setState] = useState<CapsuleState>({
    status: 'loading',
    group: null,
    cycle: null,
  });
  const requestId = useRef(0);
  const memberId = demoSession?.session?.actor.memberId ?? currentMember?.id ?? null;

  const load = useCallback(() => {
    const request = ++requestId.current;

    if (!memberId) {
      setState({ status: 'loading', group: null, cycle: null });
      return;
    }

    setState({ status: 'loading', group: null, cycle: null });

    Promise.resolve()
      .then(() => groupRepository.getGroupForMember(memberId))
      .then((groupResult) => {
        if (request !== requestId.current) return;

        if ('kind' in groupResult) {
          setState({ status: 'denied', group: null, cycle: null });
          return;
        }

        setState({ status: 'loading', group: groupResult, cycle: null });
        return cycleRepository
          .getCurrentCycle(groupResult.id, memberId)
          .then((cycleResult) => {
            if (request !== requestId.current) return;

            if ('kind' in cycleResult) {
              if (cycleResult.kind === 'MembershipDenied') {
                setState({ status: 'denied', group: null, cycle: null });
              } else if (cycleResult.kind === 'NotFound') {
                setState({ status: 'empty', group: groupResult, cycle: null });
              } else {
                setState({ status: 'error', group: groupResult, cycle: null });
              }
              return;
            }

            setState({ status: 'ready', group: groupResult, cycle: cycleResult });
          })
          .catch(() => {
            if (request === requestId.current) {
              setState({ status: 'error', group: groupResult, cycle: null });
            }
          });
      })
      .catch(() => {
        if (request === requestId.current) {
          setState({ status: 'error', group: null, cycle: null });
        }
      });
  }, [cycleRepository, groupRepository, memberId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  return (
    <CapsuleContext.Provider value={{ state, retry: load }}>{children}</CapsuleContext.Provider>
  );
}

export function useCapsule() {
  const context = useContext(CapsuleContext);
  if (!context) throw new Error('useCapsule requires CapsuleProvider');
  return context;
}
