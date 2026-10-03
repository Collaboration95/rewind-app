import Constants from 'expo-constants';
import { Platform } from 'react-native';

export interface ReminderIntent {
  groupId: string;
  reminderId: string;
}
const opaqueId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function parseReminderIntent(value: unknown): ReminderIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  return data.kind === 'weekly-reminder' && opaqueId(data.groupId) && opaqueId(data.reminderId)
    ? { groupId: data.groupId, reminderId: data.reminderId }
    : null;
}

export function reminderIntentFromUrl(value: string): ReminderIntent | null {
  try {
    const url = new URL(value);
    if (
      url.searchParams.getAll('rewindReminder').length !== 1 ||
      url.searchParams.getAll('rewindGroup').length !== 1
    )
      return null;
    return parseReminderIntent({
      kind: 'weekly-reminder',
      groupId: url.searchParams.get('rewindGroup'),
      reminderId: url.searchParams.get('rewindReminder'),
    });
  } catch {
    return null;
  }
}

// Taps are hints containing opaque IDs. The owner must reload server-authorized
// context before opening a group; no title, body, URL or media is consumed here.
export function subscribeToReminderIntents(
  handle: (intent: ReminderIntent) => void | Promise<void>,
): () => void {
  let active = true;
  let remove = () => {};
  const seen = new Set<string>();
  const receive = (value: unknown) => {
    const intent = parseReminderIntent(value);
    if (!active || !intent || seen.has(intent.reminderId)) return;
    seen.add(intent.reminderId);
    if (seen.size > 64) seen.delete(seen.values().next().value!);
    void handle(intent);
  };
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof navigator !== 'undefined') {
    const intent = reminderIntentFromUrl(window.location.href);
    if (intent) {
      receive({ kind: 'weekly-reminder', ...intent });
      const url = new URL(window.location.href);
      url.searchParams.delete('rewindReminder');
      url.searchParams.delete('rewindGroup');
      window.history.replaceState(window.history.state, '', url.href);
    }
    if ('serviceWorker' in navigator) {
      const listener = (event: MessageEvent) => {
        if (
          !navigator.serviceWorker.controller ||
          event.source !== navigator.serviceWorker.controller
        )
          return;
        receive(event.data);
      };
      navigator.serviceWorker.addEventListener('message', listener);
      remove = () => navigator.serviceWorker.removeEventListener('message', listener);
    }
  } else if (
    ['ios', 'android'].includes(Platform.OS) &&
    Constants.executionEnvironment !== 'storeClient' &&
    Constants.expoGoConfig == null &&
    (Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId)
  ) {
    void import('expo-notifications')
      .then((notifications) => {
        if (!active) return;
        const subscription = notifications.addNotificationResponseReceivedListener((response) =>
          receive(response.notification.request.content.data),
        );
        remove = () => subscription.remove();
        void notifications
          .getLastNotificationResponseAsync()
          .then((response) => {
            if (response) receive(response.notification.request.content.data);
          })
          .catch(() => {});
      })
      .catch(() => {});
  }
  return () => {
    active = false;
    remove();
  };
}
