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
  type RegistrationOutcome,
  invalidRegistrationOutcome,
} from './real-account-client';
import { signOutMarkerStore, type SignOutMarker } from './sign-out-marker';

interface RealAccountContextValue {
  baseUrl: string | null;
  state: AuthState;
  session: RealAccountSession | null;
  notice: AuthNotice;
  pending: boolean;
  secureTransportAvailable: boolean;
  signIn: (username: string, password: string) => Promise<boolean>;
  registerAccount: (username: string, password: string) => Promise<RegistrationOutcome>;
  signOut: () => Promise<void>;
  /** Delete the signed-in account after re-checking its password (#428). */
  deleteAccount: (password: string) => Promise<AccountDeletionOutcome>;
  retryLocalCredentialRemoval: () => Promise<void>;
  retryRestore: () => void;
  authenticatedRequest: (path: string, init?: RequestInit) => Promise<Response>;
  realtimeAuthorizationHeader: () => string | undefined;
}

export type AccountDeletionOutcome = 'deleted' | 'incorrect' | 'throttled' | 'unavailable';

const RealAccountContext = createContext<RealAccountContextValue | null>(null);

function noticeFor(error: unknown): AuthNotice {
  if (error instanceof AuthRequestError) {
    if (error.reason === 'expired') return 'expired';
    if (error.reason === 'insecure-transport') return 'offline';
    if (error.status === 401) return 'sign-in-failed';
  }
  return 'offline';
}

function accountSession(
  account: RealAccount,
  idleExpiresAt: string,
  absoluteExpiresAt?: string,
): RealAccountSession {
  return { account, idleExpiresAt, ...(absoluteExpiresAt ? { absoluteExpiresAt } : {}) };
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
  // Requests still in flight when sign-out lands get a 401; that is the
  // sign-out itself, not a revoked session.
  const signingOut = useRef(false);

  const restore = useCallback(async () => {
    if (!client) {
      setState('entry');
      return;
    }
    if (Platform.OS !== 'web') {
      let marker: SignOutMarker | null;
      try {
        marker = await signOutMarkerStore.read();
      } catch {
        if (!mounted.current) return;
        tokenRef.current = undefined;
        setSession(null);
        setState('entry');
        setNotice('sign-out-marker-unavailable');
        return;
      }
      if (marker) {
        if (!mounted.current) return;
        tokenRef.current = undefined;
        setSession(null);
        setState('entry');
        setNotice(
          marker === 'remote-revoked'
            ? 'local-credential-removal-failed'
            : 'sign-out-recovery-pending',
        );
        return;
      }
      if (!mounted.current) return;
    }
    try {
      const restored = await client.restore();
      if (!mounted.current) return;
      if (!restored) {
        setSession(null);
        setState('entry');
        setNotice(null);
        return;
      }
      setSession(restored);
      setState('active');
      setNotice(null);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof AuthRequestError && error.status === 401) {
        let localCredentialRemovalFailed = false;
        if (Platform.OS !== 'web') {
          await client.logout(tokenRef.current).catch(() => undefined);
          try {
            await client.clearStoredToken();
          } catch {
            localCredentialRemovalFailed = true;
          }
        }
        setSession(null);
        tokenRef.current = undefined;
        setNotice(localCredentialRemovalFailed ? 'local-credential-removal-failed' : 'expired');
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
      signingOut.current = false;
      if (!client) {
        setNotice('offline');
        return false;
      }
      setPending(true);
      setNotice(null);
      try {
        if (Platform.OS !== 'web') {
          let marker: SignOutMarker | null;
          try {
            marker = await signOutMarkerStore.read();
          } catch {
            if (mounted.current) {
              setState('entry');
              setNotice('sign-out-marker-unavailable');
            }
            return false;
          }
          if (marker) {
            setState('entry');
            setNotice(
              marker === 'remote-revoked'
                ? 'local-credential-removal-failed'
                : 'sign-out-recovery-pending',
            );
            return false;
          }
          if (!mounted.current) return false;
        }
        const result = await client.login(username, password);
        if (!mounted.current) return false;
        tokenRef.current = result.token;
        setSession(accountSession(result.account, result.expiresAt, result.absoluteExpiresAt));
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

  const registerAccount = useCallback(
    async (username: string, password: string): Promise<RegistrationOutcome> => {
      if (!client) return 'unavailable';
      setPending(true);
      try {
        await client.register(username, password);
        return 'created';
      } catch (error) {
        if (error instanceof AuthRequestError) {
          if (error.status === 409) return 'duplicate';
          if (error.status === 429) return 'rate-limited';
          if (error.status === 400 || error.status === 422) {
            return invalidRegistrationOutcome(username, password);
          }
        }
        return 'unavailable';
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

  const retryLocalCredentialRemoval = useCallback(async () => {
    if (!client || Platform.OS === 'web') return;
    setPending(true);
    try {
      await client.clearStoredToken();
      tokenRef.current = undefined;
      setSession(null);
      setState('entry');
    } catch {
      setSession(null);
      setState('entry');
      setNotice('local-credential-removal-failed');
      setPending(false);
      return;
    }
    try {
      await signOutMarkerStore.clear();
      setNotice(null);
    } catch {
      setNotice('sign-out-marker-cleanup-failed');
    } finally {
      setPending(false);
    }
  }, [client]);

  const signOut = useCallback(async () => {
    signingOut.current = true;
    setPending(true);
    if (!client) {
      await clearLocalSession();
      setNotice(null);
      return;
    }

    if (Platform.OS !== 'web') {
      try {
        await signOutMarkerStore.write('pending');
      } catch {
        // Keep the active session visible and truthful if durable recovery
        // state cannot be written. No request or credential deletion starts.
        signingOut.current = false;
        setPending(false);
        setNotice('sign-out-marker-unavailable');
        return;
      }
      tokenRef.current = undefined;
      setSession(null);
      setState('entry');
      setNotice('sign-out-recovery-pending');
    }

    let remoteRevoked = false;
    try {
      await client.logout(tokenRef.current);
      remoteRevoked = true;
    } catch {
      // Keep server revocation status separate from local credential deletion.
    }

    if (Platform.OS === 'web') {
      if (remoteRevoked) {
        await clearLocalSession();
        setNotice(null);
      } else {
        // HttpOnly cookies cannot be cleared in JavaScript. Keep this browser
        // session active until the server confirms revocation.
        signingOut.current = false;
        setPending(false);
        setNotice('revocation-unconfirmed');
      }
      return;
    }

    if (!remoteRevoked) {
      // Keep the SecureStore credential under the pending marker so a retry
      // after restart can still ask the server to revoke this exact token.
      setSession(null);
      setState('entry');
      setPending(false);
      setNotice('sign-out-incomplete');
      return;
    }

    // Record server confirmation durably before deleting the only credential
    // that a restart retry could use. A failed update leaves the original
    // pending marker and SecureStore token in place.
    try {
      await signOutMarkerStore.write('remote-revoked');
    } catch {
      setSession(null);
      setState('entry');
      setPending(false);
      setNotice('sign-out-recovery-pending');
      return;
    }

    let localCredentialRemoved = false;
    try {
      await client.clearStoredToken();
      localCredentialRemoved = true;
    } catch {
      // SecureStore can fail independently of server-side revocation.
    }

    if (localCredentialRemoved) {
      tokenRef.current = undefined;
      setSession(null);
      setState('entry');
      setPending(false);
      try {
        await signOutMarkerStore.clear();
        setNotice(remoteRevoked ? null : 'revocation-unconfirmed');
      } catch {
        setNotice(remoteRevoked ? 'sign-out-marker-cleanup-failed' : 'sign-out-recovery-pending');
      }
    } else {
      // The server has revoked this token, so close protected UI even though
      // SecureStore may restore the now-invalid credential after restart.
      tokenRef.current = undefined;
      setSession(null);
      setState('entry');
      setPending(false);
      setNotice('local-credential-removal-failed');
    }
  }, [clearLocalSession, client]);

  const deleteAccount = useCallback(
    async (password: string): Promise<AccountDeletionOutcome> => {
      if (!client || state !== 'active') return 'unavailable';
      setPending(true);
      try {
        const response = await client.request(
          '/auth/account/delete',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
          },
          tokenRef.current,
        );
        if (response.status === 403) return 'incorrect';
        if (response.status === 429) return 'throttled';
        if (!response.ok) return 'unavailable';
        // The server revoked every session with the account, so only this
        // device's copy of the credential is left to clear.
        await clearLocalSession();
        if (mounted.current) setNotice('deleted');
        return 'deleted';
      } catch {
        return 'unavailable';
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [clearLocalSession, client, state],
  );

  const authenticatedRequest = useCallback(
    async (path: string, init: RequestInit = {}) => {
      if (!client || state !== 'active' || !session) throw new AuthRequestError(401, 'expired');
      try {
        return await client.request(path, init, tokenRef.current);
      } catch (error) {
        if (error instanceof AuthRequestError && error.status === 401) {
          if (!signingOut.current) setNotice('revoked');
          await clearLocalSession();
        }
        throw error;
      }
    },
    [clearLocalSession, client, session, state],
  );

  const realtimeAuthorizationHeader = useCallback(
    () => client?.realtimeAuthorizationHeader(tokenRef.current),
    [client],
  );

  useEffect(() => {
    if (state !== 'active' || !session?.absoluteExpiresAt) return;
    // Idle expiry rolls forward on the server. Only a supplied absolute expiry
    // is safe to schedule locally; every server 401 remains authoritative.
    const remaining = Date.parse(session.absoluteExpiresAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    let timer: ReturnType<typeof setTimeout>;
    const checkAbsoluteExpiry = () => {
      const delay = Date.parse(session.absoluteExpiresAt!) - Date.now();
      if (delay <= 0) {
        setNotice('expired');
        void clearLocalSession();
        return;
      }
      // Longer delays overflow the signed 32-bit JS timer and fire immediately.
      timer = setTimeout(checkAbsoluteExpiry, Math.min(delay, 2_147_483_647));
    };
    checkAbsoluteExpiry();
    return () => clearTimeout(timer);
  }, [clearLocalSession, session, state]);

  const value = useMemo<RealAccountContextValue>(
    () => ({
      baseUrl,
      state,
      session,
      notice,
      pending,
      secureTransportAvailable: Boolean(client?.canConnectSecurely()),
      signIn,
      registerAccount,
      signOut,
      deleteAccount,
      retryLocalCredentialRemoval,
      retryRestore: () => {
        setState('loading');
        setNotice(null);
        setRestoreAttempt((attempt) => attempt + 1);
      },
      authenticatedRequest,
      realtimeAuthorizationHeader,
    }),
    [
      authenticatedRequest,
      realtimeAuthorizationHeader,
      baseUrl,
      client,
      deleteAccount,
      notice,
      pending,
      retryLocalCredentialRemoval,
      registerAccount,
      session,
      signIn,
      signOut,
      state,
    ],
  );

  return <RealAccountContext.Provider value={value}>{children}</RealAccountContext.Provider>;
}

export function useRealAccount(): RealAccountContextValue {
  const value = useContext(RealAccountContext);
  if (!value) throw new Error('useRealAccount requires RealAccountProvider');
  return value;
}
