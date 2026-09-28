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
import { Platform } from 'react-native';

import {
  AuthRequestError,
  RealAccountClient,
  type AuthNotice,
  type AuthState,
  type RealAccount,
  type RealAccountSession,
} from './real-account-client';

interface RealAccountContextValue {
  state: AuthState;
  session: RealAccountSession | null;
  notice: AuthNotice;
  pending: boolean;
  secureTransportAvailable: boolean;
  signIn: (username: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  retryRestore: () => void;
  authenticatedRequest: (path: string, init?: RequestInit) => Promise<Response>;
}

const RealAccountContext = createContext<RealAccountContextValue | null>(null);

function noticeFor(error: unknown): AuthNotice {
  if (error instanceof AuthRequestError) {
    if (error.reason === 'expired') return 'expired';
    if (error.reason === 'insecure-transport') return 'offline';
    if (error.status === 401) return 'sign-in-failed';
  }
  return 'offline';
}

function accountSession(account: RealAccount, idleExpiresAt: string): RealAccountSession {
  return { account, idleExpiresAt, absoluteExpiresAt: idleExpiresAt };
}

export function RealAccountProvider({
  baseUrl,
  children,
}: {
  baseUrl: string | null;
  children: ReactNode;
}) {
  const client = useMemo(() => (baseUrl ? new RealAccountClient(baseUrl) : null), [baseUrl]);
  const [state, setState] = useState<AuthState>(client ? 'loading' : 'entry');
  const [session, setSession] = useState<RealAccountSession | null>(null);
  const [notice, setNotice] = useState<AuthNotice>(null);
  const [pending, setPending] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const mounted = useRef(true);
  const tokenRef = useRef<string | undefined>(undefined);

  const restore = useCallback(async () => {
    if (!client) {
      setState('entry');
      return;
    }
    try {
      const restored = await client.restore();
      if (!mounted.current) return;
      if (!restored) {
        setSession(null);
        setState('entry');
        return;
      }
      setSession(restored);
      setState('active');
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof AuthRequestError && error.status === 401) {
        if (Platform.OS !== 'web') await client.logout(tokenRef.current).catch(() => undefined);
        setSession(null);
        tokenRef.current = undefined;
        setNotice('expired');
        setState('entry');
      } else if (error instanceof AuthRequestError && error.reason === 'insecure-transport') {
        setSession(null);
        setState('entry');
        setNotice('offline');
      } else {
        // Keep the native token in SecureStore so Retry can validate the session.
        setSession(null);
        setState('error');
        setNotice('offline');
      }
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    const task = setTimeout(() => void restore(), 0);
    return () => {
      clearTimeout(task);
      mounted.current = false;
    };
  }, [restore, restoreAttempt]);

  const signIn = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      if (!client) {
        setNotice('offline');
        return false;
      }
      setPending(true);
      setNotice(null);
      try {
        const result = await client.login(username, password);
        if (!mounted.current) return false;
        tokenRef.current = result.token;
        setSession(accountSession(result.account, result.expiresAt));
        setState('active');
        return true;
      } catch (error) {
        if (mounted.current) {
          setState('entry');
          setNotice(noticeFor(error));
        }
        return false;
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [client],
  );

  const clearLocalSession = useCallback(async () => {
    tokenRef.current = undefined;
    setSession(null);
    setState('entry');
    setPending(false);
    if (client && Platform.OS !== 'web') {
      // Local sign-out must work offline; server expiry bounds any unreachable token.
      await client.clearStoredToken().catch(() => undefined);
    }
  }, [client]);

  const signOut = useCallback(async () => {
    setPending(true);
    if (client) {
      try {
        await client.logout(tokenRef.current);
      } catch {
        await clearLocalSession();
      }
    }
    await clearLocalSession();
    setNotice(null);
  }, [clearLocalSession, client]);

  const authenticatedRequest = useCallback(
    async (path: string, init: RequestInit = {}) => {
      if (!client || state !== 'active' || !session) throw new AuthRequestError(401, 'expired');
      try {
        return await client.request(path, init, tokenRef.current);
      } catch (error) {
        if (error instanceof AuthRequestError && error.status === 401) {
          setNotice('revoked');
          await clearLocalSession();
        }
        throw error;
      }
    },
    [clearLocalSession, client, session, state],
  );

  useEffect(() => {
    if (state !== 'active' || !session) return;
    const remaining = Date.parse(session.idleExpiresAt) - Date.now();
    const timer = setTimeout(
      () => {
        setNotice('expired');
        void clearLocalSession();
      },
      Math.max(0, Number.isFinite(remaining) ? remaining : 0),
    );
    return () => clearTimeout(timer);
  }, [clearLocalSession, session, state]);

  const value = useMemo<RealAccountContextValue>(
    () => ({
      state,
      session,
      notice,
      pending,
      secureTransportAvailable: Boolean(client?.canConnectSecurely()),
      signIn,
      signOut,
      retryRestore: () => {
        setState('loading');
        setNotice(null);
        setRestoreAttempt((attempt) => attempt + 1);
      },
      authenticatedRequest,
    }),
    [authenticatedRequest, client, notice, pending, session, signIn, signOut, state],
  );

  return <RealAccountContext.Provider value={value}>{children}</RealAccountContext.Provider>;
}

export function useRealAccount(): RealAccountContextValue {
  const value = useContext(RealAccountContext);
  if (!value) throw new Error('useRealAccount requires RealAccountProvider');
  return value;
}
