import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { RealGroupSettings } from '../src/reminders/RealGroupSettings';

const group = {
  group: { id: 'real-group-one', role: 'owner' as const, timeZone: 'Asia/Singapore' },
  cycle: { prompt: 'Initial memory' },
};
const preference = {
  enabled: false,
  snoozedUntil: null,
  timeZone: 'Asia/Singapore',
  nextScheduledAt: '2026-10-04T11:00:00Z',
  delivery: {
    state: 'not-configured',
    message: 'Reminder delivery is not configured. Your preference is saved for this group.',
  },
};
const response = (body: object, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

it('saves owner custom prompt and group timezone without sending deadlines or another member identity', async () => {
  const updated = { ...group, cycle: { prompt: 'My new memory' } };
  const request = jest
    .fn()
    .mockResolvedValueOnce(response({ preference }))
    .mockResolvedValueOnce(response({ group: updated }));
  const onUpdated = jest.fn();
  const ui = await render(
    <RealGroupSettings group={group} authenticatedRequest={request} onUpdated={onUpdated} />,
  );
  await fireEvent.press(ui.getByTestId('real-group-open-settings'));
  await ui.findByTestId('real-group-reminder-toggle');
  await fireEvent.changeText(ui.getByTestId('real-group-edit-prompt'), 'My new memory');
  await fireEvent.changeText(ui.getByTestId('real-group-timezone'), 'America/New_York');
  await fireEvent.press(ui.getByTestId('real-group-save-settings'));
  await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated));
  expect(request).toHaveBeenLastCalledWith(
    '/real/groups/real-group-one/settings',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ prompt: 'My new memory', timeZone: 'America/New_York' }),
    }),
  );
  expect(
    ui.getByText(
      'Prompt and timezone saved. The prompt applies to this collecting cycle and future cycles.',
    ),
  ).toBeTruthy();
});

it('member can save only own reminder preference and sees that delivery is unavailable', async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(response({ preference }))
    .mockResolvedValueOnce(response({ preference: { ...preference, enabled: true } }));
  const ui = await render(
    <RealGroupSettings
      group={{ ...group, group: { ...group.group, role: 'member' } }}
      authenticatedRequest={request}
      onUpdated={jest.fn()}
    />,
  );
  await fireEvent.press(ui.getByTestId('real-group-open-settings'));
  expect(ui.queryByTestId('real-group-save-settings')).toBeNull();
  expect(await ui.findByText(preference.delivery.message)).toBeTruthy();
  expect(ui.getByTestId('real-group-reminder-schedule')).toHaveTextContent(
    'Sunday 19:00 · Asia/Singapore (group timezone)',
  );
  await fireEvent.press(ui.getByTestId('real-group-reminder-toggle'));
  await waitFor(() =>
    expect(ui.getByTestId('real-group-reminder-toggle').props.accessibilityState.checked).toBe(
      true,
    ),
  );
  expect(request).toHaveBeenLastCalledWith(
    '/real/groups/real-group-one/reminders',
    expect.objectContaining({ body: JSON.stringify({ enabled: true, snoozedUntil: null }) }),
  );
});

it('denied or offline saves remain truthful and do not report success', async () => {
  const onUpdated = jest.fn();
  const request = jest
    .fn()
    .mockResolvedValueOnce(response({ preference }))
    .mockResolvedValueOnce(response({ error: 'forbidden' }, 403))
    .mockRejectedValueOnce(new Error('Offline'));
  const ui = await render(
    <RealGroupSettings group={group} authenticatedRequest={request} onUpdated={onUpdated} />,
  );
  await fireEvent.press(ui.getByTestId('real-group-open-settings'));
  await ui.findByTestId('real-group-reminder-toggle');
  await fireEvent.press(ui.getByTestId('real-group-save-settings'));
  expect(
    await ui.findByText('Only the group owner can change the prompt and timezone.'),
  ).toBeTruthy();
  await fireEvent.press(ui.getByTestId('real-group-reminder-toggle'));
  expect(await ui.findByText('Offline')).toBeTruthy();
  expect(onUpdated).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it.each(['group', 'account'] as const)(
  'discards a delayed reminder save after a %s switch and clears the old preference while loading',
  async (switchKind) => {
    const save = deferred<Response>();
    const load = deferred<Response>();
    const request = jest
      .fn()
      .mockResolvedValueOnce(response({ preference }))
      .mockReturnValueOnce(save.promise)
      .mockReturnValueOnce(load.promise);
    const nextRequest = switchKind === 'account' ? jest.fn(() => load.promise) : request;
    const nextGroup =
      switchKind === 'group'
        ? {
            group: { ...group.group, id: 'real-group-two', timeZone: 'UTC' },
            cycle: { prompt: 'Second group memory' },
          }
        : group;
    const onUpdated = jest.fn();
    const ui = await render(
      <RealGroupSettings group={group} authenticatedRequest={request} onUpdated={onUpdated} />,
    );
    await fireEvent.press(ui.getByTestId('real-group-open-settings'));
    await ui.findByTestId('real-group-reminder-toggle');
    await fireEvent.press(ui.getByTestId('real-group-reminder-toggle'));
    await ui.rerender(
      <RealGroupSettings
        group={nextGroup}
        authenticatedRequest={nextRequest}
        onUpdated={onUpdated}
      />,
    );
    expect(ui.queryByTestId('real-group-reminder-toggle')).toBeNull();
    expect(ui.getByTestId('real-group-edit-prompt').props.value).toBe(nextGroup.cycle.prompt);
    expect(ui.getByTestId('real-group-timezone').props.value).toBe(nextGroup.group.timeZone);
    await act(async () => {
      load.resolve(response({ preference: { ...preference, timeZone: nextGroup.group.timeZone } }));
    });
    await ui.findByTestId('real-group-reminder-toggle');
    await act(async () => {
      save.resolve(response({ preference: { ...preference, enabled: true } }));
    });
    expect(ui.getByTestId('real-group-reminder-toggle').props.accessibilityState).toEqual({
      checked: false,
      disabled: false,
    });
    expect(ui.queryByText('Your group reminder preference is saved.')).toBeNull();
    expect(onUpdated).not.toHaveBeenCalled();
  },
);

it.each(['success', 'failure'] as const)(
  'ignores stale settings %s and does not clear a newer pending save',
  async (outcome) => {
    const oldSave = deferred<Response>();
    const newSave = deferred<Response>();
    const request = jest
      .fn()
      .mockResolvedValueOnce(response({ preference }))
      .mockReturnValueOnce(oldSave.promise);
    const nextRequest = jest
      .fn()
      .mockResolvedValueOnce(response({ preference }))
      .mockReturnValueOnce(newSave.promise);
    const onUpdated = jest.fn();
    const ui = await render(
      <RealGroupSettings group={group} authenticatedRequest={request} onUpdated={onUpdated} />,
    );
    await fireEvent.press(ui.getByTestId('real-group-open-settings'));
    await ui.findByTestId('real-group-reminder-toggle');
    await fireEvent.press(ui.getByTestId('real-group-save-settings'));
    await ui.rerender(
      <RealGroupSettings group={group} authenticatedRequest={nextRequest} onUpdated={onUpdated} />,
    );
    await waitFor(() =>
      expect(ui.getByTestId('real-group-save-settings').props.accessibilityState.disabled).toBe(
        false,
      ),
    );
    await fireEvent.press(ui.getByTestId('real-group-save-settings'));
    await act(async () => {
      if (outcome === 'success') oldSave.resolve(response({ group }));
      else oldSave.reject(new Error('Old account offline'));
    });
    expect(onUpdated).not.toHaveBeenCalled();
    expect(ui.queryByText('Old account offline')).toBeNull();
    expect(ui.getByTestId('real-group-save-settings').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      newSave.resolve(response({ group }));
    });
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(ui.getByTestId('real-group-save-settings').props.accessibilityState.disabled).toBe(
      false,
    );
  },
);

it('ignores an old preference load after switching the selected group', async () => {
  const oldLoad = deferred<Response>();
  const request = jest
    .fn()
    .mockReturnValueOnce(oldLoad.promise)
    .mockResolvedValueOnce(response({ preference: { ...preference, timeZone: 'UTC' } }));
  const ui = await render(
    <RealGroupSettings group={group} authenticatedRequest={request} onUpdated={jest.fn()} />,
  );
  await fireEvent.press(ui.getByTestId('real-group-open-settings'));
  await ui.rerender(
    <RealGroupSettings
      group={{ ...group, group: { ...group.group, id: 'real-group-two', timeZone: 'UTC' } }}
      authenticatedRequest={request}
      onUpdated={jest.fn()}
    />,
  );
  await ui.findByTestId('real-group-reminder-toggle');
  await act(async () => {
    oldLoad.resolve(response({ preference: { ...preference, enabled: true } }));
  });
  expect(ui.getByTestId('real-group-reminder-toggle').props.accessibilityState.checked).toBe(false);
  expect(ui.getByTestId('real-group-reminder-schedule')).toHaveTextContent(
    'Sunday 19:00 · UTC (group timezone)',
  );
  expect(request).toHaveBeenLastCalledWith('/real/groups/real-group-two/reminders');
});

it('ignores a settings save after the account group screen unmounts', async () => {
  const save = deferred<Response>();
  const request = jest
    .fn()
    .mockResolvedValueOnce(response({ preference }))
    .mockReturnValueOnce(save.promise);
  const onUpdated = jest.fn();
  const ui = await render(
    <RealGroupSettings group={group} authenticatedRequest={request} onUpdated={onUpdated} />,
  );
  await fireEvent.press(ui.getByTestId('real-group-open-settings'));
  await ui.findByTestId('real-group-reminder-toggle');
  await fireEvent.press(ui.getByTestId('real-group-save-settings'));
  await ui.unmount();
  await act(async () => {
    save.resolve(response({ group }));
  });
  expect(onUpdated).not.toHaveBeenCalled();
});
