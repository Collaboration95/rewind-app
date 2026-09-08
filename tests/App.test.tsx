import { fireEvent, render } from '@testing-library/react-native';

import App from '../App';

describe('Rewind Home start screen', () => {
  it('shows the sample group and local-demo capsule summary', async () => {
    const result = await render(<App />);

    expect(result.getByRole('header', { name: 'Weekend People' })).toBeTruthy();
    expect(result.getByLabelText('Local demo data')).toBeTruthy();
    expect(
      result.getByLabelText('Current capsule. Reveal in 2 days. 4 of 5 members added a moment.'),
    ).toBeTruthy();
  });

  it('starts on Home and makes every main area reachable', async () => {
    const result = await render(<App />);

    expect(result.getByRole('header', { name: 'Weekend People' })).toBeTruthy();

    for (const area of [
      { key: 'camera', label: 'Camera' },
      { key: 'chat', label: 'Chat' },
      { key: 'archive', label: 'Archive' },
    ]) {
      await fireEvent.press(result.getByTestId(`nav-${area.key}`));

      expect(result.getByRole('header', { name: area.label })).toBeTruthy();
    }
  });

  it('provides named tabs with a visible and accessible selected state', async () => {
    const result = await render(<App />);

    expect(result.getByRole('tab', { name: 'Home', selected: true })).toBeTruthy();
    expect(result.getByText('SELECTED')).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Chat' }));

    expect(result.getByRole('tab', { name: 'Chat', selected: true })).toBeTruthy();
    expect(result.getAllByText('SELECTED')).toHaveLength(1);
  });

  it('uses honest unavailable states for unfinished areas', async () => {
    const result = await render(<App />);

    await fireEvent.press(result.getByRole('tab', { name: 'Camera' }));
    expect(
      result.getByText('Camera capture and permissions are not implemented in this Sprint 0 demo.'),
    ).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Chat' }));
    expect(
      result.getByText('Chat is not implemented. No messages are being sent or stored.'),
    ).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Archive' }));
    expect(
      result.getByText(
        'Archive playback is not implemented. Locked moments remain unavailable until reveal.',
      ),
    ).toBeTruthy();
  });

  it('keeps sample moments sealed and does not claim Camera is available', async () => {
    const result = await render(<App />);

    expect(result.getByLabelText('Locked demo moment 1 of 3')).toBeTruthy();
    expect(result.getByLabelText('Locked demo moment 2 of 3')).toBeTruthy();
    expect(result.getByLabelText('Locked demo moment 3 of 3')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Add a moment', disabled: true })).toBeTruthy();
    expect(result.getByText('Camera is not available in this task.')).toBeTruthy();
  });

  it('shows the weekly prompt and quota', async () => {
    const result = await render(<App />);

    expect(result.getByLabelText('Weekly prompt: What made you pause and smile?')).toBeTruthy();
    expect(result.getByLabelText('Weekly quota. 2 of 5 moments used.')).toBeTruthy();
  });
});
