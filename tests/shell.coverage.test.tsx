import { act, fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { ShutterState } from '../src/real/home-model';
import { Dock, GroupMenu, ScreenFades, TabColumn, TopBar, type MenuGroup } from '../src/real/Shell';

const ready = (left = 3): ShutterState => ({
  kind: 'ready',
  left,
  label: `Add a moment · ${left} of 5 left`,
});
const used: ShutterState = {
  kind: 'used',
  label: 'This week’s 5 moments are used · resets in 2 days',
  tip: 'All 5 used · resets in 2 days',
};

describe('TopBar', () => {
  it('shows the group as a menu button reflecting whether the menu is open', async () => {
    const onToggleMenu = jest.fn();
    const ui = await render(
      <TopBar
        accountName="Ada"
        groupName="Saturday table"
        menuOpen={false}
        onOpenSettings={jest.fn()}
        onToggleMenu={onToggleMenu}
      />,
    );
    const button = ui.getByLabelText('Saturday table · switch group');
    expect(button.props.accessibilityState).toEqual({ expanded: false });
    await fireEvent.press(button);
    expect(onToggleMenu).toHaveBeenCalledTimes(1);
    await ui.rerender(
      <TopBar
        accountName="Ada"
        groupName="Saturday table"
        menuOpen
        onOpenSettings={jest.fn()}
        onToggleMenu={onToggleMenu}
      />,
    );
    expect(ui.getByLabelText('Saturday table · switch group').props.accessibilityState).toEqual({
      expanded: true,
    });
  });

  it('says Rewind and offers no menu before there is a group', async () => {
    const ui = await render(
      <TopBar accountName="Ada" groupName={null} onOpenSettings={jest.fn()} />,
    );
    expect(ui.getByText('Rewind')).toBeTruthy();
    expect(ui.queryByTestId('real-group-menu-button')).toBeNull();
  });

  it('opens settings from the account avatar', async () => {
    const onOpenSettings = jest.fn();
    const ui = await render(
      <TopBar accountName="Ada" groupName="Garden" onOpenSettings={onOpenSettings} />,
    );
    await fireEvent.press(ui.getByLabelText('Ada · settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('GroupMenu', () => {
  const groups: MenuGroup[] = [
    { id: 'g1', name: 'Saturday table', unread: 0 },
    { id: 'g2', name: 'Garden circle', unread: 3 },
    { id: 'g3', name: 'Old friends' },
  ];
  const setup = async (props: Partial<React.ComponentProps<typeof GroupMenu>> = {}) => {
    const handlers = {
      onPick: jest.fn(),
      onJoin: jest.fn(),
      onCreate: jest.fn(),
      onClose: jest.fn(),
    };
    const ui = await render(<GroupMenu currentId="g1" groups={groups} {...handlers} {...props} />);
    return { ui, ...handlers };
  };

  it('marks the active group and closes instead of switching when it is picked again', async () => {
    const { ui, onPick, onClose } = await setup();
    expect(ui.getByTestId('switch-real-group-g1').props.accessibilityState.checked).toBe(true);
    expect(ui.getByTestId('switch-real-group-g2').props.accessibilityState.checked).toBe(false);
    await fireEvent.press(ui.getByTestId('switch-real-group-g1'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('switches to another group and announces unread counts', async () => {
    const { ui, onPick } = await setup();
    expect(ui.getByLabelText('Garden circle, 3 unread')).toBeTruthy();
    expect(ui.getByLabelText('Old friends')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('switch-real-group-g2'));
    expect(onPick).toHaveBeenCalledWith('g2');
  });

  it('shows a removed group greyed with an explanation and no way to open it', async () => {
    const { ui, onPick } = await setup({ removedId: 'g3' });
    expect(ui.getByText('You’re no longer in this group')).toBeTruthy();
    expect(ui.queryByTestId('switch-real-group-g3')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('blocks switching while disabled', async () => {
    const { ui, onPick } = await setup({ disabled: true });
    expect(ui.getByTestId('switch-real-group-g2').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(ui.getByTestId('switch-real-group-g2'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('offers joining and creating a group, and closes from the backdrop', async () => {
    const { ui, onJoin, onCreate, onClose } = await setup();
    await fireEvent.press(ui.getByTestId('real-group-menu-join'));
    await fireEvent.press(ui.getByTestId('real-group-menu-create'));
    await fireEvent.press(ui.getByTestId('real-group-menu-dismiss'));
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('marks nothing as active without a current group', async () => {
    const { ui } = await setup({ currentId: null });
    for (const id of ['g1', 'g2', 'g3'])
      expect(ui.getByTestId(`switch-real-group-${id}`).props.accessibilityState.checked).toBe(
        false,
      );
  });
});

describe('Dock', () => {
  const setup = async (props: Partial<React.ComponentProps<typeof Dock>> = {}) => {
    const onSelect = jest.fn();
    const onShutter = jest.fn();
    const ui = await render(
      <Dock
        active="home"
        chatUnread={0}
        newFilm={false}
        onSelect={onSelect}
        onShutter={onShutter}
        shutter={ready()}
        {...props}
      />,
    );
    return { ui, onSelect, onShutter };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('selects tabs and marks the active one', async () => {
    const { ui, onSelect } = await setup({ active: 'chat' });
    expect(ui.getByTestId('real-group-nav-chat').props.accessibilityState.selected).toBe(true);
    expect(ui.getByTestId('real-group-nav-home').props.accessibilityState.selected).toBe(false);
    await fireEvent.press(ui.getByTestId('real-group-nav-archive'));
    await fireEvent.press(ui.getByTestId('real-group-nav-home'));
    expect(onSelect.mock.calls.map(([tab]) => tab)).toEqual(['archive', 'home']);
  });

  it('announces unread chat messages and caps the badge at 99+', async () => {
    const { ui } = await setup({ chatUnread: 4 });
    expect(ui.getByLabelText('Chat, 4 unread')).toBeTruthy();
    expect(ui.getByText('4', { includeHiddenElements: true })).toBeTruthy();
    await ui.rerender(
      <Dock
        active="home"
        chatUnread={250}
        newFilm={false}
        onSelect={jest.fn()}
        onShutter={jest.fn()}
        shutter={ready()}
      />,
    );
    expect(ui.getByText('99+', { includeHiddenElements: true })).toBeTruthy();
  });

  it('does not badge the tab you are already on', async () => {
    const { ui } = await setup({ active: 'chat', chatUnread: 4, newFilm: true });
    expect(ui.getByLabelText('Chat')).toBeTruthy();
    expect(ui.queryByText('4', { includeHiddenElements: true })).toBeNull();
    expect(ui.getByLabelText('Archive, new film')).toBeTruthy();
  });

  it('announces a new film on the Archive tab until it is opened', async () => {
    const { ui } = await setup({ newFilm: true });
    expect(ui.getByLabelText('Archive, new film')).toBeTruthy();
    await ui.rerender(
      <Dock
        active="archive"
        chatUnread={0}
        newFilm
        onSelect={jest.fn()}
        onShutter={jest.fn()}
        shutter={ready()}
      />,
    );
    expect(ui.getByLabelText('Archive')).toBeTruthy();
  });

  it('hides the shutter when there is no capture state', async () => {
    const { ui } = await setup({ shutter: null });
    expect(ui.queryByTestId('real-group-capture-action')).toBeNull();
  });

  it('opens capture from a ready shutter', async () => {
    const { ui, onShutter } = await setup();
    const shutter = ui.getByLabelText('Add a moment · 3 of 5 left');
    await fireEvent.press(shutter);
    expect(onShutter).toHaveBeenCalledTimes(1);
  });

  it('explains why a used shutter does nothing', async () => {
    const { ui, onShutter } = await setup({ shutter: used });
    const shutter = ui.getByTestId('real-group-capture-action');
    expect(shutter.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(shutter);
    expect(onShutter).not.toHaveBeenCalled();
    expect(ui.getByText('All 5 used · resets in 2 days')).toBeTruthy();
  });

  it('lets the used-shutter hint fade after a couple of seconds', async () => {
    const { ui } = await setup({ shutter: used });
    await fireEvent.press(ui.getByTestId('real-group-capture-action'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(ui.queryByText('All 5 used · resets in 2 days')).toBeNull();
  });

  it('ignores presses while a moment is being prepared', async () => {
    const { ui, onShutter } = await setup({ shutterPending: true });
    const shutter = ui.getByTestId('real-group-capture-action');
    expect(shutter.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    await fireEvent.press(shutter);
    expect(onShutter).not.toHaveBeenCalled();
  });

  it('flashes Sealed when a moment was just sealed', async () => {
    const { ui } = await setup({ sealedTip: 1 });
    await act(async () => {});
    expect(ui.getByText('Sealed')).toBeTruthy();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(ui.queryByText('Sealed')).toBeNull();
  });
});

describe('tab frame helpers', () => {
  it('renders tab content inside the column', async () => {
    const ui = await render(
      <TabColumn>
        <Text>Tab body</Text>
      </TabColumn>,
    );
    expect(ui.getByText('Tab body')).toBeTruthy();
  });

  it('draws the screen fades with and without the dock fade', async () => {
    const withDock = await render(<ScreenFades />);
    const withoutDock = await render(<ScreenFades dock={false} />);
    expect(withDock.toJSON()).toBeTruthy();
    expect(withoutDock.toJSON()).toBeTruthy();
  });
});
