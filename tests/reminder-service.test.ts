import {
  createReminderService,
  REMINDER_NOTIFICATION_ID_KEY,
  REMINDER_PREFERENCE_KEY,
  type ReminderNotificationAdapter,
  type ReminderStorage,
} from '../src/reminders/reminder-service';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function storageFixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: ReminderStorage = {
    getItem: jest.fn(async (key) => values.get(key) ?? null),
    setItem: jest.fn(async (key, value) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async (key) => {
      values.delete(key);
    }),
  };
  return { storage, values };
}

function notificationsFixture(
  permissions: { granted: boolean; status: string } = { granted: true, status: 'granted' },
  requestedPermissions = permissions,
) {
  const notifications: ReminderNotificationAdapter = {
    getPermissionsAsync: jest.fn(async () => permissions),
    requestPermissionsAsync: jest.fn(async () => requestedPermissions),
    scheduleNotificationAsync: jest.fn(async () => 'notification-1'),
    cancelScheduledNotificationAsync: jest.fn(async () => undefined),
    setNotificationChannelAsync: jest.fn(async () => null),
    setNotificationHandler: jest.fn(),
  };
  return notifications;
}

describe('local reminder service', () => {
  it('enables a Sunday 7pm local reminder and persists the scheduled identifier', async () => {
    const { storage, values } = storageFixture();
    const notifications = notificationsFixture();
    const service = createReminderService({ notifications, storage, platform: 'android' });

    const result = await service.enable();

    expect(result).toEqual({
      availability: 'supported',
      enabled: true,
      message: 'Sunday 7pm local reminders are enabled on this device.',
    });
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      'rewind-weekly-reminder',
      expect.objectContaining({ name: 'Weekly reminders' }),
    );
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: expect.objectContaining({ title: 'Rewind reminder' }),
      trigger: expect.objectContaining({ weekday: 1, hour: 19, minute: 0, type: 'weekly' }),
    });
    expect(values.get(REMINDER_PREFERENCE_KEY)).toBe('enabled');
    expect(values.get(REMINDER_NOTIFICATION_ID_KEY)).toBe('notification-1');
    await expect(service.load()).resolves.toEqual(result);
  });

  it('requests undecided permission and schedules only after permission is granted', async () => {
    const { storage } = storageFixture();
    const notifications = notificationsFixture(
      { granted: false, status: 'undetermined' },
      { granted: true, status: 'granted' },
    );
    const service = createReminderService({ notifications, storage, platform: 'ios' });

    await expect(service.load()).resolves.toEqual({
      availability: 'permission-undecided',
      enabled: false,
      message: 'Allow notifications to enable the Sunday 7pm reminder.',
    });

    const result = await service.enable();

    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(result.enabled).toBe(true);
  });

  it('disables and cancels the previously scheduled local reminder', async () => {
    const { storage, values } = storageFixture({
      [REMINDER_PREFERENCE_KEY]: 'enabled',
      [REMINDER_NOTIFICATION_ID_KEY]: 'existing-notification',
    });
    const notifications = notificationsFixture();
    const service = createReminderService({ notifications, storage, platform: 'ios' });

    const result = await service.disable();

    expect(result.enabled).toBe(false);
    expect(notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      'existing-notification',
    );
    expect(values.has(REMINDER_PREFERENCE_KEY)).toBe(false);
    expect(values.has(REMINDER_NOTIFICATION_ID_KEY)).toBe(false);
    await expect(service.load()).resolves.toEqual({
      availability: 'supported',
      enabled: false,
      message: 'Sunday 7pm local reminders are disabled.',
    });
  });

  it('re-enabling replaces the existing schedule without leaving duplicate identifiers', async () => {
    const { storage, values } = storageFixture({
      [REMINDER_PREFERENCE_KEY]: 'enabled',
      [REMINDER_NOTIFICATION_ID_KEY]: 'existing-notification',
    });
    const notifications = notificationsFixture();
    let nextIdentifier = 0;
    notifications.scheduleNotificationAsync = jest.fn(
      async () => `notification-${++nextIdentifier}`,
    );
    const service = createReminderService({ notifications, storage, platform: 'ios' });

    await service.enable();
    await service.enable();

    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
    expect(notifications.cancelScheduledNotificationAsync).toHaveBeenNthCalledWith(
      1,
      'existing-notification',
    );
    expect(notifications.cancelScheduledNotificationAsync).toHaveBeenNthCalledWith(
      2,
      'notification-1',
    );
    expect(values.get(REMINDER_NOTIFICATION_ID_KEY)).toBe('notification-2');
    expect(values.get(REMINDER_PREFERENCE_KEY)).toBe('enabled');
  });

  it('uses an iOS calendar trigger for the same local Sunday 7pm schedule', async () => {
    const { storage } = storageFixture();
    const notifications = notificationsFixture();
    const service = createReminderService({ notifications, storage, platform: 'ios' });

    await service.enable();

    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: expect.objectContaining({ title: 'Rewind reminder' }),
      trigger: {
        type: 'calendar',
        weekday: 1,
        hour: 19,
        minute: 0,
        repeats: true,
      },
    });
  });

  it('returns an explicit denied state without scheduling when permission is denied', async () => {
    const { storage, values } = storageFixture();
    const notifications = notificationsFixture({ granted: false, status: 'denied' });
    const service = createReminderService({ notifications, storage, platform: 'ios' });

    const result = await service.enable();

    expect(result.availability).toBe('permission-denied');
    expect(result.enabled).toBe(false);
    expect(result.message).toContain('device’s app settings');
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(values.has(REMINDER_PREFERENCE_KEY)).toBe(false);
  });

  it('registers the handler when a native service is created, but never initializes it on web', async () => {
    const { storage: nativeStorage } = storageFixture();
    const nativeNotifications = notificationsFixture();
    const nativeService = createReminderService({
      notifications: nativeNotifications,
      storage: nativeStorage,
      platform: 'ios',
    });

    expect(nativeNotifications.setNotificationHandler).toHaveBeenCalledTimes(1);

    await nativeService.enable();
    await nativeService.triggerTest();
    expect(nativeNotifications.setNotificationHandler).toHaveBeenCalledTimes(1);

    const webNotifications = notificationsFixture();
    const webService = createReminderService({ notifications: webNotifications, platform: 'web' });

    expect(webNotifications.setNotificationHandler).not.toHaveBeenCalled();
    await webService.triggerTest();
    expect(webNotifications.setNotificationHandler).not.toHaveBeenCalled();
  });

  it('does not claim support or call native notifications on web', async () => {
    const notifications = notificationsFixture();
    const service = createReminderService({ notifications, platform: 'web' });

    const result = await service.triggerTest();

    expect(result.availability).toBe('unsupported');
    expect(result.message).toContain('web demo');
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('triggers an immediate local test reminder without enabling the weekly preference', async () => {
    const { storage } = storageFixture();
    const notifications = notificationsFixture();
    const service = createReminderService({ notifications, storage, platform: 'ios' });

    const result = await service.triggerTest();

    expect(result.message).toBe('A local test reminder was triggered.');
    expect(result.enabled).toBe(false);
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: expect.objectContaining({ title: 'Rewind test reminder' }),
      trigger: null,
    });
    expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('keeps an enabled weekly preference and schedule intact when testing immediately', async () => {
    const { storage, values } = storageFixture({
      [REMINDER_PREFERENCE_KEY]: 'enabled',
      [REMINDER_NOTIFICATION_ID_KEY]: 'weekly-notification',
    });
    const notifications = notificationsFixture();
    const service = createReminderService({ notifications, storage, platform: 'ios' });

    const result = await service.triggerTest();

    expect(result.enabled).toBe(true);
    expect(notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(values.get(REMINDER_PREFERENCE_KEY)).toBe('enabled');
    expect(values.get(REMINDER_NOTIFICATION_ID_KEY)).toBe('weekly-notification');
  });

  it('creates the Android channel before triggering an immediate test reminder', async () => {
    const { storage } = storageFixture();
    const notifications = notificationsFixture();
    const service = createReminderService({ notifications, storage, platform: 'android' });

    await service.triggerTest();

    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      'rewind-weekly-reminder',
      expect.objectContaining({ name: 'Weekly reminders' }),
    );
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: expect.objectContaining({ title: 'Rewind test reminder' }),
      trigger: { channelId: 'rewind-weekly-reminder' },
    });
  });

  it('rolls back a scheduled notification when preference persistence fails', async () => {
    const notifications = notificationsFixture();
    const storage: ReminderStorage = {
      getItem: jest.fn(async () => null),
      setItem: jest.fn(async (key) => {
        if (key === REMINDER_PREFERENCE_KEY) throw new Error('storage unavailable');
      }),
      removeItem: jest.fn(async () => undefined),
    };
    const service = createReminderService({ notifications, storage, platform: 'ios' });

    await expect(service.enable()).rejects.toThrow('storage unavailable');
    expect(notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notification-1');
    expect(storage.removeItem).toHaveBeenCalledWith(REMINDER_NOTIFICATION_ID_KEY);
  });

  it('clears persisted state even when cancelling the native reminder fails', async () => {
    const { storage, values } = storageFixture({
      [REMINDER_PREFERENCE_KEY]: 'enabled',
      [REMINDER_NOTIFICATION_ID_KEY]: 'existing-notification',
    });
    const notifications = notificationsFixture();
    notifications.cancelScheduledNotificationAsync = jest.fn(async () => {
      throw new Error('notifications unavailable');
    });
    const service = createReminderService({ notifications, storage, platform: 'ios' });

    await expect(service.clear()).rejects.toThrow('notifications unavailable');
    expect(values.has(REMINDER_PREFERENCE_KEY)).toBe(false);
    expect(values.has(REMINDER_NOTIFICATION_ID_KEY)).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith(REMINDER_PREFERENCE_KEY);
    expect(storage.removeItem).toHaveBeenCalledWith(REMINDER_NOTIFICATION_ID_KEY);
  });
});
