import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const REMINDER_PREFERENCE_KEY = '@rewind/reminder-preference';
export const REMINDER_NOTIFICATION_ID_KEY = '@rewind/reminder-notification-id';
export const REMINDER_CHANNEL_ID = 'rewind-weekly-reminder';

export type ReminderAvailability =
  'supported' | 'permission-undecided' | 'permission-denied' | 'unsupported';

export interface ReminderSnapshot {
  availability: ReminderAvailability;
  enabled: boolean;
  message: string;
}

export interface ReminderStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ReminderNotificationAdapter {
  getPermissionsAsync(): Promise<{ granted: boolean; status: string }>;
  requestPermissionsAsync(): Promise<{ granted: boolean; status: string }>;
  scheduleNotificationAsync(request: Notifications.NotificationRequestInput): Promise<string>;
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
  setNotificationChannelAsync?: (
    channelId: string,
    channel: Notifications.NotificationChannelInput,
  ) => Promise<Notifications.NotificationChannel | null>;
  setNotificationHandler?: (handler: Notifications.NotificationHandler) => void;
}

export interface ReminderServiceDependencies {
  notifications?: ReminderNotificationAdapter;
  storage?: ReminderStorage;
  platform?: string;
}

export interface ReminderService {
  load(): Promise<ReminderSnapshot>;
  enable(): Promise<ReminderSnapshot>;
  disable(): Promise<ReminderSnapshot>;
  triggerTest(): Promise<ReminderSnapshot>;
  clear(): Promise<void>;
}

const WEEKLY_REMINDER_CONTENT: Notifications.NotificationContentInput = {
  title: 'Rewind reminder',
  body: 'It is time to add a moment to your group.',
  data: { type: 'rewind-weekly-reminder' },
  sound: 'default',
};

const TEST_REMINDER_CONTENT: Notifications.NotificationContentInput = {
  title: 'Rewind test reminder',
  body: 'Local reminders are working on this device.',
  data: { type: 'rewind-test-reminder' },
  sound: 'default',
};

const nativeNotifications: ReminderNotificationAdapter = {
  getPermissionsAsync: Notifications.getPermissionsAsync,
  requestPermissionsAsync: () =>
    Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    }),
  scheduleNotificationAsync: Notifications.scheduleNotificationAsync,
  cancelScheduledNotificationAsync: Notifications.cancelScheduledNotificationAsync,
  setNotificationChannelAsync: Notifications.setNotificationChannelAsync,
  setNotificationHandler: Notifications.setNotificationHandler,
};

const asyncStorage: ReminderStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

function isSupported(platform: string) {
  return platform !== 'web';
}

function isGranted(status: { granted: boolean; status: string }) {
  return status.granted || status.status === 'granted';
}

function availabilityFor(status: { granted: boolean; status: string }): ReminderAvailability {
  if (isGranted(status)) return 'supported';
  return status.status === 'undetermined' ? 'permission-undecided' : 'permission-denied';
}

function snapshot(
  availability: ReminderAvailability,
  enabled: boolean,
  message: string,
): ReminderSnapshot {
  return { availability, enabled, message };
}

function unsupportedSnapshot(): ReminderSnapshot {
  return snapshot(
    'unsupported',
    false,
    'Local notifications are unavailable in the web demo. Use a supported iOS or Android device.',
  );
}

function permissionMessage(availability: ReminderAvailability) {
  return availability === 'permission-undecided'
    ? 'Allow notifications to enable the Sunday 7pm reminder.'
    : 'Notifications are denied for Rewind. Enable them in this device’s app settings.';
}

export function createReminderService({
  notifications = nativeNotifications,
  storage = asyncStorage,
  platform = Platform.OS,
}: ReminderServiceDependencies = {}): ReminderService {
  let handlerConfigured = false;

  function configureHandler() {
    if (!isSupported(platform) || handlerConfigured || !notifications.setNotificationHandler)
      return;
    notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    handlerConfigured = true;
  }

  configureHandler();

  async function storedEnabled() {
    return (await storage.getItem(REMINDER_PREFERENCE_KEY)) === 'enabled';
  }

  async function permissionSnapshot(enabled: boolean) {
    if (!isSupported(platform)) return unsupportedSnapshot();
    const permissions = await notifications.getPermissionsAsync();
    const availability = availabilityFor(permissions);
    return snapshot(
      availability,
      enabled && availability === 'supported',
      availability === 'supported'
        ? enabled
          ? 'Sunday 7pm local reminders are enabled on this device.'
          : 'Sunday 7pm local reminders are disabled.'
        : permissionMessage(availability),
    );
  }

  async function ensurePermission(enabled: boolean) {
    if (!isSupported(platform)) return unsupportedSnapshot();
    let permissions = await notifications.getPermissionsAsync();
    if (!isGranted(permissions)) {
      permissions = await notifications.requestPermissionsAsync();
    }
    const availability = availabilityFor(permissions);
    return snapshot(
      availability,
      enabled && availability === 'supported',
      availability === 'supported' ? '' : permissionMessage(availability),
    );
  }

  async function cancelStoredReminder() {
    const identifier = await storage.getItem(REMINDER_NOTIFICATION_ID_KEY);
    if (identifier) await notifications.cancelScheduledNotificationAsync(identifier);
    await storage.removeItem(REMINDER_NOTIFICATION_ID_KEY);
  }

  async function scheduleWeeklyReminder() {
    configureHandler();
    await ensureAndroidChannel();
    return notifications.scheduleNotificationAsync({
      content: WEEKLY_REMINDER_CONTENT,
      trigger:
        platform === 'android'
          ? {
              type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
              weekday: 1,
              hour: 19,
              minute: 0,
              channelId: REMINDER_CHANNEL_ID,
            }
          : {
              type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
              weekday: 1,
              hour: 19,
              minute: 0,
              repeats: true,
            },
    });
  }

  async function ensureAndroidChannel() {
    if (platform === 'android' && notifications.setNotificationChannelAsync) {
      await notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
        name: 'Weekly reminders',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
  }

  return {
    async load() {
      return permissionSnapshot(await storedEnabled());
    },

    async enable() {
      const permission = await ensurePermission(false);
      if (permission.availability !== 'supported') return permission;

      await cancelStoredReminder();
      const identifier = await scheduleWeeklyReminder();
      try {
        await storage.setItem(REMINDER_NOTIFICATION_ID_KEY, identifier);
        await storage.setItem(REMINDER_PREFERENCE_KEY, 'enabled');
      } catch (error) {
        try {
          await notifications.cancelScheduledNotificationAsync(identifier);
        } finally {
          await storage.removeItem(REMINDER_NOTIFICATION_ID_KEY);
          await storage.removeItem(REMINDER_PREFERENCE_KEY);
        }
        throw error;
      }
      return snapshot('supported', true, 'Sunday 7pm local reminders are enabled on this device.');
    },

    async disable() {
      if (!isSupported(platform)) return unsupportedSnapshot();
      await cancelStoredReminder();
      await storage.removeItem(REMINDER_PREFERENCE_KEY);
      return snapshot('supported', false, 'Sunday 7pm local reminders are disabled.');
    },

    async clear() {
      try {
        if (isSupported(platform)) await cancelStoredReminder();
      } finally {
        await storage.removeItem(REMINDER_PREFERENCE_KEY);
        await storage.removeItem(REMINDER_NOTIFICATION_ID_KEY);
      }
    },

    async triggerTest() {
      const permission = await ensurePermission(false);
      if (permission.availability !== 'supported') return permission;
      configureHandler();
      await ensureAndroidChannel();
      await notifications.scheduleNotificationAsync({
        content: TEST_REMINDER_CONTENT,
        trigger: platform === 'android' ? { channelId: REMINDER_CHANNEL_ID } : null,
      });
      return snapshot('supported', await storedEnabled(), 'A local test reminder was triggered.');
    },
  };
}

export const reminderService = createReminderService();
