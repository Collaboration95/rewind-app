import type { CreateGroupInput, GroupCreateFailureReason } from './profiles';

export const GROUP_NAME_MAX_LENGTH = 80;
export const PROMPT_MAX_LENGTH = 160;
export const LOCAL_DEMO_CYCLE_DURATION_MS = 24 * 60 * 60 * 1000;
export const LOCAL_GROUPS_STORAGE_KEY = 'rewind.local-demo.groups.v1';

export const BUILT_IN_PROMPTS = [
  'What made you pause and smile?',
  'What is one small detail from today worth keeping?',
  'What would you like to remember about this moment?',
] as const;

export type GroupInputErrors = Partial<Record<'name' | 'prompt', GroupCreateFailureReason>>;

export function validateGroupInput(input: CreateGroupInput): GroupInputErrors {
  const errors: GroupInputErrors = {};
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name) errors.name = 'required';
  else if (name.length > GROUP_NAME_MAX_LENGTH) errors.name = 'too_long';
  if (!prompt) errors.prompt = 'required';
  else if (prompt.length > PROMPT_MAX_LENGTH) errors.prompt = 'too_long';
  return errors;
}

export function normalizeGroupInput(input: CreateGroupInput): CreateGroupInput {
  return { name: input.name.trim(), prompt: input.prompt.trim() };
}

export function groupInputErrorMessage(field: 'name' | 'prompt', reason: GroupCreateFailureReason) {
  if (field === 'name') {
    return reason === 'too_long'
      ? `Group name must be ${GROUP_NAME_MAX_LENGTH} characters or fewer.`
      : 'Enter a group name.';
  }
  return reason === 'too_long'
    ? `Prompt must be ${PROMPT_MAX_LENGTH} characters or fewer.`
    : 'Choose a prompt or write a short custom prompt.';
}
