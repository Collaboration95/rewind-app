import { useState } from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { TrimBar } from '../src/capture/camera-ui';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function FractionalClipTrim() {
  const [bounds, setBounds] = useState({ start: 0, end: 6.13 });
  return (
    <TrimBar
      duration={6.13}
      start={bounds.start}
      end={bounds.end}
      onChange={(start, end) => setBounds({ start, end })}
    />
  );
}

it('steps a fractional recorded duration onto half-second trim marks while preserving bounds', async () => {
  const screen = await render(<FractionalClipTrim />);
  for (let count = 0; count < 4; count++) {
    await fireEvent(screen.getByLabelText('Trim end'), 'accessibilityAction', {
      nativeEvent: { actionName: 'decrement' },
    });
  }
  expect(screen.getByTestId('video-trim-text')).toHaveTextContent('0.0 – 4.5 s · 4.5 s');
  await fireEvent(screen.getByLabelText('Trim end'), 'keyDown', {
    key: 'ArrowRight',
    preventDefault: jest.fn(),
  });
  expect(screen.getByTestId('video-trim-text')).toHaveTextContent('0.0 – 5.0 s · 5.0 s');
  await fireEvent(screen.getByLabelText('Trim end'), 'keyDown', {
    key: 'ArrowLeft',
    shiftKey: true,
    preventDefault: jest.fn(),
  });
  expect(screen.getByTestId('video-trim-text')).toHaveTextContent('0.0 – 4.9 s · 4.9 s');
  await fireEvent(screen.getByLabelText('Trim end'), 'keyDown', {
    key: 'ArrowRight',
    shiftKey: true,
    preventDefault: jest.fn(),
  });
  expect(screen.getByTestId('video-trim-text')).toHaveTextContent('0.0 – 5.0 s · 5.0 s');
  for (let count = 0; count < 15; count++) {
    await fireEvent(screen.getByLabelText('Trim start'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
  }
  expect(screen.getByTestId('video-trim-text')).toHaveTextContent('4.5 – 5.0 s · 0.5 s');
});
