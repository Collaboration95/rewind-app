import { fireEvent, render } from '@testing-library/react-native';

import App from '../App';

describe('Rewind US-01', () => {
  it('opens on the Darkroom Home design with explicit demo data', async () => {
    const result = await render(<App />);

    expect(result.getByRole('header', { name: 'Weekend People' })).toBeTruthy();
    expect(result.getByLabelText('Developing local demo')).toBeTruthy();
    expect(result.getByLabelText('Reveal in 2 days 14 hours')).toBeTruthy();
    expect(result.getByText('What made you pause\nand smile?')).toBeTruthy();
  });

  it('shows the sealed film, group progress, quota, and weekly action', async () => {
    const result = await render(<App />);

    expect(result.getByTestId('sealed-film-strip')).toBeTruthy();
    expect(result.getByText('4 of 5 friends added moments')).toBeTruthy();
    expect(result.getByLabelText('2 of 5 photos used')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Add to the roll' })).toBeTruthy();
  });

  it('makes all four main areas reachable and marks the selected tab', async () => {
    const result = await render(<App />);

    expect(result.getAllByRole('tab')).toHaveLength(4);
    expect(result.getByRole('tab', { name: 'Home', selected: true })).toBeTruthy();

    for (const route of ['Camera', 'Chat', 'Archive']) {
      await fireEvent.press(result.getByRole('tab', { name: route }));
      expect(result.getByRole('header', { name: route })).toBeTruthy();
      expect(result.getByRole('tab', { name: route, selected: true })).toBeTruthy();
    }
  });

  it('opens Camera from the weekly action', async () => {
    const result = await render(<App />);

    await fireEvent.press(result.getByRole('button', { name: 'Add to the roll' }));
    expect(result.getByRole('header', { name: 'Camera' })).toBeTruthy();
    expect(result.getByRole('tab', { name: 'Camera', selected: true })).toBeTruthy();
  });
});
