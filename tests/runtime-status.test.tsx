import { act, fireEvent, render } from '@testing-library/react-native';

import { RuntimeStatusCard } from '../src/runtime/RuntimeStatusCard';
import type { RuntimeClient, RuntimeHealth } from '../src/runtime/local-runtime-client';

const health: RuntimeHealth = {
  ok: true,
  service: 'rewind-local-runtime',
  version: '0.1.0',
  ready: true,
  checks: { sqlite: true, ffmpegConfigured: true },
  addresses: { local: 'http://127.0.0.1:8787', lan: 'http://192.168.1.20:8787' },
};

function clientWithHealth(getHealth: RuntimeClient['getHealth']): RuntimeClient {
  return {
    baseUrl: 'http://127.0.0.1:8787',
    getHealth,
    getGroupForMember: jest.fn(),
    getCurrentCycle: jest.fn(),
    advanceDemoCycle: jest.fn(),
  };
}

describe('RuntimeStatusCard', () => {
  it('renders connected readiness and exposes safe runtime details', async () => {
    const result = await render(
      <RuntimeStatusCard client={clientWithHealth(jest.fn().mockResolvedValue(health))} />,
    );
    await result.findByText('Connected · v0.1.0');
    expect(result.getByText('SQLite ready · FFmpeg configured')).toBeTruthy();
    expect(result.getByLabelText('Local runtime connected')).toBeTruthy();
  });

  it('renders a clear disconnected state and retries the health check', async () => {
    const getHealth = jest
      .fn()
      .mockRejectedValueOnce(new Error('Check that the service is running.'))
      .mockResolvedValueOnce(health);
    const result = await render(<RuntimeStatusCard client={clientWithHealth(getHealth)} />);
    await result.findByText('Runtime unavailable');
    expect(result.getByText('Check that the service is running.')).toBeTruthy();
    await act(async () =>
      fireEvent.press(result.getByRole('button', { name: 'Retry connection' })),
    );
    await result.findByText('Connected · v0.1.0');
    expect(getHealth).toHaveBeenCalledTimes(2);
  });
});
