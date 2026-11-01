import { Platform } from 'react-native';

import {
  parseReminderIntent,
  reminderIntentFromUrl,
  subscribeToReminderIntents,
} from '../src/reminders/reminder-intents';

const mockConstants: {
  executionEnvironment?: string;
  expoGoConfig?: unknown;
  easConfig?: { projectId?: string };
  expoConfig?: { extra?: { eas?: { projectId?: string } } };
} = {};
jest.mock('expo-constants', () => ({
  __esModule: true,
  get default() {
    return mockConstants;
  },
}));

type Listener = (event: Partial<MessageEvent>) => void;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const globals = globalThis as unknown as Record<string, unknown>;
const saved = { window: globals.window, navigator: globals.navigator };

function stubWeb(href: string, withServiceWorker = true) {
  const replaceState = jest.fn();
  const controller = { id: 'controller' };
  let listener: Listener | null = null;
  const serviceWorker = {
    controller: controller as unknown,
    addEventListener: jest.fn((_type: string, next: Listener) => {
      listener = next;
    }),
    removeEventListener: jest.fn(),
  };
  globals.window = { location: { href }, history: { state: { keep: 1 }, replaceState } };
  globals.navigator = withServiceWorker ? { serviceWorker } : {};
  return {
    replaceState,
    serviceWorker,
    controller,
    post: (data: unknown, source: unknown = serviceWorker.controller) =>
      listener?.({ data, source } as Partial<MessageEvent>),
  };
}

const tap = (groupId: string, reminderId: string) => ({
  kind: 'weekly-reminder',
  groupId,
  reminderId,
});

beforeEach(() => {
  for (const key of Object.keys(mockConstants))
    delete (mockConstants as Record<string, unknown>)[key];
});
afterEach(() => {
  globals.window = saved.window;
  globals.navigator = saved.navigator;
  jest.restoreAllMocks();
});

describe('parseReminderIntent', () => {
  it('rejects non-string and boundary-length identifiers', () => {
    expect(parseReminderIntent(tap('g'.repeat(128), 'r'))).toEqual({
      groupId: 'g'.repeat(128),
      reminderId: 'r',
    });
    expect(parseReminderIntent(tap('', 'r'))).toBeNull();
    expect(
      parseReminderIntent({ kind: 'weekly-reminder', groupId: 1, reminderId: 'r' }),
    ).toBeNull();
    expect(parseReminderIntent('weekly-reminder')).toBeNull();
    expect(parseReminderIntent(undefined)).toBeNull();
  });
});

describe('subscribeToReminderIntents on the web', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'web');
  });

  it('opens the group from a cold-start URL and strips the parameters from history', () => {
    const web = stubWeb(
      'https://rewind.invalid/home?keep=yes&rewindReminder=rem-1&rewindGroup=grp-1#top',
    );
    const handle = jest.fn();
    subscribeToReminderIntents(handle);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith({ groupId: 'grp-1', reminderId: 'rem-1' });
    expect(web.replaceState).toHaveBeenCalledWith(
      { keep: 1 },
      '',
      'https://rewind.invalid/home?keep=yes#top',
    );
  });

  it('leaves the URL alone when it carries no reminder', () => {
    const web = stubWeb('https://rewind.invalid/home?rewindReminder=only-one');
    const handle = jest.fn();
    subscribeToReminderIntents(handle);
    expect(handle).not.toHaveBeenCalled();
    expect(web.replaceState).not.toHaveBeenCalled();
  });

  it('delivers service worker taps from the controlling worker only', () => {
    const web = stubWeb('https://rewind.invalid/');
    const handle = jest.fn();
    subscribeToReminderIntents(handle);
    expect(web.serviceWorker.addEventListener).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );

    web.post(tap('grp-1', 'rem-1'), { id: 'someone-else' });
    expect(handle).not.toHaveBeenCalled();

    web.post(tap('grp-1', 'rem-1'));
    expect(handle).toHaveBeenCalledWith({ groupId: 'grp-1', reminderId: 'rem-1' });
  });

  it('ignores messages when no worker controls the page', () => {
    const web = stubWeb('https://rewind.invalid/');
    web.serviceWorker.controller = null;
    const handle = jest.fn();
    subscribeToReminderIntents(handle);
    web.post(tap('grp-1', 'rem-1'), null);
    expect(handle).not.toHaveBeenCalled();
  });

  it('ignores malformed worker messages', () => {
    const web = stubWeb('https://rewind.invalid/');
    const handle = jest.fn();
    subscribeToReminderIntents(handle);
    web.post({ kind: 'weekly-reminder', groupId: '../x', reminderId: 'r' });
    web.post(null);
    web.post('hello');
    expect(handle).not.toHaveBeenCalled();
  });

  it('opens a repeated reminder only once, including the cold-start tap', () => {
    const web = stubWeb('https://rewind.invalid/?rewindReminder=rem-1&rewindGroup=grp-1');
    const handle = jest.fn();
    subscribeToReminderIntents(handle);
    web.post(tap('grp-1', 'rem-1'));
    web.post(tap('grp-1', 'rem-2'));
    web.post(tap('grp-1', 'rem-2'));
    expect(handle.mock.calls.map(([intent]) => intent.reminderId)).toEqual(['rem-1', 'rem-2']);
  });

  it('remembers only the most recent 64 reminders', () => {
    const web = stubWeb('https://rewind.invalid/');
    const handle = jest.fn();
    subscribeToReminderIntents(handle);
    for (let i = 0; i < 65; i += 1) web.post(tap('grp-1', `rem-${i}`));
    expect(handle).toHaveBeenCalledTimes(65);
    // The oldest was evicted, so it opens again; a recent one is still remembered.
    web.post(tap('grp-1', 'rem-0'));
    web.post(tap('grp-1', 'rem-64'));
    expect(handle).toHaveBeenCalledTimes(66);
    expect(handle).toHaveBeenLastCalledWith({ groupId: 'grp-1', reminderId: 'rem-0' });
  });

  it('stops delivering after unsubscribe and removes the worker listener', () => {
    const web = stubWeb('https://rewind.invalid/');
    const handle = jest.fn();
    const unsubscribe = subscribeToReminderIntents(handle);
    unsubscribe();
    expect(web.serviceWorker.removeEventListener).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );
    web.post(tap('grp-1', 'rem-1'));
    expect(handle).not.toHaveBeenCalled();
  });

  it('still honours the cold-start URL when service workers are unsupported', () => {
    const web = stubWeb('https://rewind.invalid/?rewindReminder=rem-1&rewindGroup=grp-1', false);
    const handle = jest.fn();
    const unsubscribe = subscribeToReminderIntents(handle);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(web.replaceState).toHaveBeenCalledTimes(1);
    expect(() => unsubscribe()).not.toThrow();
  });
});

// The native branch loads expo-notifications with a dynamic import(), which Jest
// cannot run without --experimental-vm-modules, so the listener wiring itself is
// not reachable here. What matters to the caller is that a failed load is
// harmless: no throw, no phantom intent, and unsubscribe still works.
describe('subscribeToReminderIntents on native when notifications cannot load', () => {
  beforeEach(() => {
    mockConstants.executionEnvironment = 'standalone';
    mockConstants.easConfig = { projectId: 'project-1' };
  });

  it.each(['ios', 'android'] as const)('is inert and safe to unsubscribe on %s', async (os) => {
    jest.replaceProperty(Platform, 'OS', os);
    const handle = jest.fn();
    const unsubscribe = subscribeToReminderIntents(handle);
    await flush();
    expect(() => unsubscribe()).not.toThrow();
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('reminderIntentFromUrl', () => {
  it('rejects an absent group, an empty reminder and encoded path traversal', () => {
    expect(
      reminderIntentFromUrl('https://rewind.invalid/?rewindReminder=&rewindGroup=g'),
    ).toBeNull();
    expect(
      reminderIntentFromUrl('https://rewind.invalid/?rewindReminder=r&rewindGroup=..%2Fg'),
    ).toBeNull();
  });
});

describe('subscribeToReminderIntents on unsupported platforms', () => {
  it('does nothing on a platform without notifications', () => {
    jest.replaceProperty(Platform, 'OS', 'windows');
    const handle = jest.fn();
    const unsubscribe = subscribeToReminderIntents(handle);
    expect(handle).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });
});
