import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DEFAULT_MEMBER_ID,
  demoRepository,
  hydrateLocalDemoData,
  resetLocalDemoData,
} from '../data/demo-repository';
import { localGroupStore } from '../data/local-group-store';
import { selectionStore } from '../data/selection-store';
import {
  validateStoredDemoSession,
  type DemoSession,
  type DemoSessionStore,
} from '../domain/session';
import type { MemberProfile } from '../domain/profiles';
import { LocalRuntimeError, type RuntimeClient } from '../runtime/local-runtime-client';
import { createOfflineDemoSession, demoSessionStore } from './session-store';

export type DemoAccessStatus = 'loading' | 'entry' | 'active' | 'error';

interface DemoSessionContextValue {
  status: DemoAccessStatus;
  session: DemoSession | null;
  profiles: MemberProfile[];
  error: string | null;
  pending: boolean;
  chooseMember: (memberId: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetDemoData: () => Promise<boolean>;
  updateGroup: (groupId: string) => Promise<void>;
  retryRestore: () => void;
}

const DemoSessionContext = createContext<DemoSessionContextValue | null>(null);
const defaultSessionClock = () => new Date();

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function DemoSessionProvider({
  children,
  runtimeClient = null,
  store = demoSessionStore,
  clock = defaultSessionClock,
}: {
  children: ReactNode;
  runtimeClient?: RuntimeClient | null;
  store?: DemoSessionStore;
  clock?: () => Date;
}) {
  const profiles = useMemo(() => demoRepository.listProfiles(), []);
  const [status, setStatus] = useState<DemoAccessStatus>('loading');
  const [session, setSession] = useState<DemoSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const mounted = useRef(true);

  const restore = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      hydrateLocalDemoData(await localGroupStore.load());
      const stored = await store.load();
      if (!stored) {
        // The offline fixture keeps the established clean-start experience:
        // Amber is an explicit synthetic Demo actor, not a real account. A
        // user can still end this session from Settings and return to entry.
        const defaultProfile = profiles.find((profile) => profile.id === DEFAULT_MEMBER_ID);
        if (!defaultProfile) throw new Error('The default synthetic Demo member is unavailable.');
        const initial = runtimeClient?.createDemoSession
          ? await runtimeClient.createDemoSession(defaultProfile.id)
          : createOfflineDemoSession(
              defaultProfile.id,
              defaultProfile.displayName,
              'demo-group',
              clock(),
            );
        await store.save(initial);
        if (mounted.current) {
          setSession(initial);
          setStatus('active');
        }
        return;
      }
      const localResult = validateStoredDemoSession(stored, clock());
      if (localResult.status !== 'valid') {
        await store.clear();
        if (mounted.current) setStatus('entry');
        return;
      }
      const restored = runtimeClient?.getDemoSession
        ? await runtimeClient.getDemoSession(stored.id)
        : stored;
      if (mounted.current) {
        setSession(restored);
        setStatus('active');
      }
    } catch (restoreError) {
      if (mounted.current) {
        if (
          restoreError instanceof LocalRuntimeError &&
          (restoreError.status === 401 || restoreError.status === 404)
        ) {
          await store.clear();
          setStatus('entry');
          setError('The saved Demo access is no longer active. Choose a member to start again.');
        } else {
          setStatus('error');
          setError(
            safeError(
              restoreError,
              'Demo access could not be restored. Retry, or choose a member to start again.',
            ),
          );
        }
      }
    }
  }, [clock, profiles, runtimeClient, store]);

  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(restore);
    return () => {
      mounted.current = false;
    };
  }, [restore, restoreAttempt]);

  const chooseMember = useCallback(
    async (memberId: string) => {
      const member = profiles.find((profile) => profile.id === memberId);
      if (!member || pending) return;
      setPending(true);
      setError(null);
      try {
        const next = runtimeClient?.createDemoSession
          ? await runtimeClient.createDemoSession(member.id)
          : createOfflineDemoSession(member.id, member.displayName, 'demo-group', clock());
        await store.save(next);
        if (mounted.current) {
          setSession(next);
          setStatus('active');
        }
      } catch (chooseError) {
        if (mounted.current) {
          setStatus('entry');
          setError(
            safeError(
              chooseError,
              'Demo access could not start. Check the local runtime and retry.',
            ),
          );
        }
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [clock, pending, profiles, runtimeClient, store],
  );

  const signOut = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (session && runtimeClient?.invalidateDemoSession) {
        await runtimeClient.invalidateDemoSession(session.id);
      }
      await store.clear();
      if (mounted.current) {
        setSession(null);
        setStatus('entry');
      }
    } catch (signOutError) {
      if (mounted.current) {
        setStatus('active');
        setError(safeError(signOutError, 'Demo access could not be ended. Retry sign out.'));
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  }, [pending, runtimeClient, session, store]);

  const resetDemoData = useCallback(async () => {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      if (session && runtimeClient?.resetDemoData) {
        await runtimeClient.resetDemoData(session.id);
      }
      await resetLocalDemoData();
      await localGroupStore.clear();
      await selectionStore.clear?.();
      await store.clear();
      if (mounted.current) {
        setSession(null);
        setStatus('entry');
      }
      return true;
    } catch (resetError) {
      if (mounted.current) {
        setStatus('active');
        setError(safeError(resetError, 'Local Demo data could not be reset. Retry the reset.'));
      }
      return false;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, [pending, runtimeClient, session, store]);

  const updateGroup = useCallback(
    async (groupId: string) => {
      if (!session) return;
      const next = { ...session, groupId };
      await store.save(next);
      if (mounted.current) setSession(next);
    },
    [session, store],
  );

  const value = useMemo(
    () => ({
      status,
      session,
      profiles,
      error,
      pending,
      chooseMember,
      signOut,
      resetDemoData,
      updateGroup,
      retryRestore: () => setRestoreAttempt((attempt) => attempt + 1),
    }),
    [chooseMember, error, pending, profiles, resetDemoData, session, signOut, status, updateGroup],
  );

  return <DemoSessionContext.Provider value={value}>{children}</DemoSessionContext.Provider>;
}

export function useDemoSession(): DemoSessionContextValue {
  const context = useContext(DemoSessionContext);
  if (!context) throw new Error('useDemoSession requires DemoSessionProvider');
  return context;
}

export function useOptionalDemoSession(): DemoSessionContextValue | null {
  return useContext(DemoSessionContext);
}

export const DEFAULT_DEMO_MEMBER_ID = DEFAULT_MEMBER_ID;
