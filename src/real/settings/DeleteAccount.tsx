import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import {
  Button,
  Dialog,
  ErrorText,
  Field,
  Glass,
  Lead,
  ScreenScroll,
  SubHeader,
} from '../../ui/primitives';
import { FONT, WARM } from '../../ui/tokens';
import type { SettingsGroup, SettingsScreenProps } from './types';

/* ---------- S19–S20 Delete account ---------- */

export function DeleteAccount<T extends SettingsGroup>({
  onBack,
  onDeleteAccount,
  signInMethod,
}: SettingsScreenProps<T>) {
  const typedConfirmation = signInMethod === 'cognito';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const remove = async () => {
    setPending(true);
    const outcome = await onDeleteAccount(password);
    if (!mounted.current) return;
    setPending(false);
    setConfirm(false);
    if (outcome === 'incorrect')
      setError(typedConfirmation ? 'Type DELETE exactly as shown.' : 'The password is incorrect.');
    else if (outcome === 'throttled') setError('Too many attempts. Try again later.');
    else if (outcome === 'unavailable')
      setError('Your account could not be deleted. Retry when connected.');
  };
  return (
    <>
      <ScreenScroll>
        <SubHeader onBack={onBack} title="Delete account" />
        <Glass style={styles.deleteCard}>
          <Text style={styles.deleteLead}>This deletes your account for good:</Text>
          <Text style={styles.bullet}>
            {typedConfirmation ? '• your profile and sign-in' : '• your username and password'}
          </Text>
          <Text style={styles.bullet}>• your chat messages</Text>
          <Text style={styles.bullet}>
            • your photos and videos (films already made stay with the group)
          </Text>
        </Glass>
        <Lead>
          Groups you own pass to the member who joined next. Saved copies on people’s phones stay
          theirs.
        </Lead>
        {typedConfirmation ? (
          <Field
            autoCapitalize="characters"
            autoCorrect={false}
            label="Type DELETE to confirm"
            onChangeText={(value) => {
              setPassword(value);
              setError(null);
            }}
            spellCheck={false}
            testID="real-delete-confirmation"
            value={password}
          />
        ) : (
          <Field
            autoCapitalize="none"
            autoComplete="current-password"
            label="Password"
            onChangeText={(value) => {
              setPassword(value);
              setError(null);
            }}
            secureTextEntry
            testID="real-delete-password"
            textContentType="password"
            value={password}
          />
        )}
        <ErrorText testID="real-delete-error">{error}</ErrorText>
        <Button
          disabled={typedConfirmation ? password !== 'DELETE' : !password}
          label="Delete account"
          onPress={() => setConfirm(true)}
          testID="real-delete-account"
          variant="danger"
        />
      </ScreenScroll>
      {confirm ? (
        <Dialog
          body="This can’t be undone. You’ll be signed out on every device."
          label="Delete account confirmation"
          onDismiss={pending ? undefined : () => setConfirm(false)}
          testID="real-delete-dialog"
          title="Delete your account?"
        >
          <Button disabled={pending} label="Keep my account" onPress={() => setConfirm(false)} />
          <Button
            busy={pending}
            busyLabel="Deleting…"
            label="Delete for good"
            onPress={() => void remove()}
            testID="real-delete-confirm"
            variant="danger"
          />
        </Dialog>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  deleteCard: { gap: 6, marginBottom: 18, paddingHorizontal: 18, paddingVertical: 20 },
  deleteLead: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  bullet: { color: WARM.ink, fontFamily: FONT.body, fontSize: 13.5, lineHeight: 21 },
});
