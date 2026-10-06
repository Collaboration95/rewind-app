import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState, type ElementRef, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Image,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RealAccountProvider, useRealAccount } from './src/auth/RealAccountProvider';
import { RealAccountGroupExperience } from './src/groups/RealAccountGroupExperience';
import {
  isInviteLinkCandidate,
  parseInviteLink,
  type InviteLinkParseResult,
} from './src/invites/deep-links';
import { openLegalPage } from './src/real/safety';
import { getConfiguredInviteWebOrigin, getLocalRuntimeBaseUrl } from './src/runtime/config';
import { PortraitGuard } from './src/runtime/PortraitGuard';
import { markLaunchReady } from './src/runtime/timing';
import { useWarmFonts } from './src/ui/fonts';
import {
  Button,
  ErrorText,
  Field,
  Glow,
  SubHeader,
  ToastProvider,
  rw,
  useScreenInsets,
} from './src/ui/primitives';
import { FONT, LAYOUT, WARM, serif } from './src/ui/tokens';
import { ensureWebStyles } from './src/ui/web-styles';

ensureWebStyles();

const COLD_LAUNCH_MINIMUM_MS = 600;
type InviteLinkIntent = InviteLinkParseResult & { intentId: number };

export interface AppProps {
  /** Service override for tests; `null` means no configured service. */
  runtimeClient?: { readonly baseUrl: string } | null;
}

export default function App({ runtimeClient }: AppProps = {}) {
  const inviteLink = useInviteLinkIntent();
  const baseUrl = useMemo(
    () =>
      runtimeClient === undefined ? getLocalRuntimeBaseUrl() : (runtimeClient?.baseUrl ?? null),
    [runtimeClient],
  );
  return (
    <SafeAreaProvider>
      <RealAccountProvider baseUrl={baseUrl}>
        <PortraitGuard>
          <SessionGate inviteLink={inviteLink} />
        </PortraitGuard>
      </RealAccountProvider>
    </SafeAreaProvider>
  );
}

function useInviteLinkIntent(): InviteLinkIntent | null {
  const [inviteLink, setInviteLink] = useState<InviteLinkIntent | null>(null);
  const intentSequence = useRef(0);

  useEffect(() => {
    let mounted = true;
    const receive = (url: string | null) => {
      if (!mounted || !url || !isInviteLinkCandidate(url)) return;
      const parsed = parseInviteLink(url);
      if (parsed.kind === 'valid' || parsed.reason === 'expired' || parsed.reason === 'malformed') {
        setInviteLink({ ...parsed, intentId: ++intentSequence.current });
      }
    };

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      receive(window.location.href);
      return () => {
        mounted = false;
      };
    }

    void Linking.getInitialURL()
      .then(receive)
      .catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => receive(url));
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return inviteLink;
}

function SessionGate({ inviteLink }: { inviteLink: InviteLinkIntent | null }) {
  const realAccount = useRealAccount();
  const fontsReady = useWarmFonts();
  const [coldLaunchMinimumElapsed, setColdLaunchMinimumElapsed] = useState(false);
  const [launchFaded, setLaunchFaded] = useState(false);
  useEffect(() => {
    // SessionGate stays mounted while the app is backgrounded, so this minimum
    // applies to process startup and does not delay a warm foreground resume.
    const timeout = setTimeout(() => setColdLaunchMinimumElapsed(true), COLD_LAUNCH_MINIMUM_MS);
    return () => clearTimeout(timeout);
  }, []);
  const launchReady = coldLaunchMinimumElapsed && fontsReady && realAccount.state !== 'loading';
  useEffect(() => {
    if (!launchReady) return;
    // A1: the launch screen fades over the first screen, then leaves.
    const timeout = setTimeout(() => setLaunchFaded(true), MOTION_LAUNCH_FADE_MS);
    return () => clearTimeout(timeout);
  }, [launchReady]);
  const realAccountActive = realAccount.state === 'active' && Boolean(realAccount.session);
  useEffect(() => {
    // A signed-in member is ready once the group screen loads (see
    // RealAccountGroupExperience); other entry screens are ready here.
    if (launchReady && !realAccountActive) markLaunchReady();
  }, [launchReady, realAccountActive]);
  if (!launchReady) {
    return <SessionLoadingScreen />;
  }
  const launchFade = launchFaded || Platform.OS !== 'web' ? null : <LaunchScreen leaving />;
  if (realAccount.state === 'active' && realAccount.session)
    return (
      <WarmFrame overlay={launchFade}>
        <RealAccountGroupExperience
          displayName={realAccount.session.account.displayName}
          inviteIntent={
            inviteLink?.kind === 'valid' && typeof inviteLink.groupId === 'string'
              ? {
                  code: inviteLink.code,
                  expiresAt: inviteLink.expiresAt,
                  groupId: inviteLink.groupId,
                }
              : null
          }
          inviteWebOrigin={
            Platform.OS === 'web' && typeof window !== 'undefined'
              ? window.location.origin
              : (getConfiguredInviteWebOrigin() ?? undefined)
          }
        />
      </WarmFrame>
    );
  if (inviteLink?.kind === 'valid' && inviteLink.groupId)
    return <AccountEntry key={inviteLink.intentId} inviteGroupId={inviteLink.groupId} />;
  return <AccountEntry />;
}

const MOTION_LAUNCH_FADE_MS = 500;

/** A1: the Campfire icon and the wordmark on cream; "Opening…" after 2 s. */
function LaunchScreen({ leaving }: { leaving?: boolean }) {
  return (
    <View
      accessibilityLabel="Rewind"
      accessibilityRole={leaving ? undefined : 'progressbar'}
      pointerEvents={leaving ? 'none' : 'auto'}
      style={[styles.launch, leaving && StyleSheet.absoluteFill]}
      testID={leaving ? 'launch-leaving' : 'launch-screen'}
      {...(leaving ? rw('launch-out') : {})}
    >
      <Image
        accessibilityLabel="Rewind mark"
        source={require('./assets/icon.png')}
        style={styles.launchIcon}
      />
      <Text style={styles.launchWord}>Rewind</Text>
      {leaving ? null : (
        <Text style={styles.launchLate} {...rw('late-in')}>
          Opening…
        </Text>
      )}
    </View>
  );
}

/**
 * Frame for the Warm Glass screens: cream, full bleed. The screens pad for the
 * safe area themselves so glass and glow can run under the notch.
 */
function WarmFrame({ children, overlay }: { children: ReactNode; overlay?: ReactNode }) {
  return (
    <>
      <StatusBar style="dark" />
      <View style={styles.warmPage} testID="application-safe-area">
        <ToastProvider>{children}</ToastProvider>
        {overlay}
      </View>
    </>
  );
}

function SessionLoadingScreen() {
  return (
    <WarmFrame>
      <LaunchScreen />
    </WarmFrame>
  );
}

function AccountEntry({ inviteGroupId }: { inviteGroupId?: string }) {
  const auth = useRealAccount();
  const [entryOffset] = useState(() => new Animated.Value(0));
  const entryModeMounted = useRef(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [mode, setMode] = useState<'welcome' | 'sign-in' | 'create-account'>(
    inviteGroupId ? 'sign-in' : 'welcome',
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const registrationPasswordRef = useRef<ElementRef<typeof TextInput>>(null);
  const registrationConfirmationRef = useRef<ElementRef<typeof TextInput>>(null);
  const signInPasswordRef = useRef<ElementRef<typeof TextInput>>(null);
  const entryInsets = useScreenInsets();
  const [authPending, setAuthPending] = useState(false);
  const [registrationComplete, setRegistrationComplete] = useState(false);
  const [registrationError, setRegistrationError] = useState<
    | 'invalid'
    | 'invalid-username'
    | 'invalid-password'
    | 'duplicate'
    | 'rate-limited'
    | 'unavailable'
    | 'password-mismatch'
    | null
  >(null);
  const visibleMode = mode;

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!entryModeMounted.current) {
      entryModeMounted.current = true;
      return;
    }
    if (reduceMotion) {
      entryOffset.setValue(0);
      return;
    }
    entryOffset.setValue(6);
    const animation = Animated.timing(entryOffset, {
      toValue: 0,
      duration: 160,
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [entryOffset, reduceMotion, visibleMode]);

  const authMessage =
    auth.notice === 'expired'
      ? 'Your session expired or an administrator reset your password. Sign in again to continue.'
      : auth.notice === 'revoked'
        ? 'Your session has ended. Sign in again to continue.'
        : auth.notice === 'deleted'
          ? 'Your account is deleted.'
          : auth.notice === 'sign-in-failed'
            ? 'Wrong username or password.'
            : auth.notice === 'offline'
              ? "You're offline. Sign in again when you're connected."
              : auth.notice === 'revocation-unconfirmed'
                ? Platform.OS === 'web'
                  ? 'We could not confirm sign-out. You are still signed in on this browser; try again when the service is reachable.'
                  : 'Signed out on this device. The server did not confirm revocation; another device may remain signed in until the session expires or an administrator resets it.'
                : auth.notice === 'local-credential-removal-failed'
                  ? 'The server says this session has ended, but this device could not confirm deletion of its saved sign-in. The credential may remain in SecureStore; retry local cleanup before treating this device as signed out.'
                  : auth.notice === 'sign-out-incomplete'
                    ? 'Sign-out is incomplete: this device could not confirm deletion of its saved sign-in, and the server did not confirm revocation. The credential may remain and you may still be signed in. Retry sign out.'
                    : auth.notice === 'sign-out-recovery-pending'
                      ? 'Sign-out recovery is pending. This device will not restore a saved sign-in automatically until recovery finishes. Server revocation may still be unconfirmed.'
                      : auth.notice === 'sign-out-marker-unavailable'
                        ? auth.state === 'active'
                          ? 'Sign-out did not start because this device could not save its recovery state. You are still signed in. Retry sign out.'
                          : 'This device could not verify sign-out recovery state, so the saved sign-in was not restored. Retry sign out to recover safely.'
                        : auth.notice === 'sign-out-marker-cleanup-failed'
                          ? 'The server confirmed sign-out and this device deleted its saved sign-in, but it could not clear the recovery marker. Account restore stays blocked on this device until cleanup is retried.'
                          : null;

  const submitSignIn = async () => {
    // The "account is ready" banner has done its job once they try to sign in.
    setRegistrationComplete(false);
    setAuthPending(true);
    const signedIn = await auth.signIn(username.trim(), password);
    setAuthPending(false);
    if (signedIn) setPassword('');
  };

  const submitRegistration = async () => {
    if (
      authPending ||
      !username.trim() ||
      !password ||
      !passwordConfirmation ||
      !auth.secureTransportAvailable
    ) {
      return;
    }
    setRegistrationError(null);
    if (password !== passwordConfirmation) {
      setRegistrationError('password-mismatch');
      return;
    }
    setAuthPending(true);
    const outcome = await auth.registerAccount(username.trim(), password);
    setAuthPending(false);
    if (outcome === 'created') {
      setPassword('');
      setPasswordConfirmation('');
      setRegistrationComplete(true);
      setMode('sign-in');
      return;
    }
    setRegistrationError(outcome);
  };

  const registrationMessage =
    registrationError === 'password-mismatch'
      ? 'Passwords do not match.'
      : registrationError === 'duplicate'
        ? 'That username is taken. Try another.'
        : registrationError === 'invalid-username'
          ? 'Usernames need 3 to 32 characters: letters, numbers, dots, dashes or underscores, starting with a letter or number.'
          : registrationError === 'invalid-password'
            ? 'Passwords need at least 12 characters. A short phrase of a few words works well.'
            : registrationError === 'invalid'
              ? 'Choose a valid username and a stronger password, then try again.'
              : registrationError === 'rate-limited'
                ? 'Too many account attempts. Wait a moment before trying again.'
                : registrationError === 'unavailable'
                  ? 'Account creation is unavailable right now. Please try again shortly.'
                  : null;

  const signInBlocked =
    authPending || !username.trim() || !password || !auth.secureTransportAvailable;
  const registrationBlocked =
    authPending ||
    !username.trim() ||
    !password ||
    !passwordConfirmation ||
    !auth.secureTransportAvailable;
  const welcomeBanner =
    auth.notice === 'expired' || auth.notice === 'revoked' || auth.notice === 'deleted'
      ? authMessage
      : null;
  const recoveryNotice =
    (auth.notice === 'offline' ||
      auth.notice === 'expired' ||
      auth.notice === 'revoked' ||
      auth.notice === 'revocation-unconfirmed' ||
      auth.notice === 'local-credential-removal-failed' ||
      auth.notice === 'sign-out-incomplete' ||
      auth.notice === 'sign-out-recovery-pending' ||
      auth.notice === 'sign-out-marker-cleanup-failed' ||
      auth.notice === 'sign-out-marker-unavailable') &&
    (visibleMode === 'welcome' ||
      visibleMode === 'create-account' ||
      auth.notice === 'sign-out-incomplete' ||
      auth.notice === 'sign-out-recovery-pending' ||
      auth.notice === 'sign-out-marker-cleanup-failed' ||
      auth.notice === 'sign-out-marker-unavailable' ||
      auth.notice === 'local-credential-removal-failed') &&
    !(auth.notice === 'offline' && !auth.secureTransportAvailable);

  return (
    <WarmFrame>
      <Glow />
      <Animated.ScrollView
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        contentContainerStyle={[
          styles.warmEntry,
          { paddingTop: entryInsets.top + 8, paddingBottom: entryInsets.bottom + 140 },
          visibleMode === 'welcome' ? styles.warmWelcome : null,
        ]}
        keyboardShouldPersistTaps="handled"
        style={{ transform: [{ translateY: entryOffset }] }}
        testID="entry-mode-content"
      >
        {visibleMode === 'welcome' ? (
          <View style={styles.warmBrand} testID="entry-brand">
            <Image
              accessibilityLabel="Rewind mark"
              source={require('./assets/icon.png')}
              style={styles.warmIcon}
            />
            <Text accessibilityRole="header" style={styles.warmWord}>
              Rewind
            </Text>
            <Text style={styles.warmTagline}>
              Small moments with your people, opened together every 4 weeks.
            </Text>
          </View>
        ) : null}
        {visibleMode === 'welcome' ? (
          <View style={styles.warmActions} testID="welcome-entry">
            {welcomeBanner ? (
              <Text
                accessibilityRole="alert"
                style={styles.warmAlert}
                testID="real-account-session-status"
              >
                {welcomeBanner}
              </Text>
            ) : null}
            <Button label="Sign in" onPress={() => setMode('sign-in')} variant="primary" />
            <Button
              label="Create an account"
              onPress={() => {
                setRegistrationError(null);
                setMode('create-account');
              }}
            />
          </View>
        ) : visibleMode === 'create-account' ? (
          <View style={styles.warmForm}>
            <SubHeader onBack={() => setMode('welcome')} title="Create account" />
            <Field
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect={false}
              blurOnSubmit={false}
              editable={!authPending}
              label="Username"
              maxLength={32}
              onChangeText={setUsername}
              onSubmitEditing={() => registrationPasswordRef.current?.focus()}
              placeholder="3–32 letters, numbers, . _ -"
              returnKeyType="next"
              spellCheck={false}
              testID="registration-username"
              textContentType="username"
              value={username}
            />
            <Field
              autoCapitalize="none"
              autoComplete="new-password"
              blurOnSubmit={false}
              editable={!authPending}
              label="Password"
              onChangeText={setPassword}
              onSubmitEditing={() => registrationConfirmationRef.current?.focus()}
              placeholder="At least 12 characters"
              ref={registrationPasswordRef}
              returnKeyType="next"
              secureTextEntry
              testID="registration-password"
              textContentType="newPassword"
              value={password}
            />
            <Field
              autoCapitalize="none"
              autoComplete="new-password"
              editable={!authPending}
              label="Confirm password"
              onChangeText={setPasswordConfirmation}
              onSubmitEditing={() => void submitRegistration()}
              ref={registrationConfirmationRef}
              returnKeyType="go"
              secureTextEntry
              testID="registration-password-confirmation"
              textContentType="newPassword"
              value={passwordConfirmation}
            />
            {!auth.secureTransportAvailable ? (
              <ErrorText>
                Account creation requires the same-origin HTTPS service. Your password will not be
                sent over an insecure connection.
              </ErrorText>
            ) : null}
            <ErrorText testID="registration-error">{registrationMessage}</ErrorText>
            <Button
              busy={authPending}
              busyLabel="Creating account…"
              disabled={registrationBlocked}
              label="Create account"
              onPress={() => void submitRegistration()}
              testID="registration-submit"
              variant="primary"
            />
            <Text style={styles.warmNote}>
              By creating an account you agree to the{' '}
              <Text
                accessibilityRole="link"
                onPress={() => openLegalPage('/terms')}
                style={styles.warmLink}
                testID="registration-terms"
              >
                Terms
              </Text>{' '}
              and{' '}
              <Text
                accessibilityRole="link"
                onPress={() => openLegalPage('/privacy')}
                style={styles.warmLink}
                testID="registration-privacy"
              >
                Privacy Policy
              </Text>
              . Rewind doesn’t allow objectionable content or abusive behaviour.
            </Text>
            <Text style={styles.warmNote}>
              Already have an account?{' '}
              <Text
                accessibilityRole="button"
                onPress={() => setMode('sign-in')}
                style={styles.warmLink}
                testID="registration-sign-in"
              >
                Sign in
              </Text>
            </Text>
          </View>
        ) : (
          <View style={styles.warmForm}>
            <SubHeader
              onBack={() => setMode('welcome')}
              backLabel="Back to welcome"
              title="Sign in"
            />
            {registrationComplete ? (
              <Text
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                style={styles.warmAlert}
                testID="registration-success"
              >
                {inviteGroupId
                  ? 'Your account is ready. Sign in to accept the invitation.'
                  : 'Your account is ready. Sign in to continue.'}
              </Text>
            ) : null}
            {inviteGroupId ? (
              <Text style={styles.warmLead} testID="invite-sign-in-intent">
                Your invitation is saved. Sign in to join the group.
              </Text>
            ) : null}
            <Field
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect={false}
              autoFocus={Platform.OS === 'web'}
              blurOnSubmit={false}
              editable={!authPending}
              label="Username"
              onChangeText={setUsername}
              onSubmitEditing={() => signInPasswordRef.current?.focus()}
              returnKeyType="next"
              spellCheck={false}
              testID="real-account-username"
              textContentType="username"
              value={username}
            />
            <Field
              autoCapitalize="none"
              autoComplete="current-password"
              editable={!authPending}
              label="Password"
              onChangeText={setPassword}
              onSubmitEditing={() => void submitSignIn()}
              ref={signInPasswordRef}
              returnKeyType="go"
              secureTextEntry
              testID="real-account-password"
              textContentType="password"
              value={password}
            />
            {!auth.secureTransportAvailable ? (
              <ErrorText>
                Sign-in is unavailable until this app is connected to its same-origin HTTPS service.
                Your password will not be sent over an insecure connection.
              </ErrorText>
            ) : null}
            {authMessage &&
            auth.notice !== 'sign-out-recovery-pending' &&
            auth.notice !== 'sign-out-marker-unavailable' &&
            auth.notice !== 'sign-out-marker-cleanup-failed' &&
            auth.notice !== 'local-credential-removal-failed' &&
            !(auth.notice === 'offline' && !auth.secureTransportAvailable) ? (
              <ErrorText
                testID={
                  auth.notice === 'offline'
                    ? 'real-account-offline-status'
                    : 'real-account-session-status'
                }
              >
                {authMessage}
              </ErrorText>
            ) : (
              <ErrorText />
            )}
            <Button
              busy={authPending}
              busyLabel="Signing in…"
              disabled={signInBlocked}
              label="Sign in"
              onPress={() => void submitSignIn()}
              testID="real-account-submit"
              variant="primary"
            />
            <Text style={styles.warmNote}>
              New here?{' '}
              <Text
                accessibilityRole="button"
                onPress={() => {
                  setRegistrationComplete(false);
                  setRegistrationError(null);
                  setMode('create-account');
                }}
                style={styles.warmLink}
                testID="sign-in-create-account"
              >
                Create an account
              </Text>
            </Text>
          </View>
        )}
        {recoveryNotice ? (
          <View
            style={styles.warmPanel}
            testID={
              auth.notice === 'offline'
                ? 'real-account-offline-status'
                : 'real-account-session-status'
            }
          >
            <ErrorText>{authMessage}</ErrorText>
            {auth.notice === 'offline' ? (
              <Button label="Retry session check" onPress={auth.retryRestore} />
            ) : null}
            {auth.notice === 'local-credential-removal-failed' ||
            auth.notice === 'sign-out-marker-cleanup-failed' ? (
              <Button
                busy={auth.pending}
                busyLabel="Retrying…"
                label="Retry local cleanup"
                onPress={auth.retryLocalCredentialRemoval}
              />
            ) : null}
            {auth.notice === 'sign-out-incomplete' ||
            auth.notice === 'sign-out-recovery-pending' ||
            auth.notice === 'sign-out-marker-unavailable' ? (
              <Button
                busy={auth.pending}
                busyLabel="Signing out…"
                label="Retry sign out"
                onPress={auth.signOut}
              />
            ) : null}
          </View>
        ) : null}
        {authPending ? (
          <Text accessibilityLiveRegion="polite" style={styles.warmNote}>
            Signing in…
          </Text>
        ) : null}
        <View style={styles.entryLegal}>
          <Text
            accessibilityRole="link"
            onPress={() => openLegalPage('/privacy')}
            style={styles.entryLegalLink}
            testID="entry-privacy"
          >
            Privacy policy
          </Text>
          <Text
            accessibilityRole="link"
            onPress={() => openLegalPage('/support')}
            style={styles.entryLegalLink}
            testID="entry-support"
          >
            Help and support
          </Text>
        </View>
      </Animated.ScrollView>
    </WarmFrame>
  );
}

const styles = StyleSheet.create({
  entryLegal: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
    marginTop: 16,
  },
  entryLegalLink: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 14,
    textDecorationLine: 'underline',
  },
  warmPage: { backgroundColor: WARM.bg, flex: 1 },
  launch: {
    alignItems: 'center',
    backgroundColor: WARM.bg,
    flex: 1,
    gap: 18,
    justifyContent: 'center',
  },
  launchIcon: { borderRadius: 26, height: 112, width: 112 },
  launchWord: { color: WARM.ink, letterSpacing: -0.6, ...serif(34, '500') },
  launchLate: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13, marginTop: 6 },
  warmEntry: {
    alignSelf: 'center',
    flexGrow: 1,
    maxWidth: LAYOUT.maxWidth,
    paddingHorizontal: LAYOUT.gutter,
    width: '100%',
  },
  warmWelcome: { justifyContent: 'center' },
  warmBrand: { alignItems: 'center', gap: 14, marginBottom: 36 },
  warmIcon: { borderRadius: 22, height: 96, width: 96 },
  warmWord: { color: WARM.ink, letterSpacing: -0.6, ...serif(38, '500') },
  warmTagline: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 280,
    textAlign: 'center',
  },
  warmActions: { gap: 12 },
  warmForm: { gap: 0 },
  warmAlert: {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderColor: 'rgba(224, 112, 58, 0.35)',
    borderRadius: 14,
    borderWidth: 1,
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 13.5,
    lineHeight: 19,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  warmLead: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 14.5,
    lineHeight: 21,
    marginBottom: 14,
  },
  warmNote: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
    textAlign: 'center',
  },
  warmLink: { color: WARM.ink, fontWeight: '600', textDecorationLine: 'underline' },
  warmRetry: { alignSelf: 'center', marginBottom: 8 },
  warmPanel: { gap: 8, marginTop: 18 },
  page: {
    alignItems: 'center',
    backgroundColor: WARM.bg,
    flex: 1,
  },
  screen: {
    backgroundColor: WARM.bg,
    flex: 1,
    width: '100%',
  },
  wideScreen: { maxWidth: 960 },
  pressedControl: { opacity: 0.78 },
});
