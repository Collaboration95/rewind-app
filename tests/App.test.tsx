import { render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import App from '../App';

describe('Rewind Home start screen', () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens with a clear accessible title and local-demo entry state', async () => {
    const result = await render(<App />);

    expect(result.getByRole('header', { name: 'Moments worth waiting for.' })).toBeTruthy();
    expect(result.getByText('HOME')).toBeTruthy();
    expect(result.getByLabelText('Local demo')).toBeTruthy();
  });

  it('uses a decorative film strip without simulating later capabilities', async () => {
    const result = await render(<App />);

    expect(result.getByTestId('ambient-film-strip', { includeHiddenElements: true })).toBeTruthy();
    expect(result.queryAllByRole('button')).toHaveLength(0);
    expect(result.queryByText(/account|cloud|upload/i)).toBeNull();
  });
});
