import { render } from '@testing-library/react-native';

import App from '../App';

describe('Rewind foundation shell', () => {
  it('shows an accessible title and honest local-demo status', async () => {
    const result = await render(<App />);

    expect(result.getByRole('header', { name: 'Rewind' })).toBeTruthy();
    expect(result.getByText('Local demo')).toBeTruthy();
    expect(result.getByText('Foundation shell ready')).toBeTruthy();
    expect(result.getByLabelText('Local demo shell status')).toBeTruthy();
  });
});
