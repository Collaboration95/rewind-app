import { parseReminderIntent, reminderIntentFromUrl } from '../src/reminders/reminder-intents';

it('accepts only opaque reminder/group identifiers without consuming notification content or URLs', () => {
  expect(
    parseReminderIntent({
      kind: 'weekly-reminder',
      groupId: 'group-one',
      reminderId: 'reminder-one',
      body: 'secret',
      url: 'https://evil.invalid',
    }),
  ).toEqual({ groupId: 'group-one', reminderId: 'reminder-one' });
  for (const data of [
    null,
    [],
    {},
    { kind: 'weekly-reminder', groupId: '../foreign', reminderId: 'one' },
    { kind: 'weekly-reminder', groupId: 'group', reminderId: 'x'.repeat(129) },
    { kind: 'other', groupId: 'group', reminderId: 'one' },
  ])
    expect(parseReminderIntent(data)).toBeNull();
});

it('cold web entry rejects malformed, missing or duplicate notification parameters', () => {
  expect(
    reminderIntentFromUrl('https://rewind.invalid/?rewindReminder=one&rewindGroup=group'),
  ).toEqual({ groupId: 'group', reminderId: 'one' });
  for (const url of [
    'invalid',
    'https://rewind.invalid/?rewindReminder=one',
    'https://rewind.invalid/?rewindReminder=one&rewindGroup=group&rewindGroup=other',
    'https://rewind.invalid/?rewindReminder=one&rewindReminder=two&rewindGroup=group',
    'https://rewind.invalid/?rewindReminder=one&rewindGroup=%2Fforeign',
  ])
    expect(reminderIntentFromUrl(url)).toBeNull();
});
