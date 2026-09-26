// SDK 57's package entry point also loads remote push auto-registration, which
// throws in Android Expo Go. Import only the local reminder APIs. Keep this
// boundary covered when upgrading expo-notifications; these are SDK module paths.
export {
  getPermissionsAsync,
  requestPermissionsAsync,
} from 'expo-notifications/build/NotificationPermissions';
export { scheduleNotificationAsync } from 'expo-notifications/build/scheduleNotificationAsync';
export { cancelScheduledNotificationAsync } from 'expo-notifications/build/cancelScheduledNotificationAsync';
export { setNotificationChannelAsync } from 'expo-notifications/build/setNotificationChannelAsync';
export { setNotificationHandler } from 'expo-notifications/build/NotificationsHandler';
export { SchedulableTriggerInputTypes } from 'expo-notifications/build/Notifications.types';
export { AndroidImportance } from 'expo-notifications/build/NotificationChannelManager.types';
export type {
  NotificationRequestInput,
  NotificationContentInput,
} from 'expo-notifications/build/Notifications.types';
export type {
  NotificationChannelInput,
  NotificationChannel,
} from 'expo-notifications/build/NotificationChannelManager.types';
export type { NotificationHandler } from 'expo-notifications/build/NotificationsHandler';
