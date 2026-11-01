/**
 * Characterisation of src/real/ReportSheet.tsx and the request helpers in
 * src/real/safety.ts. The sheet is rendered on its own; the requests are the
 * ones the three production call sites (Settings Members, Chat, Film) build
 * from `reportContent`/`blockMember`. The Members-driven report journeys in
 * real-settings-safety.test.tsx are not repeated here.
 */
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import { ReportSheet, REPORT_REASONS } from '../src/real/ReportSheet';
import { blockMember, listBlocked, reportContent, unblockMember } from '../src/real/safety';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

// The modal dialog hides its dim layer from role queries, so find it explicitly.
const hidden = { includeHiddenElements: true };
type Screen = Awaited<ReturnType<typeof render>>;
type Sheet = Parameters<typeof ReportSheet>[0];

const response = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

async function open(props: Partial<Sheet> = {}) {
  const onSend = jest.fn(async (): Promise<string | null> => null);
  const onCancel = jest.fn();
  const ui = await render(
    <ReportSheet onCancel={onCancel} onSend={onSend} what="person" {...props} />,
  );
  return { ui, onSend, onCancel };
}

const reasons = (ui: Screen) => within(ui.getByLabelText('Reason'));
const checkedReasons = (ui: Screen) =>
  reasons(ui)
    .getAllByRole('radio')
    .filter((radio) => radio.props.accessibilityState.checked)
    .map((radio) => within(radio).getByText(/./).props.children);

describe('ReportSheet', () => {
  it('titles the sheet by what is reported and says reports go to the team, not the person', async () => {
    const { ui } = await open({ name: 'Casey', what: 'person' });
    expect(ui.getByTestId('report-sheet')).toBeTruthy();
    expect(ui.getByText('Report this person')).toBeTruthy();
    expect(
      ui.getByText(
        'Reports go to the Rewind team, not to Casey. We review every one within 24 hours.',
      ),
    ).toBeTruthy();
    await ui.unmount();

    const message = await open({ what: 'message' });
    expect(message.ui.getByText('Report this message')).toBeTruthy();
    expect(
      message.ui.getByText('Reports go to the Rewind team. We review every one within 24 hours.'),
    ).toBeTruthy();
    await message.ui.unmount();

    const moment = await open({ what: 'moment' });
    expect(moment.ui.getByText('Report this moment')).toBeTruthy();
  });

  it('offers the five reasons as a radio group with the first one already selected', async () => {
    const { ui } = await open();
    expect(ui.getByLabelText('Reason').props.role).toBe('radiogroup');
    expect(REPORT_REASONS).toEqual([
      'Sexual or inappropriate',
      'Harassment or bullying',
      'Violence or self-harm',
      'Spam',
      'Something else',
    ]);
    const radios = reasons(ui).getAllByRole('radio');
    expect(radios).toHaveLength(5);
    expect(radios.map((radio) => within(radio).getByText(/./).props.children)).toEqual([
      ...REPORT_REASONS,
    ]);
    expect(checkedReasons(ui)).toEqual(['Sexual or inappropriate']);
    // A reason is never required before sending: Send is enabled straight away.
    expect(ui.getByRole('button', { name: 'Send report' })).toBeEnabled();
  });

  it('moves the single checked reason to whichever is chosen', async () => {
    const { ui } = await open();
    await fireEvent.press(reasons(ui).getByRole('radio', { name: 'Violence or self-harm' }));
    expect(checkedReasons(ui)).toEqual(['Violence or self-harm']);
    await fireEvent.press(reasons(ui).getByRole('radio', { name: 'Something else' }));
    expect(checkedReasons(ui)).toEqual(['Something else']);
    // Choosing the checked one again keeps it checked; nothing toggles off.
    await fireEvent.press(reasons(ui).getByRole('radio', { name: 'Something else' }));
    expect(checkedReasons(ui)).toEqual(['Something else']);
  });

  it('sends the default reason and Also block (on) when only Send is pressed', async () => {
    const { ui, onSend } = await open({ name: 'Casey' });
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Sexual or inappropriate', true);
  });

  it('sends the chosen reason and the toggled Also block value', async () => {
    const { ui, onSend } = await open({ name: 'Casey' });
    const block = ui.getByRole('checkbox', { name: 'Also block Casey' });
    expect(block.props.accessibilityState.checked).toBe(true);
    await fireEvent.press(block);
    expect(
      ui.getByRole('checkbox', { name: 'Also block Casey' }).props.accessibilityState.checked,
    ).toBe(false);
    await fireEvent.press(reasons(ui).getByRole('radio', { name: 'Spam' }));
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    expect(onSend).toHaveBeenCalledWith('Spam', false);
    await fireEvent.press(ui.getByRole('checkbox', { name: 'Also block Casey' }));
    expect(
      ui.getByRole('checkbox', { name: 'Also block Casey' }).props.accessibilityState.checked,
    ).toBe(true);
  });

  it('has no Also block option, and never asks to block, when no person is named', async () => {
    const { ui, onSend } = await open({ what: 'message' });
    expect(ui.queryByTestId('report-also-block')).toBeNull();
    expect(ui.queryByRole('checkbox')).toBeNull();
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    expect(onSend).toHaveBeenCalledWith('Sexual or inappropriate', false);
  });

  it('shows the failure inline, keeps the sheet and the choices, and clears it on the next try', async () => {
    const { ui, onSend } = await open({ name: 'Casey' });
    onSend.mockResolvedValueOnce('The report could not be sent. Try again.');
    await fireEvent.press(reasons(ui).getByRole('radio', { name: 'Harassment or bullying' }));
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    const error = await ui.findByRole('alert');
    expect(error).toHaveTextContent('The report could not be sent. Try again.');
    expect(ui.getByTestId('report-sheet')).toBeTruthy();
    expect(checkedReasons(ui)).toEqual(['Harassment or bullying']);
    expect(ui.getByRole('button', { name: 'Send report' })).toBeEnabled();

    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenLastCalledWith('Harassment or bullying', true);
    await waitFor(() => expect(ui.queryByRole('alert')).toBeNull());
  });

  it('shows Sending… and locks Send, Cancel and the dim layer while the report is in flight', async () => {
    let finish!: (value: string | null) => void;
    const { ui, onCancel } = await open({
      onSend: jest.fn(
        () =>
          new Promise<string | null>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    expect(ui.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(ui.getByTestId('report-cancel')).toBeDisabled();
    await fireEvent.press(ui.getByTestId('report-cancel'));
    expect(ui.queryByLabelText('Dismiss', hidden)).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => {
      finish('Network is down');
    });
    expect(await ui.findByText('Network is down')).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Send report' })).toBeEnabled();
    expect(ui.getByTestId('report-cancel')).toBeEnabled();
  });

  it('closes through Cancel and through the dim layer, without sending', async () => {
    const { ui, onSend, onCancel } = await open();
    await fireEvent.press(ui.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await fireEvent.press(ui.getByLabelText('Dismiss', hidden));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('leaves closing after a successful send to the caller', async () => {
    const { ui, onSend, onCancel } = await open({ name: 'Casey' });
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();
    expect(ui.queryByRole('alert')).toBeNull();
    expect(ui.getByTestId('report-sheet')).toBeTruthy();
  });
});

describe('ReportSheet wired to the safety helpers', () => {
  // Mirrors how Chat, Film and Settings wire onSend: report, then optionally block.
  async function openWired(
    request: jest.Mock,
    target: Parameters<typeof reportContent>[2],
    props: Partial<Sheet> = {},
  ) {
    const done = jest.fn();
    const ui = await render(
      <ReportSheet
        onCancel={jest.fn()}
        onSend={async (reason, alsoBlock) => {
          try {
            await reportContent(request, 'group/1', target, reason);
            if (alsoBlock && 'memberId' in target) await blockMember(request, target.memberId);
            done();
            return null;
          } catch (error) {
            return (error as Error).message;
          }
        }}
        what="person"
        {...props}
      />,
    );
    return { ui, done };
  }

  it.each([
    [{ messageId: 'message-1' }, 'message'],
    [{ contributionId: 'contribution-1' }, 'moment'],
  ] as const)('posts the reason with %j to the group reports route', async (target, what) => {
    const request = jest.fn(async () => response({ reported: true }, 201));
    const { ui, done } = await openWired(request, target, { what });
    await fireEvent.press(reasons(ui).getByRole('radio', { name: 'Violence or self-harm' }));
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/real/groups/group%2F1/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...target, reason: 'Violence or self-harm' }),
    });
  });

  it('reports a member and then blocks them by profile id', async () => {
    const request = jest.fn(async () => response({ ok: true }));
    const { ui, done } = await openWired(request, { memberId: 'profile-2' }, { name: 'Casey' });
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(request.mock.calls).toEqual([
      [
        '/real/groups/group%2F1/reports',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberId: 'profile-2', reason: 'Sexual or inappropriate' }),
        },
      ],
      [
        '/real/blocks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: 'profile-2' }),
        },
      ],
    ]);
  });

  it('shows the fallback when the server rejects the report and does not go on to block', async () => {
    const request = jest.fn(async () => response({ error: 'nope' }, 400));
    const { ui, done } = await openWired(request, { memberId: 'profile-2' }, { name: 'Casey' });
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    expect(await ui.findByText('The report could not be sent. Try again.')).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });

  it('shows the server message when the report is rate limited', async () => {
    const request = jest.fn(async () =>
      response({ error: 'rate_limited', message: 'Slow down for a minute.' }, 429),
    );
    const { ui } = await openWired(request, { messageId: 'message-1' }, { what: 'message' });
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    expect(await ui.findByText('Slow down for a minute.')).toBeTruthy();
  });

  it('shows the fallback for a rate limit without a usable message', async () => {
    const request = jest.fn(async () => response({ message: '   ' }, 429));
    const { ui } = await openWired(request, { messageId: 'message-1' }, { what: 'message' });
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    expect(await ui.findByText('The report could not be sent. Try again.')).toBeTruthy();
  });

  it('reports a block that fails after a successful report, keeping the sheet open', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(response({ reported: true }, 201))
      .mockResolvedValueOnce(response({}, 500));
    const { ui, done } = await openWired(request, { memberId: 'profile-2' }, { name: 'Casey' });
    await fireEvent.press(ui.getByRole('button', { name: 'Send report' }));
    expect(await ui.findByText('That person could not be blocked. Try again.')).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
    expect(ui.getByTestId('report-sheet')).toBeTruthy();
  });
});

describe('safety request helpers', () => {
  const post = (body: object) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('blocks by posting the profile id, with the 429 message or a fallback on failure', async () => {
    const ok = jest.fn(async () => response({ blocked: true }));
    await expect(blockMember(ok, 'profile-2')).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledWith('/real/blocks', post({ profileId: 'profile-2' }));

    const limited = jest.fn(async () => response({ message: 'Too many blocks.' }, 429));
    await expect(blockMember(limited, 'profile-2')).rejects.toThrow('Too many blocks.');
    const broken = jest.fn(async () => response({}, 500));
    await expect(blockMember(broken, 'profile-2')).rejects.toThrow(
      'That person could not be blocked. Try again.',
    );
  });

  it('unblocks with DELETE on the encoded profile id, with a fallback on failure', async () => {
    const ok = jest.fn(async () => response({ blocked: false }));
    await expect(unblockMember(ok, 'profile/2')).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledWith('/real/blocks/profile%2F2', { method: 'DELETE' });

    const broken = jest.fn(async () => response({}, 500));
    await expect(unblockMember(broken, 'profile-2')).rejects.toThrow(
      'That person could not be unblocked. Try again.',
    );
  });

  it('lists blocked people as a set of profile ids and fails with a fixed message', async () => {
    const ok = jest.fn(async () =>
      response({ blocked: [{ profileId: 'profile-2' }, { profileId: 'profile-3' }] }),
    );
    await expect(listBlocked(ok)).resolves.toEqual(new Set(['profile-2', 'profile-3']));
    expect(ok).toHaveBeenCalledWith('/real/blocks');

    const empty = jest.fn(async () => response({}));
    await expect(listBlocked(empty)).resolves.toEqual(new Set());

    const broken = jest.fn(async () => response({}, 500));
    await expect(listBlocked(broken)).rejects.toThrow('Blocked people could not be loaded.');
  });
});
