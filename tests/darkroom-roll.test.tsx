import { render } from '@testing-library/react-native';
import { DarkroomRoll } from '../src/capsule/DarkroomRoll';

it.each([false, true])('keeps the roll caption consistent with released=%s', async (released) => {
  const view = await render(<DarkroomRoll seconds={3600} released={released} />);
  expect(
    view.getByText(
      released
        ? 'Released roll illustration · watch in Archive'
        : 'Sealed roll illustration · no media previews',
    ),
  ).toBeTruthy();
  expect(
    view.queryByText(
      released
        ? 'Sealed roll illustration · no media previews'
        : 'Released roll illustration · watch in Archive',
    ),
  ).toBeNull();
  expect(view.getByTestId('darkroom-filmstrip').props.accessibilityLabel).toMatch(
    released ? /Released/ : /sealed/,
  );
});
