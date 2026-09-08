import { render } from '@testing-library/react-native';

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
