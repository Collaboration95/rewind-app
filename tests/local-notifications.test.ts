// Simulate the fatal Expo Go remote-push boundary, without relying on Jest's
// usual native mocks to silently accept a package-wide import.
jest.mock('expo-notifications', () => {
  throw new Error('Remote push package entry must not load for local reminders');
});
jest.mock('expo-notifications/build/DevicePushTokenAutoRegistration.fx', () => {
  throw new Error('Remote push registration is unavailable in Android Expo Go');
});

it('loads local reminder APIs without initializing remote push registration', () => {
  const local = jest.requireActual('../src/reminders/local-notifications');
  expect(local.getPermissionsAsync).toEqual(expect.any(Function));
  expect(local.scheduleNotificationAsync).toEqual(expect.any(Function));
  expect(local.setNotificationHandler).toEqual(expect.any(Function));
  expect(local.SchedulableTriggerInputTypes.WEEKLY).toBe('weekly');
});
