import { fireEvent, render } from '@testing-library/react-native';

import { BUILT_IN_PROMPTS, GROUP_NAME_MAX_LENGTH, PROMPT_MAX_LENGTH } from '../src/domain/groups';
import {
  CreateGroupScreen,
  JoinScreen,
  formatInviteCode,
  validateNewGroup,
} from '../src/real/GroupFlows';

// The prompt picker belongs to Settings and has its own tests. Here it only has
// to let the form choose a built-in prompt, pick "custom" and type one.
jest.mock('../src/real/Settings', () => ({
  PromptPicker: ({
    value,
    custom,
    onChange,
    onCustomChange,
  }: {
    value: string;
    custom: string;
    onChange: (value: string) => void;
    onCustomChange: (value: string) => void;
  }) => {
    const { Pressable, Text, TextInput, View } = jest.requireActual('react-native');
    return (
      <View>
        <Text testID="picker-value">{value}</Text>
        <Pressable onPress={() => onChange('Second built-in prompt')} testID="pick-builtin">
          <Text>Built-in</Text>
        </Pressable>
        <Pressable onPress={() => onChange('custom')} testID="pick-custom">
          <Text>Custom</Text>
        </Pressable>
        <TextInput onChangeText={onCustomChange} testID="custom-prompt" value={custom} />
      </View>
    );
  },
}));

const EXPIRES = '2099-01-01T00:00:00.000Z';

describe('formatInviteCode', () => {
  it('upper-cases, strips non-letters and hyphenates after three letters', () => {
    expect(formatInviteCode('ab')).toBe('AB');
    expect(formatInviteCode('abc')).toBe('ABC');
    expect(formatInviteCode('abcd')).toBe('ABC-D');
    expect(formatInviteCode('a1b 2c-d!e')).toBe('ABC-DE');
  });

  it('keeps at most six letters', () => {
    expect(formatInviteCode('abcdefghij')).toBe('ABC-DEF');
  });

  it('returns nothing for input without letters', () => {
    expect(formatInviteCode('123 - 456')).toBe('');
    expect(formatInviteCode('')).toBe('');
  });

  it('takes only the code out of a pasted invitation link', () => {
    expect(
      formatInviteCode(`  https://rewind.example/invite?code=xyzuvw&expiresAt=${EXPIRES}  `),
    ).toBe('XYZ-UVW');
    expect(formatInviteCode(`rewind://invite?code=qrstuv&expiresAt=${EXPIRES}`)).toBe('QRS-TUV');
  });
});

describe('validateNewGroup', () => {
  const valid = { name: 'Saturday table', prompt: 'What made you smile?', maxMembers: 4 };

  it('accepts a complete group', () => {
    expect(validateNewGroup(valid)).toBeNull();
    expect(validateNewGroup({ ...valid, maxMembers: 2 })).toBeNull();
    expect(validateNewGroup({ ...valid, maxMembers: 10 })).toBeNull();
    expect(
      validateNewGroup({
        ...valid,
        name: 'n'.repeat(GROUP_NAME_MAX_LENGTH),
        prompt: 'p'.repeat(PROMPT_MAX_LENGTH),
      }),
    ).toBeNull();
  });

  it('requires a name within the limit', () => {
    const message = `Enter a group name of 1–${GROUP_NAME_MAX_LENGTH} characters.`;
    expect(validateNewGroup({ ...valid, name: '' })).toBe(message);
    expect(validateNewGroup({ ...valid, name: '   ' })).toBe(message);
    expect(validateNewGroup({ ...valid, name: 'n'.repeat(GROUP_NAME_MAX_LENGTH + 1) })).toBe(
      message,
    );
  });

  it('requires a prompt within the limit', () => {
    const message = `Enter a prompt of 1–${PROMPT_MAX_LENGTH} characters.`;
    expect(validateNewGroup({ ...valid, prompt: ' ' })).toBe(message);
    expect(validateNewGroup({ ...valid, prompt: 'p'.repeat(PROMPT_MAX_LENGTH + 1) })).toBe(message);
  });

  it('requires a whole member limit from 2 to 10', () => {
    const message = 'Choose a member limit from 2 to 10.';
    for (const maxMembers of [1, 11, 0, -3, 2.5, Number.NaN])
      expect(validateNewGroup({ ...valid, maxMembers })).toBe(message);
  });

  it('checks the name before the prompt and the prompt before the limit', () => {
    expect(validateNewGroup({ name: '', prompt: '', maxMembers: 99 })).toMatch(/group name/);
    expect(validateNewGroup({ ...valid, prompt: '', maxMembers: 99 })).toMatch(/prompt/);
  });
});

describe('JoinScreen', () => {
  const setup = async (props: Partial<React.ComponentProps<typeof JoinScreen>> = {}) => {
    const handlers = { onBack: jest.fn(), onJoin: jest.fn(), onGoToGroup: jest.fn() };
    const ui = await render(
      <JoinScreen error={null} joinedName={null} pending={false} {...handlers} {...props} />,
    );
    return { ui, ...handlers };
  };

  it('formats the code as it is typed and submits it with the button', async () => {
    const { ui, onJoin } = await setup();
    const input = ui.getByTestId('real-group-enter-code');
    await fireEvent.changeText(input, 'abcdef');
    expect(ui.getByTestId('real-group-enter-code').props.value).toBe('ABC-DEF');
    await fireEvent.press(ui.getByTestId('real-group-join-choice'));
    expect(onJoin).toHaveBeenCalledWith('ABC-DEF');
  });

  it('submits from the keyboard too', async () => {
    const { ui, onJoin } = await setup();
    await fireEvent.changeText(ui.getByTestId('real-group-enter-code'), 'xyzuvw');
    await fireEvent(ui.getByTestId('real-group-enter-code'), 'submitEditing');
    expect(onJoin).toHaveBeenCalledWith('XYZ-UVW');
  });

  it('fills in just the code from a pasted link', async () => {
    const { ui } = await setup();
    await fireEvent.changeText(
      ui.getByTestId('real-group-enter-code'),
      `https://rewind.example/invite?code=lmnopq&expiresAt=${EXPIRES}`,
    );
    expect(ui.getByTestId('real-group-enter-code').props.value).toBe('LMN-OPQ');
  });

  it('shows a server error under the field', async () => {
    const { ui } = await setup({ error: 'That code has already been used.' });
    expect(ui.getByTestId('real-group-join-feedback')).toHaveTextContent(
      'That code has already been used.',
    );
  });

  it('shows progress while joining', async () => {
    const { ui } = await setup({ pending: true });
    expect(ui.getByText('Joining…')).toBeTruthy();
  });

  it('goes back', async () => {
    const { ui, onBack } = await setup();
    await fireEvent.press(ui.getByTestId('real-join-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('confirms the joined group and continues to it, without the code form', async () => {
    const { ui, onGoToGroup } = await setup({ joinedName: 'Garden circle' });
    expect(ui.getByText('Joined Garden circle')).toBeTruthy();
    expect(ui.getByText('The code is now used.')).toBeTruthy();
    expect(ui.queryByTestId('real-group-enter-code')).toBeNull();
    await fireEvent.press(ui.getByTestId('real-join-go'));
    expect(onGoToGroup).toHaveBeenCalledTimes(1);
  });
});

describe('CreateGroupScreen', () => {
  const setup = async (props: Partial<React.ComponentProps<typeof CreateGroupScreen>> = {}) => {
    const handlers = { onBack: jest.fn(), onCreate: jest.fn() };
    const ui = await render(
      <CreateGroupScreen error={null} pending={false} {...handlers} {...props} />,
    );
    return { ui, ...handlers };
  };
  const submit = (ui: Awaited<ReturnType<typeof setup>>['ui']) =>
    fireEvent.press(ui.getByTestId('real-group-create-submit'));

  it('creates a group with the first built-in prompt and the default limit of 10', async () => {
    const { ui, onCreate } = await setup();
    await fireEvent.changeText(ui.getByTestId('real-group-name'), '  Saturday table  ');
    await submit(ui);
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Saturday table',
      prompt: BUILT_IN_PROMPTS[0],
      maxMembers: 10,
    });
  });

  it('refuses to create without a name and explains why', async () => {
    const { ui, onCreate } = await setup();
    await submit(ui);
    expect(onCreate).not.toHaveBeenCalled();
    expect(
      ui.getByText(`Enter a group name of 1–${GROUP_NAME_MAX_LENGTH} characters.`),
    ).toBeTruthy();
  });

  it('clears the message once the form is valid', async () => {
    const { ui, onCreate } = await setup();
    await submit(ui);
    await fireEvent.changeText(ui.getByTestId('real-group-name'), 'Garden');
    await submit(ui);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(ui.queryByText(/Enter a group name/)).toBeNull();
  });

  it('uses a custom prompt, and rejects an empty one', async () => {
    const { ui, onCreate } = await setup();
    await fireEvent.changeText(ui.getByTestId('real-group-name'), 'Garden');
    await fireEvent.press(ui.getByTestId('pick-custom'));
    await submit(ui);
    expect(onCreate).not.toHaveBeenCalled();
    expect(ui.getByText(`Enter a prompt of 1–${PROMPT_MAX_LENGTH} characters.`)).toBeTruthy();
    await fireEvent.changeText(ui.getByTestId('custom-prompt'), '  What are you grateful for?  ');
    await submit(ui);
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Garden',
      prompt: 'What are you grateful for?',
      maxMembers: 10,
    });
  });

  it('uses another built-in prompt when chosen', async () => {
    const { ui, onCreate } = await setup();
    await fireEvent.changeText(ui.getByTestId('real-group-name'), 'Garden');
    await fireEvent.press(ui.getByTestId('pick-builtin'));
    await submit(ui);
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Second built-in prompt' }),
    );
  });

  it('steps the member limit between 2 and 10 and disables the ends', async () => {
    const { ui, onCreate } = await setup();
    const decrease = () => ui.getByTestId('real-group-capacity-decrease');
    const increase = () => ui.getByTestId('real-group-capacity-increase');
    expect(increase().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(increase());
    expect(ui.getByTestId('real-group-capacity')).toHaveTextContent('10');
    for (let i = 0; i < 8; i += 1) await fireEvent.press(decrease());
    expect(ui.getByTestId('real-group-capacity')).toHaveTextContent('2');
    expect(decrease().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(decrease());
    expect(ui.getByTestId('real-group-capacity')).toHaveTextContent('2');
    await fireEvent.press(increase());
    expect(ui.getByTestId('real-group-capacity')).toHaveTextContent('3');
    await fireEvent.changeText(ui.getByTestId('real-group-name'), 'Small');
    await submit(ui);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ maxMembers: 3 }));
  });

  it('shows a server error until the local validation replaces it', async () => {
    const { ui } = await setup({ error: 'You can’t create more groups.' });
    expect(ui.getByText('You can’t create more groups.')).toBeTruthy();
    await submit(ui);
    expect(ui.queryByText('You can’t create more groups.')).toBeNull();
    expect(ui.getByText(/Enter a group name/)).toBeTruthy();
  });

  it('shows progress while creating, and goes back', async () => {
    const { ui, onBack } = await setup({ pending: true });
    expect(ui.getByText('Creating group…')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-create-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('limits the group name length at the input', async () => {
    const { ui } = await setup();
    expect(ui.getByTestId('real-group-name').props.maxLength).toBe(GROUP_NAME_MAX_LENGTH);
  });
});
