import { userMessage } from '../src/domain/user-message';

describe('userMessage', () => {
  it('keeps messages we wrote and replaces browser and parser noise', () => {
    expect(userMessage(new Error('That invite has expired.'), 'fallback')).toBe(
      'That invite has expired.',
    );
    expect(userMessage(new TypeError('Failed to fetch'), 'fallback')).toBe('fallback');
    expect(userMessage(new TypeError('Load failed'), 'fallback')).toBe('fallback');
    expect(userMessage(new SyntaxError('Unexpected token <'), 'fallback')).toBe('fallback');
    expect(
      userMessage(
        Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
        'fallback',
      ),
    ).toBe('fallback');
    expect(userMessage(new Error(''), 'fallback')).toBe('fallback');
    expect(userMessage('string', 'fallback')).toBe('fallback');
  });
});
