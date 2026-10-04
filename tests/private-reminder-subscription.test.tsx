import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { PrivateReminderSubscription } from '../src/reminders/PrivateReminderSubscription';
import type {
  PrivateReminderClient,
  PrivateReminderSnapshot,
} from '../src/reminders/private-reminder-client';

const available: PrivateReminderSnapshot = {
  state: 'available',
  enabled: false,
  canEnable: true,
  canDisable: false,
  message: 'Enable reminders with the button.',
};
const registered: PrivateReminderSnapshot = {
  state: 'enabled',
  enabled: true,
  canEnable: false,
  canDisable: true,
  message: 'This device is registered. Reminder delivery is not confirmed.',
};
function fixture(): PrivateReminderClient {
  return {
    load: jest.fn(async () => available),
    enable: jest.fn(async () => registered),
    disable: jest.fn(async () => available),
    revoke: jest.fn(async () => ({ ...available, state: 'revoked' as const, canEnable: false })),
  };
}
it('loads support without opt-in and enables/disables only from explicit accessible buttons', async () => {
  const client = fixture();
  const ui = await render(<PrivateReminderSubscription client={client} />);
  await ui.findByText(available.message);
  expect(client.enable).not.toHaveBeenCalled();
  expect(client.disable).not.toHaveBeenCalled();
  await fireEvent.press(ui.getByTestId('private-reminder-enable'));
  await ui.findByText(registered.message);
  expect(client.enable).toHaveBeenCalledTimes(1);
  expect(ui.getByTestId('private-reminder-enable').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(ui.getByTestId('private-reminder-disable'));
  await ui.findByText(available.message);
  expect(client.disable).toHaveBeenCalledTimes(1);
});
it('keeps unsupported builds usable without an enabled opt-in control', async () => {
  const client = fixture();
  client.load = jest.fn(async () => ({
    ...available,
    state: 'unsupported' as const,
    canEnable: false,
    message: 'Use a configured development build; Expo Go is unsupported.',
  }));
  const ui = await render(<PrivateReminderSubscription client={client} />);
  await ui.findByText('Use a configured development build; Expo Go is unsupported.');
  expect(ui.getByTestId('private-reminder-enable').props.accessibilityState.disabled).toBe(true);
  expect(ui.getByTestId('private-reminder-check').props.accessibilityState.disabled).toBe(false);
  expect(client.enable).not.toHaveBeenCalled();
});
it('disables repeated presses while opt-in is pending', async () => {
  const client = fixture();
  let finish!: (value: PrivateReminderSnapshot) => void;
  client.enable = jest.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ui = await render(<PrivateReminderSubscription client={client} />);
  await ui.findByText(available.message);
  await fireEvent.press(ui.getByTestId('private-reminder-enable'));
  expect(ui.getByTestId('private-reminder-enable').props.accessibilityState.disabled).toBe(true);
  expect(ui.getByTestId('private-reminder-check').props.accessibilityState.disabled).toBe(true);
  await act(async () => {
    finish(registered);
  });
  await waitFor(() =>
    expect(ui.getByTestId('private-reminder-check').props.accessibilityState.disabled).toBe(false),
  );
});
it('discards a delayed old-client result when lead replaces the scoped client', async () => {
  const oldClient = fixture();
  const nextClient = fixture();
  let finish!: (value: PrivateReminderSnapshot) => void;
  oldClient.enable = jest.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ui = await render(<PrivateReminderSubscription client={oldClient} />);
  await ui.findByText(available.message);
  await fireEvent.press(ui.getByTestId('private-reminder-enable'));
  await ui.rerender(<PrivateReminderSubscription client={nextClient} />);
  await ui.findByText(available.message);
  await act(async () => {
    finish(registered);
  });
  expect(ui.queryByText(registered.message)).toBeNull();
  expect(ui.getByTestId('private-reminder-enable').props.accessibilityState.disabled).toBe(false);
});
