import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import { AppState, StyleSheet, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import {
  Avatar,
  Button,
  Dialog,
  ErrorText,
  Field,
  Foot,
  Glow,
  GlowLow,
  Lead,
  SectionLabel,
  IconButton,
  ListGroup,
  ListHint,
  ListRow,
  ProgressBar,
  ScreenScroll,
  SubHeader,
  Switch,
  TextLink,
  ToastProvider,
  tint,
  useEffectKey,
  useInsets,
  useNow,
  useScreenInsets,
  useToast,
} from '../src/ui/primitives';

describe('tint', () => {
  it('mixes a colour toward white by the given percentage', () => {
    expect(tint('#000000', 0)).toBe('#ffffff');
    expect(tint('#000000', 100)).toBe('#000000');
    expect(tint('#ff0000', 50)).toBe('#ff8080');
  });

  it('can mix toward another base colour', () => {
    expect(tint('#ffffff', 50, '#000000')).toBe('#808080');
  });
});

describe('Button', () => {
  it('presses, and shows its busy label while blocking further presses', async () => {
    const onPress = jest.fn();
    const ui = await render(<Button busy busyLabel="Saving…" label="Save" onPress={onPress} />);
    expect(ui.getByText('Saving…')).toBeTruthy();
    expect(ui.getByRole('button').props.accessibilityState).toEqual({ disabled: true, busy: true });
    await fireEvent.press(ui.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('keeps its label when busy without a busy label', async () => {
    const ui = await render(<Button busy label="Save" />);
    expect(ui.getByText('Save')).toBeTruthy();
  });

  it('does not press when disabled and presses when enabled', async () => {
    const onPress = jest.fn();
    const ui = await render(<Button disabled label="Go" onPress={onPress} testID="go" />);
    await fireEvent.press(ui.getByTestId('go'));
    expect(onPress).not.toHaveBeenCalled();
    await ui.rerender(<Button label="Go" onPress={onPress} testID="go" />);
    await fireEvent.press(ui.getByTestId('go'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('applies the requested height and variant ink', async () => {
    const ui = await render(
      <>
        <Button height={44} label="Primary" testID="p" variant="primary" />
        <Button label="Danger" testID="d" variant="danger" />
      </>,
    );
    const resolve = (id: string) => StyleSheet.flatten(ui.getByTestId(id).props.style);
    expect(resolve('p').height).toBe(44);
    expect(StyleSheet.flatten(ui.getByText('Danger').props.style).color).toBe('#fff');
  });
});

describe('TextLink and IconButton', () => {
  it('fires link presses', async () => {
    const onPress = jest.fn();
    const ui = await render(<TextLink label="Report" onPress={onPress} />);
    await fireEvent.press(ui.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('adds hit slop to icon buttons smaller than 44 points', async () => {
    const ui = await render(
      <>
        <IconButton icon="close" label="Small" size={36} testID="small" />
        <IconButton icon="close" label="Normal" testID="normal" />
      </>,
    );
    expect(ui.getByTestId('small').props.hitSlop).toBe(4);
    expect(ui.getByTestId('normal').props.hitSlop).toBeUndefined();
  });

  it('is inert when disabled', async () => {
    const onPress = jest.fn();
    const ui = await render(<IconButton disabled icon="close" label="Close" onPress={onPress} />);
    await fireEvent.press(ui.getByLabelText('Close'));
    expect(onPress).not.toHaveBeenCalled();
    expect(ui.getByLabelText('Close').props.accessibilityState.disabled).toBe(true);
  });
});

describe('text blocks', () => {
  it('marks section labels as headings and renders lead and foot copy', async () => {
    const ui = await render(
      <>
        <SectionLabel>Prompt</SectionLabel>
        <Lead testID="lead">Lead copy</Lead>
        <Foot testID="foot">Foot copy</Foot>
      </>,
    );
    expect(ui.getByRole('header')).toHaveTextContent('Prompt');
    expect(ui.getByTestId('lead')).toHaveTextContent('Lead copy');
    expect(ui.getByTestId('foot')).toHaveTextContent('Foot copy');
  });

  it('hides the background glows from assistive technology', async () => {
    const ui = await render(
      <>
        <Glow top={10} />
        <GlowLow />
      </>,
    );
    expect(JSON.stringify(ui.toJSON()).match(/no-hide-descendants/g)).toHaveLength(2);
  });
});

describe('ErrorText', () => {
  it('reserves space but shows nothing without an error', async () => {
    const ui = await render(<ErrorText testID="err">{null}</ErrorText>);
    expect(ui.queryByTestId('err')).toBeNull();
    expect(ui.queryByRole('alert')).toBeNull();
  });

  it('announces an error', async () => {
    const ui = await render(<ErrorText testID="err">Something broke</ErrorText>);
    expect(ui.getByTestId('err')).toHaveTextContent('Something broke');
  });
});

describe('Field', () => {
  it('labels its input and passes typing through', async () => {
    const onChangeText = jest.fn();
    const ui = await render(
      <Field label="Name" onChangeText={onChangeText} testID="name" value="" />,
    );
    expect(ui.getByText('Name')).toBeTruthy();
    expect(ui.getByLabelText('Name')).toBeTruthy();
    await fireEvent.changeText(ui.getByTestId('name'), 'Ada');
    expect(onChangeText).toHaveBeenCalledWith('Ada');
    expect(ui.queryByTestId('name-toggle')).toBeNull();
  });

  it('prefers an explicit accessibility label', async () => {
    const ui = await render(<Field accessibilityLabel="Your name" label="Name" value="" />);
    expect(ui.getByLabelText('Your name')).toBeTruthy();
  });

  it('masks a password and lets the person show and hide it', async () => {
    const ui = await render(<Field label="Password" secureTextEntry testID="pw" value="hunter2" />);
    expect(ui.getByTestId('pw').props.secureTextEntry).toBe(true);
    await fireEvent.press(ui.getByLabelText('Show password'));
    expect(ui.getByTestId('pw').props.secureTextEntry).toBe(false);
    expect(ui.getByLabelText('Hide password').props.accessibilityState.selected).toBe(true);
    await fireEvent.press(ui.getByLabelText('Hide password'));
    expect(ui.getByTestId('pw').props.secureTextEntry).toBe(true);
  });

  it('has an unlabelled toggle id when the field has no test id', async () => {
    const ui = await render(<Field label="Password" secureTextEntry value="" />);
    expect(ui.getByLabelText('Show password').props.testID).toBeUndefined();
  });
});

describe('ListRow', () => {
  it('renders a pressable row with its note, chevron and selection check', async () => {
    const onPress = jest.fn();
    const ui = await render(
      <ListGroup>
        <ListRow
          chevron
          first
          icon="users"
          label="Members"
          note="3 people"
          onPress={onPress}
          selected
          testID="row"
        />
      </ListGroup>,
    );
    expect(ui.getByText('3 people')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('row'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('can be disabled', async () => {
    const onPress = jest.fn();
    const ui = await render(<ListRow disabled label="Delete" onPress={onPress} testID="row" />);
    expect(ui.getByTestId('row').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(ui.getByTestId('row'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders read-only rows as plain, non-pressable content', async () => {
    const ui = await render(<ListRow label="Owner only" off onPress={jest.fn()} testID="row" />);
    expect(ui.queryByRole('button')).toBeNull();
    expect(ui.getByTestId('row').props.accessible).toBe(true);
  });

  it('renders rows without a handler as plain content with custom leading and trailing parts', async () => {
    const ui = await render(
      <ListRow
        accessibilityLabel="Status"
        danger
        label="Failed"
        leading={<Text>LEAD</Text>}
        noteColor="#b00"
        note="didn’t upload"
        trailing={<Text>TRAIL</Text>}
      />,
    );
    expect(ui.getByText('LEAD')).toBeTruthy();
    expect(ui.getByText('TRAIL')).toBeTruthy();
    expect(StyleSheet.flatten(ui.getByText('didn’t upload').props.style).color).toBe('#b00');
    expect(ui.getByLabelText('Status')).toBeTruthy();
  });

  it('merges extra accessibility state into the pressable', async () => {
    const ui = await render(
      <ListRow
        accessibilityState={{ checked: true }}
        label="Option"
        onPress={jest.fn()}
        testID="row"
      />,
    );
    expect(ui.getByTestId('row').props.accessibilityState).toEqual({
      disabled: false,
      checked: true,
    });
  });

  it('draws a hint between rows', async () => {
    const ui = await render(<ListHint testID="hint">Only the owner can change this.</ListHint>);
    expect(ui.getByTestId('hint')).toHaveTextContent('Only the owner can change this.');
  });
});

describe('Switch', () => {
  it('toggles to the opposite value', async () => {
    const onValueChange = jest.fn();
    const ui = await render(
      <Switch label="Reminders" onValueChange={onValueChange} value={false} />,
    );
    expect(ui.getByRole('switch').props.accessibilityState.checked).toBe(false);
    await fireEvent.press(ui.getByRole('switch'));
    expect(onValueChange).toHaveBeenCalledWith(true);
    await ui.rerender(<Switch label="Reminders" onValueChange={onValueChange} value />);
    await fireEvent.press(ui.getByRole('switch'));
    expect(onValueChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores presses when disabled', async () => {
    const onValueChange = jest.fn();
    const ui = await render(
      <Switch disabled label="Reminders" onValueChange={onValueChange} value />,
    );
    await fireEvent.press(ui.getByRole('switch'));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('Avatar', () => {
  it('shows the upper-cased first letter, ignoring leading spaces', async () => {
    const ui = await render(<Avatar name="  ada" />);
    expect(ui.getByText('A', { includeHiddenElements: true })).toBeTruthy();
  });

  it('falls back to a question mark for an empty name', async () => {
    const ui = await render(<Avatar name="   " />);
    expect(ui.getByText('?', { includeHiddenElements: true })).toBeTruthy();
  });

  it('draws a member colour border, or the plain glass variant', async () => {
    const coloured = await render(<Avatar color="#c2410c" name="Bea" size={50} />);
    expect(coloured.getByText('B', { includeHiddenElements: true })).toBeTruthy();
    const glass = await render(<Avatar glass name="Cy" />);
    expect(glass.getByText('C', { includeHiddenElements: true })).toBeTruthy();
  });
});

describe('ProgressBar', () => {
  it('is a labelled progress bar when it has a label', async () => {
    const ui = await render(<ProgressBar label="Uploading" slow />);
    expect(ui.getByLabelText('Uploading').props.accessibilityRole).toBe('progressbar');
  });

  it('is decorative without a label and fills its container when asked', async () => {
    const ui = await render(<ProgressBar width="100%" />);
    const bar = ui.toJSON() as { props: Record<string, unknown> };
    expect(bar.props).not.toHaveProperty('accessibilityRole');
    expect((StyleSheet.flatten(bar.props.style as object) as { width: unknown }).width).toBe(
      '100%',
    );
  });
});

describe('insets', () => {
  const insets = (value: Partial<Record<'top' | 'bottom' | 'left' | 'right', number>>) => ({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    ...value,
  });

  it('is zero without a SafeAreaProvider', async () => {
    const { result } = await renderHook(() => useInsets());
    expect(result.current).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('uses the provider values and applies minimum screen padding', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SafeAreaInsetsContext.Provider value={insets({ top: 47, bottom: 34, left: 3, right: 4 })}>
        {children}
      </SafeAreaInsetsContext.Provider>
    );
    const { result } = await renderHook(() => useScreenInsets(), { wrapper });
    expect(result.current).toEqual({ top: 47, bottom: 34, left: 3, right: 4 });
  });

  it('keeps a minimum padding on screens with no safe-area inset', async () => {
    const { result } = await renderHook(() => useScreenInsets());
    expect(result.current).toEqual({ top: 10, bottom: 12, left: 0, right: 0 });
  });

  it('ScreenScroll adds the insets and extra bottom padding around its content', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SafeAreaInsetsContext.Provider value={insets({ top: 20, bottom: 30 })}>
        {children}
      </SafeAreaInsetsContext.Provider>
    );
    const ui = await render(
      <ScreenScroll bottomPad={10} contentContainerStyle={{ gap: 2 }} testID="scroll">
        <Text>content</Text>
      </ScreenScroll>,
      { wrapper },
    );
    expect(ui.getByText('content')).toBeTruthy();
    const content = StyleSheet.flatten(ui.getByTestId('scroll').props.contentContainerStyle);
    expect(content).toMatchObject({ paddingTop: 20, paddingBottom: 40, gap: 2 });
  });
});

describe('SubHeader', () => {
  it('shows a back button only when it can go back', async () => {
    const onBack = jest.fn();
    const ui = await render(
      <SubHeader
        backLabel="Close"
        backTestID="back"
        onBack={onBack}
        right={<Text>Edit</Text>}
        title="Settings"
      />,
    );
    expect(ui.getByText('Settings')).toBeTruthy();
    expect(ui.getByText('Edit')).toBeTruthy();
    await fireEvent.press(ui.getByLabelText('Close'));
    expect(onBack).toHaveBeenCalledTimes(1);
    await ui.rerender(<SubHeader title="Settings" />);
    expect(ui.queryByTestId('back')).toBeNull();
  });
});

describe('Dialog', () => {
  it('shows a title, a string body and its actions, and dismisses from the backdrop', async () => {
    const onDismiss = jest.fn();
    const ui = await render(
      <Dialog
        body="This cannot be undone."
        label="Confirm"
        onDismiss={onDismiss}
        testID="dialog"
        title="Delete?"
      >
        <Button label="Delete" />
      </Dialog>,
    );
    expect(ui.getByText('Delete?')).toBeTruthy();
    expect(ui.getByText('This cannot be undone.')).toBeTruthy();
    await fireEvent.press(ui.getByRole('button', { name: 'Dismiss', hidden: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders a custom body node and has no dismiss action without onDismiss', async () => {
    const ui = await render(
      <Dialog body={<Text>Custom body</Text>} label="Busy">
        <Button label="Wait" />
      </Dialog>,
    );
    expect(ui.getByText('Custom body')).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Dismiss', hidden: true })).toBeNull();
  });
});

describe('Toast', () => {
  function Trigger({ text }: { text: string }) {
    const toast = useToast();
    return (
      <Text onPress={() => toast(text)} testID="trigger">
        show
      </Text>
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows a message and removes it after a few seconds', async () => {
    const ui = await render(
      <ToastProvider>
        <Trigger text="Saved." />
      </ToastProvider>,
    );
    expect(ui.queryByTestId('app-toast')).toBeNull();
    await fireEvent.press(ui.getByTestId('trigger'));
    expect(ui.getByTestId('app-toast')).toHaveTextContent('Saved.');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2600);
    });
    expect(ui.queryByTestId('app-toast')).toBeNull();
  });

  it('replaces a visible message and restarts the timer', async () => {
    function Two() {
      const toast = useToast();
      return (
        <>
          <Text onPress={() => toast('First')} testID="one">
            one
          </Text>
          <Text onPress={() => toast('Second')} testID="two">
            two
          </Text>
        </>
      );
    }
    const ui = await render(
      <ToastProvider>
        <Two />
      </ToastProvider>,
    );
    await fireEvent.press(ui.getByTestId('one'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    await fireEvent.press(ui.getByTestId('two'));
    expect(ui.getByTestId('app-toast')).toHaveTextContent('Second');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(ui.getByTestId('app-toast')).toHaveTextContent('Second');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(700);
    });
    expect(ui.queryByTestId('app-toast')).toBeNull();
  });

  it('is a harmless no-op outside a provider', async () => {
    const ui = await render(<Trigger text="Nobody listens" />);
    await fireEvent.press(ui.getByTestId('trigger'));
    expect(ui.queryByTestId('app-toast')).toBeNull();
  });

  it('clears its timer when unmounted while a toast is showing', async () => {
    const ui = await render(
      <ToastProvider>
        <Trigger text="Bye" />
      </ToastProvider>,
    );
    await fireEvent.press(ui.getByTestId('trigger'));
    await ui.unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
  });
});

describe('useEffectKey', () => {
  it('changes its key every time it fires', async () => {
    const { result } = await renderHook(() => useEffectKey());
    const [initial] = result.current;
    await act(async () => result.current[1]());
    const [afterOne] = result.current;
    await act(async () => result.current[1]());
    const [afterTwo] = result.current;
    expect([initial, afterOne, afterTwo]).toEqual([0, 1, 2]);
  });
});

describe('useNow', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-10-14T10:00:00.000Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('refreshes on the interval', async () => {
    const { result } = await renderHook(() => useNow(1000));
    const first = result.current;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(result.current - first).toBe(3000);
  });

  it('catches up as soon as the app returns to the foreground', async () => {
    let onChange: (state: string) => void = () => {};
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      listener: (state: string) => void,
    ) => {
      onChange = listener;
      return { remove };
    }) as unknown as typeof AppState.addEventListener);
    const { result, unmount } = await renderHook(() => useNow(60_000));
    const first = result.current;
    jest.setSystemTime(first + 10_000);
    await act(async () => onChange('background'));
    expect(result.current).toBe(first);
    await act(async () => onChange('active'));
    expect(result.current).toBe(first + 10_000);
    await unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
