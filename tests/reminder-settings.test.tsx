import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ReminderSettings } from '../src/reminders/ReminderSettings';
import type { ReminderService, ReminderSnapshot } from '../src/reminders/reminder-service';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const supportedDisabled: ReminderSnapshot = {
  availability: 'supported',
  enabled: false,
  message: 'Sunday 7pm local reminders are disabled.',
};

function serviceFixture(initial = supportedDisabled): ReminderService {
  return {
    load: jest.fn().mockResolvedValue(initial),
    enable: jest.fn().mockResolvedValue({
      availability: 'supported',
      enabled: true,
      message: 'Sunday 7pm local reminders are enabled on this device.',
    }),
    disable: jest.fn().mockResolvedValue(supportedDisabled),
    triggerTest: jest.fn().mockResolvedValue({
      availability: 'supported',
      enabled: initial.enabled,
      message: 'A local test reminder was triggered.',
    }),
    clear: jest.fn().mockResolvedValue(undefined),
  };
}

describe('ReminderSettings', () => {
  it('lets a member enable the weekly reminder and trigger a local test', async () => {
    const service = serviceFixture();
    const result = await render(<ReminderSettings service={service} />);

    await waitFor(() => expect(result.getByTestId('reminder-toggle')).toBeTruthy());
    await fireEvent.press(result.getByTestId('reminder-toggle'));
    expect(service.enable).toHaveBeenCalledTimes(1);
    expect(await result.findByText(/enabled on this device/)).toBeTruthy();

    await fireEvent.press(result.getByTestId('reminder-test'));
    expect(service.triggerTest).toHaveBeenCalledTimes(1);
    expect(await result.findByText('A local test reminder was triggered.')).toBeTruthy();
  });

  it('lets a member disable an enabled weekly reminder', async () => {
    const service = serviceFixture({
      availability: 'supported',
      enabled: true,
      message: 'Sunday 7pm local reminders are enabled on this device.',
    });
    const result = await render(<ReminderSettings service={service} />);

    await fireEvent.press(await result.findByTestId('reminder-toggle'));

    expect(service.disable).toHaveBeenCalledTimes(1);
    expect(await result.findByText('Sunday 7pm local reminders are disabled.')).toBeTruthy();
    expect(result.getByTestId('reminder-toggle').props.accessibilityState.checked).toBe(false);
  });

  it('shows unsupported state and disables actions on web', async () => {
    const service = serviceFixture({
      availability: 'unsupported',
      enabled: false,
      message: 'Local notifications are unavailable in the web demo.',
    });
    const result = await render(<ReminderSettings service={service} />);

    expect(await result.findByTestId('reminder-unsupported')).toBeTruthy();
    expect(result.getByTestId('reminder-toggle').props.accessibilityState.disabled).toBe(true);
    expect(result.getByTestId('reminder-test').props.accessibilityState.disabled).toBe(true);
    expect(service.enable).not.toHaveBeenCalled();
  });

  it('shows the permission-denied explanation without hiding the setting', async () => {
    const service = serviceFixture({
      availability: 'permission-denied',
      enabled: false,
      message: 'Notifications are denied for Rewind.',
    });
    const result = await render(<ReminderSettings service={service} />);

    expect(await result.findByTestId('reminder-permission-denied')).toBeTruthy();
    expect(result.getByText(/device settings/)).toBeTruthy();
    expect(result.getByTestId('reminder-toggle')).toBeTruthy();
  });

  it('explains undecided permission and keeps enabling available', async () => {
    const service = serviceFixture({
      availability: 'permission-undecided',
      enabled: false,
      message: 'Allow notifications to enable the Sunday 7pm reminder.',
    });
    const result = await render(<ReminderSettings service={service} />);

    expect(await result.findByTestId('reminder-permission-undecided')).toBeTruthy();
    expect(result.getByTestId('reminder-toggle').props.accessibilityState.disabled).toBe(false);
    expect(result.getByTestId('reminder-test').props.accessibilityState.disabled).toBe(false);
  });

  it('shows a load error and keeps actions disabled until a status is available', async () => {
    const service = serviceFixture();
    service.load = jest.fn().mockRejectedValue(new Error('storage unavailable'));
    const result = await render(<ReminderSettings service={service} />);

    expect(await result.findByRole('alert')).toHaveTextContent(
      'Reminder status could not be loaded. Try again.',
    );
    expect(result.getByTestId('reminder-toggle').props.accessibilityState.disabled).toBe(true);
    expect(result.getByTestId('reminder-test').props.accessibilityState.disabled).toBe(true);
  });

  it('shows an update error and restores the controls after a failed enable', async () => {
    const service = serviceFixture();
    service.enable = jest.fn().mockRejectedValue(new Error('native failure'));
    const result = await render(<ReminderSettings service={service} />);

    await fireEvent.press(await result.findByTestId('reminder-toggle'));

    expect(await result.findByRole('alert')).toHaveTextContent(
      'The local reminder could not be updated. Try again on this device.',
    );
    expect(result.getByTestId('reminder-toggle').props.accessibilityState.disabled).toBe(false);
    expect(result.getByTestId('reminder-test').props.accessibilityState.disabled).toBe(false);
  });
});
