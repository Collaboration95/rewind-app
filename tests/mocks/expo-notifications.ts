export const AndroidImportance = { DEFAULT: 3 } as const;

export const SchedulableTriggerInputTypes = {
  CALENDAR: 'calendar',
  WEEKLY: 'weekly',
} as const;

export const getPermissionsAsync = jest.fn(async () => ({
  granted: false,
  status: 'undetermined',
}));

export const requestPermissionsAsync = jest.fn(async () => ({
  granted: false,
  status: 'undetermined',
}));

export const scheduleNotificationAsync = jest.fn(async () => 'mock-notification');
export const cancelScheduledNotificationAsync = jest.fn(async () => undefined);
export const setNotificationChannelAsync = jest.fn(async () => null);
export const setNotificationHandler = jest.fn();
