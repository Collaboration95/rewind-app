/**
 * Characterisation of src/real/Settings.tsx, rendered on its own with the same
 * props RealAccountGroupExperience passes. Pins what a person sees and which
 * requests the screen sends, ahead of a refactor. The sign-in/Members/report
 * journeys that real-settings-safety.test.tsx drives through the full App, and
 * the device-registration reminder paths in real-group-reminders.test.tsx, are
 * not repeated here.
 */
import { useState } from 'react';
import { Linking, Platform } from 'react-native';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import type { AccountDeletionOutcome } from '../src/auth/RealAccountProvider';
import { BUILT_IN_PROMPTS } from '../src/domain/groups';
import {
  SettingsScreen,
  type InviteControls,
  type SettingsGroup,
  type SettingsMember,
  type SettingsStep,
} from '../src/real/Settings';
import { ToastProvider } from '../src/ui/primitives';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

type Screen = Awaited<ReturnType<typeof render>>;
type Group = SettingsGroup & { cycle: { prompt: string; id: string } };

const response = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const baseGroup = (
  overrides: Partial<Group['group']> = {},
  prompt: string = BUILT_IN_PROMPTS[0],
): Group => ({
  memberId: 'profile-owner',
  group: {
    id: 'group-1',
    name: 'Saturday table',
    role: 'owner',
    maxMembers: 4,
    timeZone: 'Asia/Singapore',
    ...overrides,
  },
  cycle: { id: 'cycle-1', prompt },
});

const members: SettingsMember[] = [
  { memberId: 'profile-owner', displayName: 'Ada Owner', role: 'owner' },
  { memberId: 'profile-friend', displayName: 'Casey', role: 'member' },
];

const account = { displayName: 'Ada Owner', username: 'ada.owner', id: 'account-1' };

function inviteControls(overrides: Partial<InviteControls> = {}): InviteControls {
  return {
    code: null,
    pending: false,
    feedback: null,
    create: jest.fn(),
    revoke: jest.fn(),
    copy: jest.fn(),
    share: jest.fn(),
    ...overrides,
  };
}

interface Options {
  step?: SettingsStep;
  group?: Group | null;
  groups?: { id: string; name: string }[];
  members?: SettingsMember[] | null;
  membersError?: string | null;
  invite?: InviteControls;
  request?: jest.Mock;
  onBack?: jest.Mock;
  onNavigate?: jest.Mock;
  onGroupUpdated?: jest.Mock;
  onSwitchGroup?: jest.Mock;
  onJoin?: jest.Mock;
  onCreate?: jest.Mock;
  onDeleteAccount?: jest.Mock;
  signOut?: { label: string; pending: boolean; onSignOut: jest.Mock };
  signInMethod?: 'cognito' | 'password';
  notice?: string | null;
  switchPending?: boolean;
  blocked?: Set<string>;
}

/** Defaults to a reminder stub that answers "off" so the main screen settles. */
function reminderRequest() {
  return jest.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/reminders') && init?.method === 'POST')
      return response({ preference: JSON.parse(String(init.body)) });
    if (path.endsWith('/reminders'))
      return response({ preference: { enabled: false, snoozedUntil: null, timeZone: 'UTC' } });
    throw new Error(`Unexpected request: ${path}`);
  });
}

function Harness({ options }: { options: Options }) {
  const [step, setStep] = useState<SettingsStep>(options.step ?? 'main');
  const [group, setGroup] = useState<Group | null>(
    options.group === undefined ? baseGroup() : options.group,
  );
  return (
    <ToastProvider>
      <SettingsScreen
        account={account}
        authenticatedRequest={options.request ?? reminderRequest()}
        blocked={options.blocked ?? new Set()}
        group={group}
        groups={options.groups ?? [{ id: 'group-1', name: 'Saturday table' }]}
        invite={options.invite ?? inviteControls()}
        members={options.members === undefined ? members : options.members}
        membersError={options.membersError ?? null}
        notice={options.notice}
        onBack={options.onBack ?? jest.fn()}
        onBlockedChange={jest.fn()}
        onCreate={options.onCreate ?? jest.fn()}
        onDeleteAccount={options.onDeleteAccount ?? jest.fn(async () => 'deleted' as const)}
        onGroupUpdated={(next) => {
          options.onGroupUpdated?.(next);
          setGroup(next as Group);
        }}
        onJoin={options.onJoin ?? jest.fn()}
        onNavigate={(next) => {
          options.onNavigate?.(next);
          setStep(next);
        }}
        onSwitchGroup={options.onSwitchGroup ?? jest.fn(async () => true)}
        pendingInvites={0}
        reminderClient={null}
        signInMethod={options.signInMethod}
        signOut={options.signOut ?? { label: 'Sign out', pending: false, onSignOut: jest.fn() }}
        step={step}
        switchPending={options.switchPending ?? false}
      />
    </ToastProvider>
  );
}

async function show(options: Options = {}): Promise<Screen> {
  const ui = await render(<Harness options={options} />);
  // Let the reminder preference load settle on the main screen.
  if ((options.step ?? 'main') === 'main' && (options.group === undefined || options.group)) {
    await waitFor(() => expect(ui.getByRole('switch', { name: 'Weekly reminder' })).toBeEnabled());
  }
  return ui;
}

const calls = (request: jest.Mock, method: string) =>
  request.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method);
const posts = (request: jest.Mock, suffix: string) =>
  calls(request, 'POST').filter(([path]) => String(path).endsWith(suffix));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

afterEach(() => {
  jest.restoreAllMocks();
});

describe('main screen', () => {
  it('shows the owner their account, group summary and every row with its current value', async () => {
    const ui = await show({
      groups: [
        { id: 'group-1', name: 'Saturday table' },
        { id: 'group-2', name: 'Garden circle' },
      ],
    });
    expect(ui.getByRole('header', { name: 'Settings' })).toBeTruthy();
    expect(ui.getByText('Ada Owner')).toBeTruthy();
    expect(ui.getByText('ada.owner')).toBeTruthy();
    expect(ui.getByText('Saturday table')).toBeTruthy();
    expect(ui.getByTestId('real-settings-group-summary')).toHaveTextContent(
      'Owner · 2 of 4 members',
    );
    expect(
      within(ui.getByTestId('real-settings-prompt')).getByText(BUILT_IN_PROMPTS[0]),
    ).toBeTruthy();
    expect(within(ui.getByTestId('real-settings-tz')).getByText('Asia/Singapore')).toBeTruthy();
    expect(within(ui.getByTestId('real-settings-members')).getByText('2 of 4')).toBeTruthy();
    expect(within(ui.getByTestId('real-settings-groups')).getByText('2 groups')).toBeTruthy();
    expect(ui.getByTestId('real-settings-invite')).toBeEnabled();
    expect(ui.getByText(/^Rewind · signed in as ada\.owner/)).toBeTruthy();
  });

  it('shows "…" for an unknown member count and "1 group" for a single membership', async () => {
    const ui = await show({ members: null });
    expect(ui.getByTestId('real-settings-group-summary')).toHaveTextContent(
      'Owner · … of 4 members',
    );
    expect(within(ui.getByTestId('real-settings-groups')).getByText('1 group')).toBeTruthy();
    expect(within(ui.getByTestId('real-settings-members')).queryByText(/ of 4$/)).toBeNull();
  });

  it('shows a member the prompt and zone read-only, with a reason, and no Invite row', async () => {
    const ui = await show({
      group: baseGroup({ role: 'member' }, 'Custom prompt'),
    });
    expect(ui.getByTestId('real-settings-group-summary')).toHaveTextContent(
      'Member · 2 of 4 members',
    );
    expect(ui.getByText('Custom prompt')).toBeTruthy();
    expect(ui.getByText('Asia/Singapore')).toBeTruthy();
    expect(
      ui.getByText('Only the owner can change the prompt, the time zone or invite friends.'),
    ).toBeTruthy();
    expect(ui.queryByTestId('real-settings-prompt')).toBeNull();
    expect(ui.queryByTestId('real-settings-tz')).toBeNull();
    expect(ui.queryByTestId('real-settings-invite')).toBeNull();
    expect(ui.queryByRole('button', { name: /Invite friends/ })).toBeNull();
    // Members, switching and joining stay available to a member.
    expect(ui.getByTestId('real-settings-members')).toBeTruthy();
    expect(ui.getByTestId('real-settings-groups')).toBeTruthy();
  });

  it('turns Invite friends into a read-only "group is full" row at capacity', async () => {
    const onNavigate = jest.fn();
    const ui = await show({
      group: baseGroup({ maxMembers: 2 }),
      onNavigate,
    });
    const row = ui.getByTestId('real-settings-invite');
    expect(within(row).getByText('The group is full · 2 of 2')).toBeTruthy();
    await fireEvent.press(row);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('offers only join and create when the account has no group, and loads no reminder', async () => {
    const request = reminderRequest();
    const onJoin = jest.fn();
    const onCreate = jest.fn();
    const ui = await show({ group: null, groups: [], onCreate, onJoin, request });
    expect(ui.getByText('You’re not in a group yet.')).toBeTruthy();
    expect(ui.queryByTestId('real-settings-group-summary')).toBeNull();
    expect(ui.queryByTestId('real-settings-members')).toBeNull();
    expect(ui.queryByRole('switch', { name: 'Weekly reminder' })).toBeNull();
    await fireEvent.press(ui.getByTestId('real-settings-join'));
    await fireEvent.press(ui.getByTestId('real-settings-create'));
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    // Account actions stay reachable.
    expect(ui.getByTestId('real-settings-delete')).toBeTruthy();
    expect(ui.getByTestId('real-group-sign-out')).toBeTruthy();
  });

  it('navigates to each step from its row and calls Back on the main screen', async () => {
    const onNavigate = jest.fn();
    const onBack = jest.fn();
    const onJoin = jest.fn();
    const onCreate = jest.fn();
    const ui = await show({ onBack, onCreate, onJoin, onNavigate });
    await fireEvent.press(ui.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();

    // Each row leads to its step; return to main between presses.
    for (const [testID, step] of [
      ['real-settings-prompt', 'prompt'],
      ['real-settings-tz', 'tz'],
      ['real-settings-invite', 'invite'],
      ['real-settings-members', 'members'],
      ['real-settings-groups', 'groups'],
      ['real-settings-delete', 'delete'],
    ] as const) {
      await fireEvent.press(ui.getByTestId(testID));
      expect(onNavigate).toHaveBeenLastCalledWith(step);
      expect(ui.getByTestId(`real-settings-${step}`)).toBeTruthy();
      await fireEvent.press(ui.getByRole('button', { name: 'Back' }));
      expect(onNavigate).toHaveBeenLastCalledWith('main');
      expect(ui.getByTestId('real-settings-main')).toBeTruthy();
    }
    // Join and create hand off to the caller instead of changing step.
    await fireEvent.press(ui.getByTestId('real-settings-join'));
    await fireEvent.press(ui.getByTestId('real-settings-create'));
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('shows the sign-out notice as an alert', async () => {
    const ui = await show({ notice: 'We could not confirm sign-out.' });
    expect(ui.getByRole('alert', { name: 'We could not confirm sign-out.' })).toBeTruthy();
    expect(ui.getByTestId('settings-logout-unconfirmed')).toBeTruthy();
  });

  it('asks before signing out, and only the confirm button signs out', async () => {
    const onSignOut = jest.fn();
    const ui = await show({ signOut: { label: 'Sign out', onSignOut, pending: false } });
    expect(ui.queryByTestId('real-sign-out-dialog')).toBeNull();
    await fireEvent.press(ui.getByTestId('real-group-sign-out'));
    const dialog = within(ui.getByTestId('real-sign-out-dialog'));
    expect(dialog.getByText('Sign out?')).toBeTruthy();
    expect(
      dialog.getByText(
        'Your sealed moments stay with the group. A moment still uploading on this phone stops until you sign in again.',
      ),
    ).toBeTruthy();
    await fireEvent.press(dialog.getByRole('button', { name: 'Stay signed in' }));
    expect(ui.queryByTestId('real-sign-out-dialog')).toBeNull();
    expect(onSignOut).not.toHaveBeenCalled();

    await fireEvent.press(ui.getByTestId('real-group-sign-out'));
    await fireEvent.press(ui.getByTestId('real-group-sign-out-confirm'));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(ui.queryByTestId('real-sign-out-dialog')).toBeNull();
  });

  it('disables the sign-out row and uses the supplied label while signing out is pending', async () => {
    const ui = await show({
      signOut: { label: 'Signing out…', onSignOut: jest.fn(), pending: true },
    });
    const row = ui.getByTestId('real-group-sign-out');
    expect(within(row).getByText('Signing out…')).toBeTruthy();
    expect(row).toBeDisabled();
  });

  describe('help and legal pages', () => {
    afterEach(() => {
      delete process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN;
    });

    it('opens them in the configured web origin on native', async () => {
      process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN = 'https://rewind.example';
      const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
      const ui = await show();
      await fireEvent.press(ui.getByTestId('real-settings-help'));
      await fireEvent.press(ui.getByTestId('real-settings-privacy'));
      await fireEvent.press(ui.getByTestId('real-settings-terms'));
      expect(open.mock.calls.map(([url]) => url)).toEqual([
        'https://rewind.example/support',
        'https://rewind.example/privacy',
        'https://rewind.example/terms',
      ]);
    });

    it('opens them in a new tab with noopener on the web', async () => {
      const platformOs = jest.replaceProperty(Platform, 'OS', 'web');
      const windowOpen = jest.fn();
      (window as unknown as { open: unknown }).open = windowOpen;
      try {
        const ui = await show();
        await fireEvent.press(ui.getByTestId('real-settings-privacy'));
        expect(windowOpen).toHaveBeenCalledWith('/privacy', '_blank', 'noopener');
      } finally {
        platformOs.restore();
        delete (window as unknown as { open?: unknown }).open;
      }
    });
  });
});

describe('reminder block', () => {
  const REMINDERS = '/real/groups/group-1/reminders';

  it('loads the preference for the selected group and shows it off with no snooze row', async () => {
    const request = reminderRequest();
    const ui = await show({ request });
    expect(request).toHaveBeenCalledWith(REMINDERS);
    const toggle = ui.getByRole('switch', { name: 'Weekly reminder' });
    expect(toggle.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
    expect(within(ui.getByTestId('real-group-reminder-schedule')).getByText('Off')).toBeTruthy();
    expect(ui.queryByTestId('real-group-reminder-snooze')).toBeNull();
  });

  it('shows "Loading…" with the toggle disabled until the preference arrives', async () => {
    let release!: (value: Response) => void;
    const request = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const ui = await render(<Harness options={{ request }} />);
    expect(
      within(ui.getByTestId('real-group-reminder-schedule')).getByText('Loading…'),
    ).toBeTruthy();
    expect(ui.getByRole('switch', { name: 'Weekly reminder' })).toBeDisabled();
    await act(async () => {
      release(response({ preference: { enabled: true, snoozedUntil: null, timeZone: 'UTC' } }));
    });
    expect(await ui.findByText('Sundays at 7 PM, group time')).toBeTruthy();
    expect(ui.getByRole('switch', { name: 'Weekly reminder' })).toBeEnabled();
  });

  it('keeps the toggle disabled and explains when the preference cannot be loaded', async () => {
    const request = jest.fn(async () => response({}, 503));
    const ui = await render(<Harness options={{ request }} />);
    expect(
      await ui.findByText('Reminder preferences could not be loaded. Retry when connected.'),
    ).toBeTruthy();
    expect(ui.getByRole('switch', { name: 'Weekly reminder' })).toBeDisabled();
    expect(
      within(ui.getByTestId('real-group-reminder-schedule')).getByText('Loading…'),
    ).toBeTruthy();
  });

  it('turns the reminder on by saving only the schedule when no device client is available', async () => {
    const request = reminderRequest();
    const ui = await show({ request });
    await fireEvent.press(ui.getByRole('switch', { name: 'Weekly reminder' }));
    expect(await ui.findByText('Sunday 7 PM reminder saved.')).toBeTruthy();
    expect(posts(request, '/reminders')).toHaveLength(1);
    expect(bodyOf(posts(request, '/reminders')[0])).toEqual({ enabled: true, snoozedUntil: null });
    expect(posts(request, '/reminders')[0][1].headers).toEqual({
      'Content-Type': 'application/json',
    });
    expect(
      ui.getByRole('switch', { name: 'Weekly reminder' }).props.accessibilityState.checked,
    ).toBe(true);
    expect(ui.getByText('Sundays at 7 PM, group time')).toBeTruthy();
    expect(ui.getByTestId('real-group-reminder-snooze')).toBeTruthy();
  });

  it('turns an enabled reminder off and says so', async () => {
    const request = jest.fn(async (path: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? response({ preference: JSON.parse(String(init.body)) })
        : response({ preference: { enabled: true, snoozedUntil: null, timeZone: 'UTC' } }),
    );
    const ui = await render(<Harness options={{ request }} />);
    await ui.findByText('Sundays at 7 PM, group time');
    await waitFor(() => expect(ui.getByRole('switch', { name: 'Weekly reminder' })).toBeEnabled());
    await fireEvent.press(ui.getByRole('switch', { name: 'Weekly reminder' }));
    expect(await ui.findByText('Sunday 7 PM reminders are off.')).toBeTruthy();
    expect(bodyOf(posts(request, '/reminders')[0])).toEqual({ enabled: false, snoozedUntil: null });
    expect(within(ui.getByTestId('real-group-reminder-schedule')).getByText('Off')).toBeTruthy();
    expect(ui.queryByTestId('real-group-reminder-snooze')).toBeNull();
  });

  it('snoozes for seven days, then shows the snooze and lets the person end it', async () => {
    const request = jest.fn(async (path: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? response({ preference: { timeZone: 'UTC', ...JSON.parse(String(init.body)) } })
        : response({ preference: { enabled: true, snoozedUntil: null, timeZone: 'UTC' } }),
    );
    const ui = await render(<Harness options={{ request }} />);
    await ui.findByText('Sundays at 7 PM, group time');
    await waitFor(() => expect(ui.getByTestId('real-group-reminder-snooze')).toBeEnabled());
    expect(
      within(ui.getByTestId('real-group-reminder-snooze')).getByText('Snooze for 7 days'),
    ).toBeTruthy();
    const before = Date.now();
    await fireEvent.press(ui.getByTestId('real-group-reminder-snooze'));
    expect(await ui.findByText('Snoozed until next Sunday.')).toBeTruthy();
    const snooze = bodyOf(posts(request, '/reminders')[0]);
    expect(snooze.enabled).toBe(true);
    const until = Date.parse(snooze.snoozedUntil);
    expect(until - before).toBeGreaterThanOrEqual(7 * 86_400_000);
    expect(until - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    expect(ui.getByText('Snoozed for 7 days')).toBeTruthy();
    expect(
      within(ui.getByTestId('real-group-reminder-snooze')).getByText('End snooze'),
    ).toBeTruthy();
    expect(ui.getByTestId('real-group-reminder-snooze').props.accessibilityState.selected).toBe(
      true,
    );

    await waitFor(() => expect(ui.getByTestId('real-group-reminder-snooze')).toBeEnabled());
    await fireEvent.press(ui.getByTestId('real-group-reminder-snooze'));
    expect(await ui.findByText('Reminder is back on for this Sunday.')).toBeTruthy();
    expect(bodyOf(posts(request, '/reminders')[1])).toEqual({ enabled: true, snoozedUntil: null });
    expect(ui.getByText('Sundays at 7 PM, group time')).toBeTruthy();
  });

  it('shows a snoozed preference that the server already holds', async () => {
    const snoozedUntil = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const request = jest.fn(async () =>
      response({ preference: { enabled: true, snoozedUntil, timeZone: 'UTC' } }),
    );
    const ui = await render(<Harness options={{ request }} />);
    expect(await ui.findByText('Snoozed for 7 days')).toBeTruthy();
    expect(
      within(ui.getByTestId('real-group-reminder-snooze')).getByText('End snooze'),
    ).toBeTruthy();
  });

  it('treats a snooze that has already passed as no snooze', async () => {
    const snoozedUntil = new Date(Date.now() - 86_400_000).toISOString();
    const request = jest.fn(async () =>
      response({ preference: { enabled: true, snoozedUntil, timeZone: 'UTC' } }),
    );
    const ui = await render(<Harness options={{ request }} />);
    expect(await ui.findByText('Sundays at 7 PM, group time')).toBeTruthy();
    expect(
      within(ui.getByTestId('real-group-reminder-snooze')).getByText('Snooze for 7 days'),
    ).toBeTruthy();
  });

  it.each([
    [401, 'Sign in again to save these settings.'],
    [503, 'Your reminder could not be saved. Retry when connected.'],
  ])('keeps the reminder off and shows the %s failure message', async (status, message) => {
    const request = jest.fn(async (_path: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? response({}, status)
        : response({ preference: { enabled: false, snoozedUntil: null, timeZone: 'UTC' } }),
    );
    const ui = await render(<Harness options={{ request }} />);
    await ui.findByText('Off');
    await waitFor(() => expect(ui.getByRole('switch', { name: 'Weekly reminder' })).toBeEnabled());
    await fireEvent.press(ui.getByRole('switch', { name: 'Weekly reminder' }));
    expect(await ui.findByText(message)).toBeTruthy();
    expect(
      ui.getByRole('switch', { name: 'Weekly reminder' }).props.accessibilityState.checked,
    ).toBe(false);
    await waitFor(() => expect(ui.getByRole('switch', { name: 'Weekly reminder' })).toBeEnabled());
  });
});

describe('prompt step', () => {
  const SETTINGS = '/real/groups/group-1/settings';
  const prompts = (ui: Screen) => within(ui.getByLabelText('Prompt'));

  it('lists the built-in prompts and a custom option as radios with the current one checked', async () => {
    const ui = await show({ step: 'prompt', group: baseGroup({}, BUILT_IN_PROMPTS[1]) });
    expect(ui.getByRole('header', { name: 'Prompt' })).toBeTruthy();
    expect(ui.getByText('Everyone sees it on Home for this cycle.')).toBeTruthy();
    const radios = prompts(ui).getAllByRole('radio');
    expect(radios).toHaveLength(BUILT_IN_PROMPTS.length + 1);
    BUILT_IN_PROMPTS.forEach((prompt, index) => {
      expect(
        prompts(ui).getByRole('radio', { name: prompt }).props.accessibilityState.checked,
      ).toBe(index === 1);
    });
    expect(
      prompts(ui).getByRole('radio', { name: 'Write a custom prompt' }).props.accessibilityState
        .checked,
    ).toBe(false);
    expect(ui.queryByLabelText('Custom prompt')).toBeNull();
  });

  it('opens a custom prompt as the custom radio with its text filled in', async () => {
    const ui = await show({ step: 'prompt', group: baseGroup({}, 'Something only we know') });
    expect(
      prompts(ui).getByRole('radio', { name: 'Write a custom prompt' }).props.accessibilityState
        .checked,
    ).toBe(true);
    for (const prompt of BUILT_IN_PROMPTS)
      expect(
        prompts(ui).getByRole('radio', { name: prompt }).props.accessibilityState.checked,
      ).toBe(false);
    expect(ui.getByLabelText('Custom prompt').props.value).toBe('Something only we know');
  });

  it('moves the checked radio when another is chosen, and shows the field only for custom', async () => {
    const ui = await show({ step: 'prompt' });
    await fireEvent.press(prompts(ui).getByRole('radio', { name: BUILT_IN_PROMPTS[2] }));
    expect(
      prompts(ui).getByRole('radio', { name: BUILT_IN_PROMPTS[2] }).props.accessibilityState
        .checked,
    ).toBe(true);
    expect(
      prompts(ui).getByRole('radio', { name: BUILT_IN_PROMPTS[0] }).props.accessibilityState
        .checked,
    ).toBe(false);
    await fireEvent.press(prompts(ui).getByRole('radio', { name: 'Write a custom prompt' }));
    expect(ui.getByLabelText('Custom prompt').props.value).toBe('');
    expect(ui.getByLabelText('Custom prompt').props.maxLength).toBe(160);
    await fireEvent.press(prompts(ui).getByRole('radio', { name: BUILT_IN_PROMPTS[0] }));
    expect(ui.queryByLabelText('Custom prompt')).toBeNull();
  });

  it('saves the chosen built-in prompt with the group time zone, then returns to main', async () => {
    const request = reminderRequest();
    const updated = baseGroup({}, BUILT_IN_PROMPTS[2]);
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === SETTINGS) return response({ group: updated });
      if (path.endsWith('/reminders'))
        return response({ preference: { enabled: false, snoozedUntil: null, timeZone: 'UTC' } });
      throw new Error(`Unexpected request: ${path}`);
    });
    const onGroupUpdated = jest.fn();
    const onNavigate = jest.fn();
    const ui = await show({ step: 'prompt', onGroupUpdated, onNavigate, request });
    await fireEvent.press(prompts(ui).getByRole('radio', { name: BUILT_IN_PROMPTS[2] }));
    await fireEvent.press(ui.getByRole('button', { name: 'Save' }));
    expect(await ui.findByText('Saved.')).toBeTruthy();
    expect(request).toHaveBeenCalledWith(SETTINGS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: BUILT_IN_PROMPTS[2], timeZone: 'Asia/Singapore' }),
    });
    expect(onGroupUpdated).toHaveBeenCalledWith(updated);
    expect(onNavigate).toHaveBeenLastCalledWith('main');
    // Back on main, the new prompt is the row note.
    expect(await ui.findByTestId('real-settings-main')).toBeTruthy();
    expect(
      within(ui.getByTestId('real-settings-prompt')).getByText(BUILT_IN_PROMPTS[2]),
    ).toBeTruthy();
  });

  it('trims a custom prompt before sending it, and falls back to UTC without a group zone', async () => {
    const request = jest.fn(async () => response({ group: baseGroup({}, 'Hello') }));
    const ui = await show({
      step: 'prompt',
      group: baseGroup({ timeZone: undefined }),
      request,
    });
    await fireEvent.press(prompts(ui).getByRole('radio', { name: 'Write a custom prompt' }));
    await fireEvent.changeText(ui.getByLabelText('Custom prompt'), '   Hello   ');
    await fireEvent.press(ui.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts(request, '/settings')).toHaveLength(1));
    expect(bodyOf(posts(request, '/settings')[0])).toEqual({ prompt: 'Hello', timeZone: 'UTC' });
  });

  it('refuses an empty custom prompt without sending anything', async () => {
    const request = jest.fn();
    const ui = await show({ step: 'prompt', request });
    await fireEvent.press(prompts(ui).getByRole('radio', { name: 'Write a custom prompt' }));
    await fireEvent.changeText(ui.getByLabelText('Custom prompt'), '    ');
    await fireEvent.press(ui.getByRole('button', { name: 'Save' }));
    expect(await ui.findByText('Write a prompt, or pick one above.')).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    expect(ui.getByRole('header', { name: 'Prompt' })).toBeTruthy();
  });

  it.each([
    [403, {}, 'Only the group owner can change the prompt and timezone.'],
    [401, {}, 'Sign in again to save these settings.'],
    [409, { error: 'cycle_closed' }, 'This cycle has closed. Reload your group before editing.'],
    [400, {}, 'Check the prompt and IANA timezone, then retry.'],
  ])('shows the message for a %s response and stays on the step', async (status, body, message) => {
    const request: jest.Mock = jest.fn(async () => response(body, status));
    const onGroupUpdated = jest.fn();
    const ui = await show({ step: 'prompt', onGroupUpdated, request });
    await fireEvent.press(ui.getByRole('button', { name: 'Save' }));
    expect(await ui.findByText(message)).toBeTruthy();
    expect(onGroupUpdated).not.toHaveBeenCalled();
    expect(ui.getByRole('header', { name: 'Prompt' })).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(request.mock.calls[0][0]).toBe(SETTINGS);
  });

  it('shows the server-message fallbacks for an unreadable error body and a missing group', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => Promise.reject(new SyntaxError('bad')),
      })
      .mockResolvedValueOnce(response({}))
      .mockRejectedValueOnce(new Error('Network is down'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const ui = await show({ step: 'prompt', request });
    const save = async () => fireEvent.press(ui.getByRole('button', { name: 'Save' }));
    await save();
    expect(await ui.findByText('Check the prompt and IANA timezone, then retry.')).toBeTruthy();
    await save();
    expect(await ui.findByText('Settings could not be saved. Retry when connected.')).toBeTruthy();
    await save();
    expect(await ui.findByText('Network is down')).toBeTruthy();
    await save();
    expect(await ui.findByText('Settings could not be saved. Retry when connected.')).toBeTruthy();
    expect(ui.queryByText('Network is down')).toBeNull();
  });

  it('shows Saving… and blocks a second press while the request is in flight', async () => {
    let release!: (value: Response) => void;
    const request = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const ui = await show({ step: 'prompt', request });
    await fireEvent.press(ui.getByRole('button', { name: 'Save' }));
    const busy = ui.getByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();
    await fireEvent.press(busy);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(response({ group: baseGroup() }));
    });
  });
});

describe('time zone step', () => {
  const SETTINGS = '/real/groups/group-1/settings';
  const zones = (ui: Screen) => within(ui.getByLabelText('Time zone'));

  it('lists zones as radios, current one checked first, with underscores spelled as spaces', async () => {
    const ui = await show({ step: 'tz', group: baseGroup({ timeZone: 'Europe/Berlin' }) });
    expect(ui.getByRole('header', { name: 'Time zone' })).toBeTruthy();
    expect(ui.getByText('The Sunday 7 PM reminder follows the group’s time zone.')).toBeTruthy();
    const radios = zones(ui).getAllByRole('radio');
    expect(radios[0]).toBe(ui.getByTestId('real-tz-Europe/Berlin'));
    expect(ui.getByTestId('real-tz-Europe/Berlin').props.accessibilityState.checked).toBe(true);
    expect(ui.getByTestId('real-tz-Asia/Singapore').props.accessibilityState.checked).toBe(false);
    expect(
      within(ui.getByTestId('real-tz-America/New_York')).getByText('America/New York'),
    ).toBeTruthy();
    expect(within(ui.getByTestId('real-tz-UTC')).getByText('UTC')).toBeTruthy();
    // The current zone appears once even though it is also in the built-in list.
    expect(zones(ui).getAllByText('Europe/Berlin')).toHaveLength(1);
  });

  it('marks the device zone and offers it even when it is not in the built-in list', async () => {
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(
        () => ({ resolvedOptions: () => ({ timeZone: 'Pacific/Auckland' }) }) as never,
      );
    const ui = await show({ step: 'tz' });
    const row = ui.getByTestId('real-tz-Pacific/Auckland');
    expect(within(row).getByText('This device')).toBeTruthy();
    expect(row.props.accessibilityState.checked).toBe(false);
  });

  it('does nothing when the current zone is chosen again', async () => {
    const request = jest.fn();
    const ui = await show({ step: 'tz', request });
    await fireEvent.press(ui.getByTestId('real-tz-Asia/Singapore'));
    expect(request).not.toHaveBeenCalled();
  });

  it('saves the picked zone with the unchanged prompt, checks it and stays on the step', async () => {
    const updated = baseGroup({ timeZone: 'Asia/Tokyo' });
    const request = jest.fn(async () => response({ group: updated }));
    const onGroupUpdated = jest.fn();
    const ui = await show({ step: 'tz', onGroupUpdated, request });
    await fireEvent.press(ui.getByTestId('real-tz-Asia/Tokyo'));
    expect(await ui.findByText('Saved.')).toBeTruthy();
    expect(request).toHaveBeenCalledWith(SETTINGS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: BUILT_IN_PROMPTS[0], timeZone: 'Asia/Tokyo' }),
    });
    expect(onGroupUpdated).toHaveBeenCalledWith(updated);
    expect(ui.getByRole('header', { name: 'Time zone' })).toBeTruthy();
    await waitFor(() =>
      expect(ui.getByTestId('real-tz-Asia/Tokyo').props.accessibilityState.checked).toBe(true),
    );
    expect(ui.getByTestId('real-tz-Asia/Singapore').props.accessibilityState.checked).toBe(false);
  });

  it('shows Saving… on the picked row and disables the others while it is in flight', async () => {
    let release!: (value: Response) => void;
    const request = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const ui = await show({ step: 'tz', request });
    await fireEvent.press(ui.getByTestId('real-tz-Asia/Tokyo'));
    expect(within(ui.getByTestId('real-tz-Asia/Tokyo')).getByText('Saving…')).toBeTruthy();
    expect(ui.getByTestId('real-tz-UTC')).toBeDisabled();
    await fireEvent.press(ui.getByTestId('real-tz-UTC'));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(response({ group: baseGroup({ timeZone: 'Asia/Tokyo' }) }));
    });
    await waitFor(() => expect(ui.getByTestId('real-tz-UTC')).toBeEnabled());
  });

  it('shows the owner-only message for a 403 and leaves the zone unchanged', async () => {
    const request = jest.fn(async () => response({}, 403));
    const ui = await show({ step: 'tz', request });
    await fireEvent.press(ui.getByTestId('real-tz-UTC'));
    expect(
      await ui.findByText('Only the group owner can change the prompt and timezone.'),
    ).toBeTruthy();
    expect(ui.getByTestId('real-tz-Asia/Singapore').props.accessibilityState.checked).toBe(true);
    expect(ui.getByTestId('real-tz-UTC').props.accessibilityState.checked).toBe(false);
    expect(ui.getByTestId('real-tz-UTC')).toBeEnabled();
  });
});

describe('invite step', () => {
  it('makes a code on open and shows the waiting state until one arrives', async () => {
    const invite = inviteControls();
    const ui = await show({ step: 'invite', invite });
    expect(invite.create).toHaveBeenCalledTimes(1);
    expect(ui.getByRole('header', { name: 'Invite friends' })).toBeTruthy();
    expect(ui.getByText('— — —')).toBeTruthy();
    expect(ui.queryByTestId('real-group-invite-code')).toBeNull();
    expect(ui.queryByTestId('real-group-revoke-invite')).toBeNull();
    expect(ui.getByText('2 of 4 members in Saturday table')).toBeTruthy();
    // With no code it can also be requested by hand.
    await fireEvent.press(ui.getByRole('button', { name: 'Create invitation code' }));
    expect(invite.create).toHaveBeenCalledTimes(2);
  });

  it('does not ask for a code on open while one is pending or already shown', async () => {
    const pending = inviteControls({ pending: true });
    const first = await show({ step: 'invite', invite: pending });
    expect(pending.create).not.toHaveBeenCalled();
    expect(first.getByText('Making a code…')).toBeTruthy();
    expect(first.getByRole('button', { name: 'Creating invitation…' })).toBeDisabled();
    await first.unmount();

    const shown = inviteControls({ code: 'ABC-DEF' });
    await show({ step: 'invite', invite: shown });
    expect(shown.create).not.toHaveBeenCalled();
  });

  it('shows the code with a spoken-out label, expiry, and wires Share, Copy and Revoke', async () => {
    const invite = inviteControls({ code: 'ABC-DEF' });
    const ui = await show({ step: 'invite', invite });
    const code = ui.getByTestId('real-group-invite-code');
    expect(code).toHaveTextContent('ABC-DEF');
    expect(code.props.accessibilityLabel).toBe('Invite code A B C - D E F');
    expect(ui.getByTestId('real-group-invite-expiry')).toHaveTextContent(
      'Works once · expires in 24 hours',
    );
    expect(ui.queryByRole('button', { name: 'Create invitation code' })).toBeNull();
    await fireEvent.press(ui.getByRole('button', { name: 'Share code' }));
    await fireEvent.press(ui.getByRole('button', { name: 'Copy code' }));
    await fireEvent.press(ui.getByRole('button', { name: 'Revoke this code' }));
    expect(invite.share).toHaveBeenCalledTimes(1);
    expect(invite.copy).toHaveBeenCalledTimes(1);
    expect(invite.revoke).toHaveBeenCalledTimes(1);
  });

  it('labels the revoke action "Revoking…" while pending, and shows feedback as an alert', async () => {
    const invite = inviteControls({
      code: 'ABC-DEF',
      feedback: 'The invitation could not be revoked.',
      pending: true,
    });
    const ui = await show({ step: 'invite', invite });
    expect(ui.getByTestId('real-group-revoke-invite')).toBeTruthy();
    expect(within(ui.getByTestId('real-group-revoke-invite')).getByText('Revoking…')).toBeTruthy();
    expect(ui.getByRole('alert', { name: 'The invitation could not be revoked.' })).toBe(
      ui.getByTestId('real-invite-feedback'),
    );
  });

  it('shows "…" for the member count while members are unknown', async () => {
    const ui = await show({
      step: 'invite',
      members: null,
      invite: inviteControls({ code: 'AB' }),
    });
    expect(ui.getByText('… of 4 members in Saturday table')).toBeTruthy();
  });
});

describe('switch group step', () => {
  const groups = [
    { id: 'group-1', name: 'Saturday table' },
    { id: 'group-2', name: 'Garden circle' },
  ];

  it('marks the current group, offers the others, and exposes join and create', async () => {
    const onJoin = jest.fn();
    const onCreate = jest.fn();
    const ui = await show({ step: 'groups', groups, onCreate, onJoin });
    expect(ui.getByRole('header', { name: 'Switch group' })).toBeTruthy();
    const current = ui.getByTestId('real-settings-switch-group-1');
    const other = ui.getByTestId('real-settings-switch-group-2');
    expect(within(current).getByText('Current group')).toBeTruthy();
    expect(current.props.accessibilityState.selected).toBe(true);
    expect(within(other).getByText('Tap to switch')).toBeTruthy();
    expect(other.props.accessibilityState.selected).toBe(false);
    await fireEvent.press(ui.getByRole('button', { name: 'Have an invite?' }));
    await fireEvent.press(ui.getByRole('button', { name: 'Create a group' }));
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('switches, says so, and returns to main when the switch succeeds', async () => {
    const onSwitchGroup = jest.fn(async () => true);
    const onNavigate = jest.fn();
    const ui = await show({ step: 'groups', groups, onNavigate, onSwitchGroup });
    await fireEvent.press(ui.getByTestId('real-settings-switch-group-2'));
    expect(onSwitchGroup).toHaveBeenCalledWith('group-2');
    expect(await ui.findByText('Switched to Garden circle.')).toBeTruthy();
    expect(onNavigate).toHaveBeenLastCalledWith('main');
  });

  it('stays put, with no toast, when the switch fails', async () => {
    const onSwitchGroup = jest.fn(async () => false);
    const onNavigate = jest.fn();
    const ui = await show({ step: 'groups', groups, onNavigate, onSwitchGroup });
    await fireEvent.press(ui.getByTestId('real-settings-switch-group-2'));
    await waitFor(() => expect(onSwitchGroup).toHaveBeenCalledTimes(1));
    expect(ui.queryByText(/Switched to/)).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(ui.getByRole('header', { name: 'Switch group' })).toBeTruthy();
  });

  it('ignores the current group and disables every row while a switch is pending', async () => {
    const onSwitchGroup = jest.fn(async () => true);
    const ui = await show({ step: 'groups', groups, onSwitchGroup });
    await fireEvent.press(ui.getByTestId('real-settings-switch-group-1'));
    expect(onSwitchGroup).not.toHaveBeenCalled();
    await ui.unmount();

    const pending = await show({ step: 'groups', groups, onSwitchGroup, switchPending: true });
    expect(pending.getByTestId('real-settings-switch-group-1')).toBeDisabled();
    expect(pending.getByTestId('real-settings-switch-group-2')).toBeDisabled();
  });
});

describe('members step', () => {
  const owner = baseGroup();

  it('shows a loading line, or the load error, instead of the list while members are unknown', async () => {
    const loading = await show({ step: 'members', members: null });
    expect(loading.getByTestId('real-group-members-empty')).toHaveTextContent(
      'Loading group members…',
    );
    expect(loading.getByTestId('real-group-pending-invites')).toHaveTextContent(
      'Loading invitation status…',
    );
    await loading.unmount();

    const failed = await show({
      step: 'members',
      members: null,
      membersError: 'Group members could not be loaded. Retry when connected.',
    });
    expect(failed.getByTestId('real-group-members-empty')).toHaveTextContent(
      'Group members could not be loaded. Retry when connected.',
    );
    expect(failed.getByTestId('real-group-pending-invites')).toHaveTextContent(
      'Invitation status unavailable.',
    );
  });

  it('lists members with role notes, marks the signed-in member and keeps their row inert', async () => {
    const ui = await show({
      step: 'members',
      group: owner,
      blocked: new Set(['profile-friend']),
    });
    expect(ui.getByRole('header', { name: 'Members' })).toBeTruthy();
    expect(
      ui.getByText('Blocking hides someone’s messages and moments from you. They aren’t told.'),
    ).toBeTruthy();
    const you = ui.getByLabelText('Ada Owner, owner');
    expect(within(you).getByText('Ada Owner (you)')).toBeTruthy();
    expect(within(you).getByText('Owner')).toBeTruthy();
    await fireEvent.press(you);
    expect(ui.queryByTestId('real-person-dialog')).toBeNull();
    const friend = ui.getByLabelText('Casey, member');
    expect(within(friend).getByText('Member · blocked')).toBeTruthy();
    expect(ui.getByTestId('real-group-pending-invites')).toHaveTextContent(
      'No pending invitations',
    );
  });

  it('opens a person card with Report, Block and Cancel, and Cancel closes it', async () => {
    const ui = await show({ step: 'members', group: owner });
    await fireEvent.press(ui.getByTestId('real-group-member-1'));
    const card = within(ui.getByTestId('real-person-dialog'));
    expect(card.getByRole('header', { name: 'Casey' })).toBeTruthy();
    expect(card.getByRole('button', { name: 'Report' })).toBeTruthy();
    expect(card.getByRole('button', { name: 'Block' })).toBeTruthy();
    await fireEvent.press(card.getByRole('button', { name: 'Cancel' }));
    expect(ui.queryByTestId('real-person-dialog')).toBeNull();
  });

  it('keeps the card open and toasts the reason when blocking fails', async () => {
    const request = jest.fn(async () => response({ message: 'ignored' }, 500));
    const ui = await show({ step: 'members', group: owner, request });
    await fireEvent.press(ui.getByTestId('real-group-member-1'));
    await fireEvent.press(ui.getByTestId('real-person-block'));
    expect(await ui.findByText('That person could not be blocked. Try again.')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/real/blocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'profile-friend' }),
    });
    expect(ui.getByTestId('real-person-dialog')).toBeTruthy();
    expect(
      within(ui.getByTestId('real-group-member-1')).queryByText('Member · blocked'),
    ).toBeNull();
  });

  it('toasts that the person is blocked after a successful block', async () => {
    const request = jest.fn(async () => response({ blocked: true }));
    const ui = await show({ step: 'members', group: owner, request });
    await fireEvent.press(ui.getByTestId('real-group-member-1'));
    await fireEvent.press(ui.getByTestId('real-person-block'));
    expect(
      await ui.findByText('Casey is blocked. You won’t see their messages or moments.'),
    ).toBeTruthy();
    expect(ui.queryByTestId('real-person-dialog')).toBeNull();
  });

  it('reports a person: sends the reason, blocks too by default, and confirms', async () => {
    const request: jest.Mock = jest.fn(async () => response({ reported: true }, 201));
    const ui = await show({ step: 'members', group: owner, request });
    await fireEvent.press(ui.getByTestId('real-group-member-1'));
    await fireEvent.press(ui.getByTestId('real-person-report'));
    expect(ui.queryByTestId('real-person-dialog')).toBeNull();
    expect(ui.getByTestId('report-sheet')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('report-send'));
    expect(
      await ui.findByText('Reported and blocked. You won’t see their messages or moments.'),
    ).toBeTruthy();
    expect(request.mock.calls.map(([path, init]) => [path, init.method, init.body])).toEqual([
      [
        '/real/groups/group-1/reports',
        'POST',
        JSON.stringify({ memberId: 'profile-friend', reason: 'Sexual or inappropriate' }),
      ],
      ['/real/blocks', 'POST', JSON.stringify({ profileId: 'profile-friend' })],
    ]);
    expect(ui.queryByTestId('report-sheet')).toBeNull();
  });

  it('confirms a report without the block wording when Also block is off', async () => {
    const request: jest.Mock = jest.fn(async () => response({ reported: true }, 201));
    const ui = await show({ step: 'members', group: owner, request });
    await fireEvent.press(ui.getByTestId('real-group-member-1'));
    await fireEvent.press(ui.getByTestId('real-person-report'));
    await fireEvent.press(ui.getByTestId('report-also-block'));
    await fireEvent.press(ui.getByTestId('report-send'));
    expect(
      await ui.findByText('Thanks. The Rewind team reviews reports within 24 hours.'),
    ).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not block again when reporting an already-blocked person', async () => {
    const request: jest.Mock = jest.fn(async () => response({ reported: true }, 201));
    const ui = await show({
      step: 'members',
      group: owner,
      request,
      blocked: new Set(['profile-friend']),
    });
    await fireEvent.press(ui.getByTestId('real-group-member-1'));
    await fireEvent.press(ui.getByTestId('real-person-report'));
    await fireEvent.press(ui.getByTestId('report-send'));
    await ui.findByText('Reported and blocked. You won’t see their messages or moments.');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/real/groups/group-1/reports');
  });

  it('keeps the report sheet open with the error, and blocks nobody, when the report fails', async () => {
    const request = jest.fn(async () => response({}, 500));
    const ui = await show({ step: 'members', group: owner, request });
    await fireEvent.press(ui.getByTestId('real-group-member-1'));
    await fireEvent.press(ui.getByTestId('real-person-report'));
    await fireEvent.press(ui.getByTestId('report-send'));
    expect(await ui.findByText('The report could not be sent. Try again.')).toBeTruthy();
    expect(ui.getByTestId('report-sheet')).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
    await fireEvent.press(ui.getByTestId('report-cancel'));
    expect(ui.queryByTestId('report-sheet')).toBeNull();
  });

  it('shows the server message when reporting is rate limited', async () => {
    const request = jest.fn(async () =>
      response({ error: 'rate_limited', message: 'Too many reports. Try later.' }, 429),
    );
    const ui = await show({ step: 'members', group: owner, request });
    await fireEvent.press(ui.getByTestId('real-group-member-1'));
    await fireEvent.press(ui.getByTestId('real-person-report'));
    await fireEvent.press(ui.getByTestId('report-send'));
    expect(await ui.findByText('Too many reports. Try later.')).toBeTruthy();
  });
});

describe('delete account step', () => {
  const type = async (ui: Screen, testID: string, value: string) =>
    fireEvent.changeText(ui.getByTestId(testID), value);

  it('explains what is deleted and keeps the button off until a password is typed', async () => {
    const ui = await show({ step: 'delete' });
    expect(ui.getByRole('header', { name: 'Delete account' })).toBeTruthy();
    expect(ui.getByText('This deletes your account for good:')).toBeTruthy();
    expect(ui.getByText('• your username and password')).toBeTruthy();
    expect(ui.getByText('• your chat messages')).toBeTruthy();
    expect(
      ui.getByText('• your photos and videos (films already made stay with the group)'),
    ).toBeTruthy();
    expect(ui.getByText(/^Groups you own pass to the member who joined next\./)).toBeTruthy();
    expect(ui.getByTestId('real-delete-account')).toBeDisabled();
    await type(ui, 'real-delete-password', 'hunter2');
    expect(ui.getByTestId('real-delete-account')).toBeEnabled();
    await type(ui, 'real-delete-password', '');
    expect(ui.getByTestId('real-delete-account')).toBeDisabled();
  });

  it('asks again before deleting, and "Keep my account" backs out without calling anything', async () => {
    const onDeleteAccount = jest.fn(async () => 'deleted' as const);
    const ui = await show({ step: 'delete', onDeleteAccount });
    await type(ui, 'real-delete-password', 'hunter2');
    await fireEvent.press(ui.getByTestId('real-delete-account'));
    const dialog = within(ui.getByTestId('real-delete-dialog'));
    expect(dialog.getByText('Delete your account?')).toBeTruthy();
    expect(
      dialog.getByText('This can’t be undone. You’ll be signed out on every device.'),
    ).toBeTruthy();
    await fireEvent.press(dialog.getByRole('button', { name: 'Keep my account' }));
    expect(ui.queryByTestId('real-delete-dialog')).toBeNull();
    expect(onDeleteAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['incorrect', 'The password is incorrect.'],
    ['throttled', 'Too many attempts. Try again later.'],
    ['unavailable', 'Your account could not be deleted. Retry when connected.'],
  ] as const)(
    'shows the %s outcome, closes the dialog and clears the error on typing',
    async (outcome, message) => {
      const onDeleteAccount = jest.fn(async (): Promise<AccountDeletionOutcome> => outcome);
      const ui = await show({ step: 'delete', onDeleteAccount });
      await type(ui, 'real-delete-password', 'hunter2');
      await fireEvent.press(ui.getByTestId('real-delete-account'));
      await fireEvent.press(ui.getByTestId('real-delete-confirm'));
      expect(await ui.findByTestId('real-delete-error')).toHaveTextContent(message);
      expect(onDeleteAccount).toHaveBeenCalledWith('hunter2');
      expect(ui.queryByTestId('real-delete-dialog')).toBeNull();
      await type(ui, 'real-delete-password', 'hunter3');
      expect(ui.queryByTestId('real-delete-error')).toBeNull();
    },
  );

  it('shows Deleting… and locks the dialog while the deletion is in flight', async () => {
    let finish!: (outcome: AccountDeletionOutcome) => void;
    const onDeleteAccount = jest.fn(
      () =>
        new Promise<AccountDeletionOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const ui = await show({ step: 'delete', onDeleteAccount });
    await type(ui, 'real-delete-password', 'hunter2');
    await fireEvent.press(ui.getByTestId('real-delete-account'));
    await fireEvent.press(ui.getByTestId('real-delete-confirm'));
    expect(ui.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    expect(ui.getByRole('button', { name: 'Keep my account' })).toBeDisabled();
    await act(async () => {
      finish('incorrect');
    });
    expect(await ui.findByTestId('real-delete-error')).toBeTruthy();
  });

  it('asks a Cognito account to type DELETE instead of a password', async () => {
    const onDeleteAccount = jest.fn(async (): Promise<AccountDeletionOutcome> => 'incorrect');
    const ui = await show({ step: 'delete', onDeleteAccount, signInMethod: 'cognito' });
    expect(ui.getByText('• your profile and sign-in')).toBeTruthy();
    expect(ui.queryByText('• your username and password')).toBeNull();
    expect(ui.queryByTestId('real-delete-password')).toBeNull();
    expect(ui.getByLabelText('Type DELETE to confirm')).toBe(
      ui.getByTestId('real-delete-confirmation'),
    );
    expect(ui.getByTestId('real-delete-account')).toBeDisabled();
    await type(ui, 'real-delete-confirmation', 'delete');
    expect(ui.getByTestId('real-delete-account')).toBeDisabled();
    await type(ui, 'real-delete-confirmation', 'DELETE');
    expect(ui.getByTestId('real-delete-account')).toBeEnabled();
    await fireEvent.press(ui.getByTestId('real-delete-account'));
    await fireEvent.press(ui.getByTestId('real-delete-confirm'));
    expect(await ui.findByTestId('real-delete-error')).toHaveTextContent(
      'Type DELETE exactly as shown.',
    );
    expect(onDeleteAccount).toHaveBeenCalledWith('DELETE');
  });

  it('shows no error after a successful deletion outcome', async () => {
    const onDeleteAccount = jest.fn(async (): Promise<AccountDeletionOutcome> => 'deleted');
    const ui = await show({ step: 'delete', onDeleteAccount });
    await type(ui, 'real-delete-password', 'hunter2');
    await fireEvent.press(ui.getByTestId('real-delete-account'));
    await fireEvent.press(ui.getByTestId('real-delete-confirm'));
    await waitFor(() => expect(onDeleteAccount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ui.queryByTestId('real-delete-dialog')).toBeNull());
    expect(ui.queryByTestId('real-delete-error')).toBeNull();
  });
});

describe('step shell', () => {
  it.each([
    ['members', 'Members'],
    ['groups', 'Switch group'],
    ['invite', 'Invite friends'],
    ['prompt', 'Prompt'],
    ['tz', 'Time zone'],
    ['delete', 'Delete account'],
  ] as const)('the %s step is titled "%s" and Back returns to main', async (step, title) => {
    const onNavigate = jest.fn();
    const onBack = jest.fn();
    const ui = await show({ step, onBack, onNavigate });
    expect(ui.getByTestId(`real-settings-${step}`)).toBeTruthy();
    expect(ui.getByRole('header', { name: title })).toBeTruthy();
    await fireEvent.press(ui.getByRole('button', { name: 'Back' }));
    expect(onNavigate).toHaveBeenCalledWith('main');
    expect(onBack).not.toHaveBeenCalled();
    expect(await ui.findByRole('header', { name: 'Settings' })).toBeTruthy();
  });

  it.each(['members', 'invite', 'prompt', 'tz'] as const)(
    'the %s step renders no content when there is no group',
    async (step) => {
      const ui = await show({ step, group: null });
      expect(ui.getByTestId(`real-settings-${step}`)).toBeTruthy();
      expect(ui.queryByRole('header')).toBeNull();
      expect(ui.queryByRole('button', { name: 'Back' })).toBeNull();
    },
  );
});
