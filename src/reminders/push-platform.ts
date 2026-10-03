import Constants from 'expo-constants';
import { Platform } from 'react-native';

export type PushPermission = 'granted' | 'denied' | 'default';
export type PushDestination =
  { token: string } | { endpoint: string; keys: { p256dh: string; auth: string } };

export interface PreparedPushPlatform {
  provider: 'webpush' | 'expo';
  permission(): Promise<PushPermission>;
  // Called directly from the opt-in gesture after prepare/config have completed.
  subscribe(publicKey: string | null, active: () => boolean): Promise<PushDestination>;
  unsubscribe(): Promise<void>;
}
export interface PushPlatform {
  prepare(): Promise<PreparedPushPlatform | { unsupported: string }>;
}

interface WebSubscription {
  expirationTime?: number | null;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}
interface WebRegistration {
  active: unknown;
  pushManager: {
    getSubscription(): Promise<WebSubscription | null>;
    subscribe(options: {
      userVisibleOnly: true;
      applicationServerKey: Uint8Array<ArrayBuffer>;
    }): Promise<WebSubscription>;
  };
}
export interface WebPushEnvironment {
  secure: boolean;
  installed: boolean;
  pushSupported: boolean;
  permission(): PushPermission;
  registration(): Promise<WebRegistration | undefined>;
  decode(value: string): string;
}

export function createWebPushPlatform(environment: WebPushEnvironment): PushPlatform {
  return {
    async prepare() {
      if (!environment.secure || !environment.installed || !environment.pushSupported)
        return {
          unsupported:
            'Install Rewind on your Home Screen in a browser that supports secure push notifications.',
        };
      const registration = await environment.registration();
      if (!registration?.active || !registration.pushManager)
        return {
          unsupported: 'Reopen the installed app online to activate its notification support.',
        };
      let subscription = await registration.pushManager.getSubscription();
      return {
        provider: 'webpush',
        permission: async () => environment.permission(),
        async subscribe(publicKey, active) {
          if (!active()) throw new Error('inactive');
          if (environment.permission() === 'denied') throw new Error('denied');
          if (!publicKey || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)) throw new Error('unconfigured');
          const binary = environment.decode(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '=');
          const key = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          if (key.length !== 65 || key[0] !== 4) throw new Error('unconfigured');
          // No awaited network/permission work precedes subscribe: retain the gesture.
          if (
            !subscription ||
            (subscription.expirationTime && subscription.expirationTime <= Date.now())
          )
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: key,
            });
          if (!active()) throw new Error('inactive');
          const value = subscription.toJSON();
          if (!value.endpoint || !value.keys?.p256dh || !value.keys?.auth)
            throw new Error('invalid');
          return {
            endpoint: value.endpoint,
            keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
          };
        },
        async unsubscribe() {
          const current = subscription ?? (await registration.pushManager.getSubscription());
          if (current && !(await current.unsubscribe())) throw new Error('cleanup');
          subscription = null;
        },
      };
    },
  };
}

export interface NativeNotifications {
  getPermissionsAsync(): Promise<{ granted: boolean; status: string }>;
  requestPermissionsAsync(options: {
    ios: { allowAlert: true; allowBadge: false; allowSound: true };
  }): Promise<{ granted: boolean; status: string }>;
  getExpoPushTokenAsync(options: { projectId: string }): Promise<{ data: string }>;
  setNotificationChannelAsync(
    id: string,
    options: { name: string; importance: number },
  ): Promise<unknown>;
  AndroidImportance: { DEFAULT: number };
}
export function createNativePushPlatform({
  platform,
  expoGo,
  projectId,
  physicalDevice,
  notifications,
}: {
  platform: string;
  expoGo: boolean;
  projectId?: string;
  physicalDevice: () => Promise<boolean>;
  notifications: () => Promise<NativeNotifications>;
}): PushPlatform {
  return {
    async prepare() {
      if (expoGo || !['ios', 'android'].includes(platform))
        return {
          unsupported:
            'Remote reminders need an iOS or Android development/installed build. Expo Go is unsupported.',
        };
      if (!projectId)
        return { unsupported: 'This build has no Expo project configured for remote reminders.' };
      if (!(await physicalDevice()))
        return {
          unsupported:
            'Remote reminders need a physical device and a configured development/installed build.',
        };
      // Expo Go must never evaluate expo-notifications, including on Android.
      const native = await notifications();
      const permission = async (): Promise<PushPermission> => {
        const value = await native.getPermissionsAsync();
        return value.granted ? 'granted' : value.status === 'denied' ? 'denied' : 'default';
      };
      return {
        provider: 'expo',
        permission,
        async subscribe(_publicKey, active) {
          if (!active()) throw new Error('inactive');
          if (platform === 'android') {
            await native.setNotificationChannelAsync('rewind-private-reminders', {
              name: 'Private group reminders',
              importance: native.AndroidImportance.DEFAULT,
            });
          }
          if (!active()) throw new Error('inactive');
          let allowed = await permission();
          if (!active()) throw new Error('inactive');
          if (allowed === 'default') {
            const requested = await native.requestPermissionsAsync({
              ios: { allowAlert: true, allowBadge: false, allowSound: true },
            });
            allowed = requested.granted ? 'granted' : 'denied';
          }
          if (!active() || allowed !== 'granted') throw new Error('denied');
          const token = await native.getExpoPushTokenAsync({ projectId });
          if (!active()) throw new Error('inactive');
          return { token: token.data };
        },
        // Expo tokens cannot be unregistered locally. Server disable/revocation is authoritative.
        unsubscribe: async () => {},
      };
    },
  };
}

export function defaultPushPlatform(): PushPlatform {
  if (Platform.OS === 'web') {
    const available = typeof window !== 'undefined' && typeof navigator !== 'undefined';
    return createWebPushPlatform({
      secure: available && window.isSecureContext,
      installed:
        available &&
        (window.matchMedia?.('(display-mode: standalone)').matches === true ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true),
      pushSupported:
        available &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window,
      permission: () => Notification.permission,
      registration: async () => navigator.serviceWorker.getRegistration(),
      decode: (value) => window.atob(value),
    });
  }
  return createNativePushPlatform({
    platform: Platform.OS,
    expoGo: Constants.executionEnvironment === 'storeClient' || Constants.expoGoConfig != null,
    projectId: Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId,
    physicalDevice: async () => (await import('expo-device')).isDevice,
    notifications: async () => import('expo-notifications'),
  });
}
