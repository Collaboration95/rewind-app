import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { AccountDeletionOutcome } from '../auth/RealAccountProvider';
import { BUILT_IN_PROMPTS, PROMPT_MAX_LENGTH } from '../domain/groups';
import type {
  PrivateReminderClient,
  PrivateReminderSnapshot,
} from '../reminders/private-reminder-client';
import { Icon } from '../ui/Icon';
import {
  Avatar,
  Button,
  Dialog,
  ErrorText,
  Field,
  Foot,
  Glass,
  Glow,
  Lead,
  ListGroup,
  ListHint,
  ListRow,
  ScreenScroll,
  SectionLabel,
  SubHeader,
  Switch,
  TextLink,
  useNow,
  useToast,
} from '../ui/primitives';
import { FONT, WARM, memberColor, serif } from '../ui/tokens';
import { plural } from './home-model';
import { ReportSheet } from './ReportSheet';
import { blockMember, openLegalPage, reportContent, unblockMember } from './safety';
import type { MenuGroup } from './Shell';
import { userMessage } from '../domain/user-message';
import { CURRENT_VERSION, DISPLAY_CURRENT_VERSION } from '../runtime/version';

export type SettingsStep = 'main' | 'members' | 'groups' | 'invite' | 'prompt' | 'tz' | 'delete';

export interface SettingsGroup {
  memberId?: string;
  group: {
    id: string;
    name: string;
    role: 'owner' | 'member';
    maxMembers: number;
    timeZone?: string;
  };
  cycle: { prompt: string };
}

export interface SettingsMember {
  memberId: string;
  displayName: string;
  role: 'owner' | 'member';
}

export interface InviteControls {
  code: string | null;
  pending: boolean;
  feedback: string | null;
  create: () => void;
  revoke: () => void;
  copy: () => void;
  share: () => void;
}

type Request = (path: string, init?: RequestInit) => Promise<Response>;

interface Preference {
  enabled: boolean;
  snoozedUntil: string | null;
  timeZone: string;
  delivery?: { state: string; message: string };
}

/* ---------- Owner settings and the member's reminder preference ---------- */

function settingsError(response: Response, body: { error?: string } | null) {
  return response.status === 403
    ? 'Only the group owner can change the prompt and timezone.'
    : response.status === 401
      ? 'Sign in again to save these settings.'
      : body?.error === 'cycle_closed'
        ? 'This cycle has closed. Reload your group before editing.'
        : 'Check the prompt and IANA timezone, then retry.';
}

async function saveGroupSettings<T extends SettingsGroup>(
  request: Request,
  group: T,
  next: { prompt: string; timeZone: string },
): Promise<T> {
  const response = await request(`/real/groups/${encodeURIComponent(group.group.id)}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(settingsError(response, body));
  }
  const result = (await response.json()) as { group?: T };
  if (!result.group) throw new Error('Settings could not be saved. Retry when connected.');
  return result.group;
}

/* ---------- Settings ---------- */

export function SettingsScreen<T extends SettingsGroup>(props: {
  step: SettingsStep;
  onNavigate: (step: SettingsStep) => void;
  onBack: () => void;
  account: { displayName: string; username: string; id: string };
  group: T | null;
  groups: MenuGroup[];
  members: SettingsMember[] | null;
  membersError: string | null;
  /** Codes made but not used yet; null while unknown. */
  pendingInvites: number | null;
  authenticatedRequest: Request;
  onGroupUpdated: (group: T) => void;
  reminderClient: PrivateReminderClient | null;
  invite: InviteControls;
  onSwitchGroup: (groupId: string) => Promise<boolean>;
  switchPending: boolean;
  onJoin: () => void;
  onCreate: () => void;
  signOut: { label: string; pending: boolean; onSignOut: () => void };
  notice?: string | null;
  /** Password for a password session; the typed word DELETE for a Cognito session. */
  onDeleteAccount: (credential: string) => Promise<AccountDeletionOutcome>;
  /** How this account signed in; absent means a password. */
  signInMethod?: 'cognito' | 'password';
  blocked: Set<string>;
  onBlockedChange: (profileId: string, blocked: boolean) => void;
}) {
  const { step, onBack, group } = props;
  const back = step === 'main' ? onBack : () => props.onNavigate('main');
  return (
    <View style={styles.screen} testID={`real-settings-${step}`}>
      <Glow />
      {step === 'main' ? <SettingsMain {...props} onBack={back} /> : null}
      {step === 'members' && group ? <Members {...props} group={group} onBack={back} /> : null}
      {step === 'groups' ? <SwitchGroup {...props} onBack={back} /> : null}
      {step === 'invite' && group ? <Invite {...props} group={group} onBack={back} /> : null}
      {step === 'prompt' && group ? <PromptScreen {...props} group={group} onBack={back} /> : null}
      {step === 'tz' && group ? <TimeZoneScreen {...props} group={group} onBack={back} /> : null}
      {step === 'delete' ? <DeleteAccount {...props} onBack={back} /> : null}
    </View>
  );
}

type Props<T extends SettingsGroup> = Parameters<typeof SettingsScreen<T>>[0];

function SettingsMain<T extends SettingsGroup>({
  onBack,
  onNavigate,
  account,
  group,
  groups,
  members,
  invite: _invite,
  onJoin,
  onCreate,
  signOut,
  notice,
  authenticatedRequest,
  reminderClient,
}: Props<T>) {
  const [signOutOpen, setSignOutOpen] = useState(false);
  const owner = group?.group.role === 'owner';
  const count = members?.length ?? null;
  const limit = group?.group.maxMembers ?? 10;
  const full = count !== null && count >= limit;
  const zone = group?.group.timeZone ?? 'UTC';
  return (
    <>
      <ScreenScroll>
        <SubHeader
          backLabel="Back"
          backTestID="real-settings-back"
          onBack={onBack}
          title="Settings"
        />
        {notice ? (
          <Text
            accessibilityRole="alert"
            style={styles.notice}
            testID="settings-logout-unconfirmed"
          >
            {notice}
          </Text>
        ) : null}
        <Glass style={styles.me}>
          <Avatar color={memberColor(account.id)} name={account.displayName} size={56} />
          <View style={styles.meText}>
            <Text style={styles.meName}>{account.displayName}</Text>
            <Text style={styles.meHandle}>{account.username}</Text>
          </View>
        </Glass>
        {group ? (
          <>
            <SectionLabel>Group</SectionLabel>
            <ListGroup>
              <View style={styles.groupRow}>
                <View style={styles.groupText}>
                  <Text style={styles.groupName}>{group.group.name}</Text>
                  <Text style={styles.groupNote} testID="real-settings-group-summary">
                    {owner ? 'Owner' : 'Member'} · {count === null ? '…' : count} of {limit} members
                  </Text>
                </View>
                <View accessibilityElementsHidden style={styles.stack}>
                  {(members ?? []).slice(0, 6).map((member, index) => (
                    <Avatar
                      color={memberColor(member.memberId)}
                      key={member.memberId}
                      name={member.displayName}
                      size={26}
                      style={[styles.stackAvatar, index === 0 && { marginLeft: 0 }]}
                    />
                  ))}
                </View>
              </View>
              {owner ? (
                <>
                  <ListRow
                    chevron
                    icon="quote"
                    label="Prompt"
                    note={group.cycle.prompt}
                    onPress={() => onNavigate('prompt')}
                    testID="real-settings-prompt"
                  />
                  <ListRow
                    chevron
                    icon="clock"
                    label="Time zone"
                    note={zone}
                    onPress={() => onNavigate('tz')}
                    testID="real-settings-tz"
                  />
                  {full ? (
                    <ListRow
                      icon="users"
                      label="Invite friends"
                      note={`The group is full · ${count} of ${limit}`}
                      off
                      testID="real-settings-invite"
                    />
                  ) : (
                    <ListRow
                      chevron
                      icon="users"
                      label="Invite friends"
                      onPress={() => onNavigate('invite')}
                      testID="real-settings-invite"
                    />
                  )}
                </>
              ) : (
                <>
                  <ListRow icon="quote" label="Prompt" note={group.cycle.prompt} off />
                  <ListRow icon="clock" label="Time zone" note={zone} off />
                  <ListHint>
                    Only the owner can change the prompt, the time zone or invite friends.
                  </ListHint>
                </>
              )}
            </ListGroup>
            <ListGroup style={styles.more}>
              <ListRow
                chevron
                first
                icon="users"
                label="Members"
                note={count === null ? null : `${count} of ${limit}`}
                onPress={() => onNavigate('members')}
                testID="real-settings-members"
              />
              <ListRow
                chevron
                icon="users"
                label="Switch group"
                note={plural(groups.length, 'group')}
                onPress={() => onNavigate('groups')}
                testID="real-settings-groups"
              />
              <ListRow
                chevron
                icon="key"
                label="Have an invite?"
                onPress={onJoin}
                testID="real-settings-join"
              />
              <ListRow
                chevron
                icon="plus"
                label="Create a group"
                onPress={onCreate}
                testID="real-settings-create"
              />
            </ListGroup>
            <SectionLabel>Reminder</SectionLabel>
            <ReminderBlock
              group={group}
              key={group.group.id}
              reminderClient={reminderClient}
              request={authenticatedRequest}
            />
          </>
        ) : (
          <>
            <SectionLabel>Group</SectionLabel>
            <ListGroup>
              <ListHint first>You’re not in a group yet.</ListHint>
              <ListRow
                chevron
                icon="key"
                label="Have an invite?"
                onPress={onJoin}
                testID="real-settings-join"
              />
              <ListRow
                chevron
                icon="plus"
                label="Create a group"
                onPress={onCreate}
                testID="real-settings-create"
              />
            </ListGroup>
          </>
        )}
        <SectionLabel>Help and privacy</SectionLabel>
        <ListGroup>
          <ListRow
            first
            icon="chat"
            label="Help and support"
            onPress={() => openLegalPage('/support')}
            testID="real-settings-help"
          />
          <ListRow
            icon="lock"
            label="Privacy Policy"
            onPress={() => openLegalPage('/privacy')}
            testID="real-settings-privacy"
          />
          <ListRow
            icon="quote"
            label="Terms of use"
            onPress={() => openLegalPage('/terms')}
            testID="real-settings-terms"
          />
        </ListGroup>
        <SectionLabel>Account</SectionLabel>
        <ListGroup>
          <ListRow
            danger
            disabled={signOut.pending}
            first
            icon="out"
            label={signOut.label}
            onPress={() => setSignOutOpen(true)}
            testID="real-group-sign-out"
          />
          <ListRow
            danger
            icon="trash"
            label="Delete account"
            onPress={() => onNavigate('delete')}
            testID="real-settings-delete"
          />
        </ListGroup>
        <Foot>
          Rewind · signed in as {account.username}
          {DISPLAY_CURRENT_VERSION ? ` · ${CURRENT_VERSION}` : ''}
        </Foot>
      </ScreenScroll>
      {signOutOpen ? (
        <Dialog
          body="Your sealed moments stay with the group. A moment still uploading on this phone stops until you sign in again."
          label="Sign out confirmation"
          onDismiss={() => setSignOutOpen(false)}
          testID="real-sign-out-dialog"
          title="Sign out?"
        >
          <Button label="Stay signed in" onPress={() => setSignOutOpen(false)} />
          <Button
            busy={signOut.pending}
            busyLabel="Signing out…"
            label="Sign out"
            onPress={() => {
              setSignOutOpen(false);
              signOut.onSignOut();
            }}
            testID="real-group-sign-out-confirm"
            variant="danger"
          />
        </Dialog>
      ) : null}
    </>
  );
}

/* ---------- Reminder (S1 rows, S10, S11) ---------- */

const isIphoneSafari = () => {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches);
  return /iPhone|iPod/.test(navigator.userAgent) && !standalone;
};

function ReminderBlock({
  group,
  request,
  reminderClient,
}: {
  group: SettingsGroup;
  request: Request;
  reminderClient: PrivateReminderClient | null;
}) {
  const toast = useToast();
  const [preference, setPreference] = useState<Preference | null>(null);
  const [device, setDevice] = useState<PrivateReminderSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'notify' | 'install' | null>(null);
  const active = useRef(true);
  const now = useNow();
  const path = `/real/groups/${encodeURIComponent(group.group.id)}/reminders`;

  useEffect(() => {
    active.current = true;
    void request(path)
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const body = (await response.json()) as { preference: Preference };
        if (active.current) setPreference(body.preference);
      })
      .catch(() => {
        if (active.current)
          setMessage('Reminder preferences could not be loaded. Retry when connected.');
      });
    return () => {
      active.current = false;
    };
  }, [path, request]);

  useEffect(() => {
    if (!reminderClient) return;
    let current = true;
    void reminderClient.load().then((snapshot) => {
      if (current) setDevice(snapshot);
    });
    return () => {
      current = false;
    };
  }, [reminderClient]);

  const save = useCallback(
    async (enabled: boolean, snoozedUntil: string | null, done: string) => {
      setPending(true);
      setMessage(null);
      try {
        const response = await request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, snoozedUntil }),
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? 'Sign in again to save these settings.'
              : 'Your reminder could not be saved. Retry when connected.',
          );
        const body = (await response.json()) as { preference?: Preference };
        if (!active.current) return false;
        if (body.preference) setPreference(body.preference);
        toast(done);
        return true;
      } catch (error) {
        if (active.current) setMessage(userMessage(error, 'Your reminder could not be saved.'));
        return false;
      } finally {
        if (active.current) setPending(false);
      }
    },
    [path, request, toast],
  );

  const turnOn = async () => {
    if (reminderClient && device?.canEnable) {
      setDialog('notify');
      return;
    }
    // This device can't take push (no support or not installed); the row says why.
    const saved = await save(true, null, 'Sunday 7 PM reminders are on.');
    // iPhone Safari only gets push from the Home Screen app: show how, now.
    if (saved && isIphoneSafari() && active.current) setDialog('install');
  };
  const allow = async () => {
    setDialog(null);
    if (reminderClient) {
      setPending(true);
      const snapshot = await reminderClient.enable().catch(() => null);
      if (!active.current) return;
      setPending(false);
      if (snapshot) setDevice(snapshot);
      if (snapshot?.state === 'denied') {
        toast('Notifications are off in your browser settings');
        return;
      }
    }
    await save(true, null, 'Sunday 7 PM reminders are on for this device.');
  };
  const turnOff = async () => {
    const saved = await save(false, null, 'Sunday 7 PM reminders are off.');
    if (saved && reminderClient && device?.canDisable) {
      const snapshot = await reminderClient.disable().catch(() => null);
      if (snapshot && active.current) setDevice(snapshot);
    }
  };

  const on = Boolean(preference?.enabled);
  const snoozed = Boolean(preference?.snoozedUntil && Date.parse(preference.snoozedUntil) > now);
  // The device's own state (registered, denied, unsupported) beats the schedule.
  const deliveryNote = on && device && device.state !== 'available' ? device.message : null;
  const note = !preference
    ? 'Loading…'
    : !on
      ? 'Off'
      : snoozed
        ? 'Snoozed for 7 days'
        : (deliveryNote ?? 'Sundays at 7 PM, group time');
  return (
    <>
      <ListGroup testID="real-group-settings">
        <ListRow
          first
          icon="bell"
          label="Weekly reminder"
          note={note}
          testID="real-group-reminder-schedule"
          trailing={
            <Switch
              disabled={!preference || pending}
              label="Weekly reminder"
              onValueChange={(next) => void (next ? turnOn() : turnOff())}
              testID="real-group-reminder-toggle"
              value={on}
            />
          }
        />
        {on ? (
          <ListRow
            accessibilityState={{ selected: snoozed }}
            disabled={pending}
            icon="snooze"
            label={snoozed ? 'End snooze' : 'Snooze for 7 days'}
            onPress={() =>
              void (snoozed
                ? save(true, null, 'Reminder is back on for this Sunday.')
                : save(
                    true,
                    new Date(Date.now() + 7 * 86_400_000).toISOString(),
                    'Snoozed until next Sunday.',
                  ))
            }
            testID="real-group-reminder-snooze"
          />
        ) : null}
      </ListGroup>
      {message ? <ErrorText>{message}</ErrorText> : null}
      {dialog === 'notify' ? (
        <Dialog
          body="One notification a week, Sundays at 7 PM in your group’s time zone. Your phone asks next."
          label="Allow notifications"
          testID="real-notify-dialog"
          title="Get the Sunday reminder?"
        >
          <Button
            label="Continue"
            onPress={() => void allow()}
            testID="real-notify-continue"
            variant="primary"
          />
          {isIphoneSafari() ? (
            <TextLink
              label="On iPhone? Add Rewind to your Home Screen first"
              onPress={() => setDialog('install')}
              testID="real-notify-install"
            />
          ) : null}
        </Dialog>
      ) : null}
      {dialog === 'install' ? (
        <Dialog
          body="On iPhone, reminders only arrive in the Home Screen app."
          label="Add to Home Screen"
          onDismiss={() => setDialog(null)}
          title="Add Rewind to your Home Screen"
        >
          <View style={styles.steps}>
            <View style={styles.stepRow}>
              <Text style={styles.stepText}>1. Tap </Text>
              <Icon name="share" size={15} />
              <Text style={styles.stepText}> Share in Safari</Text>
            </View>
            <Text style={styles.stepText}>
              2. Choose <Text style={styles.bold}>Add to Home Screen</Text>
            </Text>
            <Text style={styles.stepText}>
              3. Open Rewind from your Home Screen and turn the reminder on
            </Text>
          </View>
          <Button label="Got it" onPress={() => setDialog(null)} variant="primary" />
        </Dialog>
      ) : null}
    </>
  );
}

/* ---------- S3 Prompt ---------- */

export function PromptPicker({
  value,
  custom,
  onChange,
  onCustomChange,
}: {
  /** One of the built-in prompts, or 'custom'. */
  value: string;
  custom: string;
  onChange: (value: string) => void;
  onCustomChange: (value: string) => void;
}) {
  const options = [...BUILT_IN_PROMPTS, 'custom'];
  return (
    <Glass accessibilityLabel="Prompt" role="radiogroup" style={styles.prompts}>
      {options.map((option, index) => {
        const selected = option === value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            key={option}
            onPress={() => onChange(option)}
            style={[styles.option, index > 0 && styles.optionRule]}
            testID={
              option === 'custom'
                ? 'real-group-custom-prompt-choice'
                : `real-prompt-option-${index}`
            }
          >
            <View style={[styles.radio, selected && styles.radioOn]}>
              {selected ? <View style={styles.radioDot} /> : null}
            </View>
            <Text style={styles.optionText}>
              {option === 'custom' ? 'Write a custom prompt' : option}
            </Text>
          </Pressable>
        );
      })}
      {value === 'custom' ? (
        <TextInput
          accessibilityLabel="Custom prompt"
          maxLength={PROMPT_MAX_LENGTH}
          multiline
          onChangeText={onCustomChange}
          placeholder="Write a short prompt"
          placeholderTextColor="rgba(51, 35, 26, 0.5)"
          style={styles.custom}
          testID="real-group-custom-prompt"
          value={custom}
        />
      ) : null}
    </Glass>
  );
}

const promptChoice = (prompt: string) =>
  (BUILT_IN_PROMPTS as readonly string[]).includes(prompt) ? prompt : 'custom';

function PromptScreen<T extends SettingsGroup>({
  group,
  onBack,
  authenticatedRequest,
  onGroupUpdated,
}: Props<T> & { group: T }) {
  const toast = useToast();
  const [choice, setChoice] = useState(promptChoice(group.cycle.prompt));
  const [custom, setCustom] = useState(
    promptChoice(group.cycle.prompt) === 'custom' ? group.cycle.prompt : '',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const prompt = (choice === 'custom' ? custom : choice).trim();
    if (!prompt) {
      setError('Write a prompt, or pick one above.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const updated = await saveGroupSettings(authenticatedRequest, group, {
        prompt,
        timeZone: group.group.timeZone ?? 'UTC',
      });
      onGroupUpdated(updated);
      toast('Saved.');
      onBack();
    } catch (failure) {
      setError(userMessage(failure, 'Settings could not be saved. Retry when connected.'));
      setPending(false);
    }
  };
  return (
    <ScreenScroll>
      <SubHeader onBack={onBack} title="Prompt" />
      <Lead>Everyone sees it on Home for this cycle.</Lead>
      <PromptPicker
        custom={custom}
        onChange={setChoice}
        onCustomChange={setCustom}
        value={choice}
      />
      <ErrorText>{error}</ErrorText>
      <Button
        busy={pending}
        busyLabel="Saving…"
        label="Save"
        onPress={() => void save()}
        testID="real-group-save-settings"
        variant="primary"
      />
    </ScreenScroll>
  );
}

/* ---------- S21 Time zone ---------- */

const ZONES = [
  'Asia/Singapore',
  'Asia/Kuala_Lumpur',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'UTC',
];

function deviceZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function TimeZoneScreen<T extends SettingsGroup>({
  group,
  onBack,
  authenticatedRequest,
  onGroupUpdated,
}: Props<T> & { group: T }) {
  const toast = useToast();
  const current = group.group.timeZone ?? 'UTC';
  const zones = [
    ...new Set([current, deviceZone(), ...ZONES].filter((zone): zone is string => Boolean(zone))),
  ];
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (timeZone: string) => {
    if (timeZone === current || pending) return;
    setPending(timeZone);
    setError(null);
    try {
      const updated = await saveGroupSettings(authenticatedRequest, group, {
        prompt: group.cycle.prompt,
        timeZone,
      });
      onGroupUpdated(updated);
      toast('Saved.');
    } catch (failure) {
      setError(userMessage(failure, 'Settings could not be saved. Retry when connected.'));
    } finally {
      setPending(null);
    }
  };
  return (
    <ScreenScroll>
      <SubHeader onBack={onBack} title="Time zone" />
      <Lead>The Sunday 7 PM reminder follows the group’s time zone.</Lead>
      <ListGroup accessibilityLabel="Time zone" testID="real-group-timezone">
        {zones.map((zone, index) => (
          <ListRow
            accessibilityRole="radio"
            accessibilityState={{ checked: zone === current }}
            disabled={Boolean(pending)}
            first={index === 0}
            icon="clock"
            key={zone}
            label={zone.replace(/_/g, ' ')}
            note={pending === zone ? 'Saving…' : zone === deviceZone() ? 'This device' : null}
            onPress={() => void pick(zone)}
            selected={zone === current}
            testID={`real-tz-${zone}`}
          />
        ))}
      </ListGroup>
      <ErrorText>{error}</ErrorText>
    </ScreenScroll>
  );
}

/* ---------- S4 Invite friends ---------- */

function Invite<T extends SettingsGroup>({
  group,
  onBack,
  invite,
  members,
}: Props<T> & { group: T }) {
  const requested = useRef(false);
  useEffect(() => {
    // Opening Invite makes a code straight away, as the design shows one.
    if (!invite.code && !invite.pending && !requested.current) {
      requested.current = true;
      invite.create();
    }
  }, [invite]);
  return (
    <ScreenScroll>
      <SubHeader onBack={onBack} title="Invite friends" />
      <Glass style={styles.inviteCard} testID="real-group-invitations">
        <Text style={styles.cardKey}>Invite code</Text>
        {invite.code ? (
          <Text
            accessibilityLabel={`Invite code ${invite.code.split('').join(' ')}`}
            selectable
            style={styles.code}
            testID="real-group-invite-code"
          >
            {invite.code}
          </Text>
        ) : (
          <Text style={styles.codeWaiting}>{invite.pending ? 'Making a code…' : '— — —'}</Text>
        )}
        {invite.code ? (
          <Text style={styles.note} testID="real-group-invite-expiry">
            Works once · expires in 24 hours
          </Text>
        ) : null}
      </Glass>
      {invite.code ? (
        <>
          <View style={styles.two}>
            <Button
              icon="share"
              label="Share code"
              onPress={invite.share}
              style={styles.half}
              testID="real-group-share-invite"
              variant="primary"
            />
            <Button
              icon="copy"
              label="Copy code"
              onPress={invite.copy}
              style={styles.half}
              testID="real-group-copy-invite"
            />
          </View>
          <TextLink
            label={invite.pending ? 'Revoking…' : 'Revoke this code'}
            onPress={invite.revoke}
            style={styles.revoke}
            testID="real-group-revoke-invite"
          />
        </>
      ) : (
        <Button
          busy={invite.pending}
          busyLabel="Creating invitation…"
          label="Create invitation code"
          onPress={invite.create}
          testID="real-group-create-invite"
          variant="primary"
        />
      )}
      {invite.feedback ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.feedback}
          testID="real-invite-feedback"
        >
          {invite.feedback}
        </Text>
      ) : null}
      <Foot>
        {members ? members.length : '…'} of {group.group.maxMembers} members in {group.group.name}
      </Foot>
    </ScreenScroll>
  );
}

/* ---------- S7 Switch group ---------- */

function SwitchGroup<T extends SettingsGroup>({
  onBack,
  groups,
  group,
  onSwitchGroup,
  switchPending,
  onJoin,
  onCreate,
}: Props<T>) {
  const toast = useToast();
  return (
    <ScreenScroll>
      <SubHeader onBack={onBack} title="Switch group" />
      <ListGroup>
        {groups.map((item, index) => {
          const current = item.id === group?.group.id;
          return (
            <ListRow
              accessibilityState={{ selected: current }}
              disabled={switchPending}
              first={index === 0}
              icon="users"
              key={item.id}
              label={item.name}
              note={current ? 'Current group' : 'Tap to switch'}
              onPress={async () => {
                if (current) return;
                if (await onSwitchGroup(item.id)) {
                  toast(`Switched to ${item.name}.`);
                  onBack();
                }
              }}
              selected={current}
              testID={`real-settings-switch-${item.id}`}
            />
          );
        })}
      </ListGroup>
      <ListGroup style={styles.more}>
        <ListRow chevron first icon="key" label="Have an invite?" onPress={onJoin} />
        <ListRow chevron icon="plus" label="Create a group" onPress={onCreate} />
      </ListGroup>
    </ScreenScroll>
  );
}

/* ---------- S15–S17 Members, a member, report ---------- */

function Members<T extends SettingsGroup>({
  group,
  onBack,
  members,
  membersError,
  pendingInvites,
  blocked,
  onBlockedChange,
  authenticatedRequest,
}: Props<T> & { group: T }) {
  const toast = useToast();
  const [person, setPerson] = useState<SettingsMember | null>(null);
  const [reporting, setReporting] = useState<SettingsMember | null>(null);
  const [pending, setPending] = useState(false);
  const toggleBlock = async (member: SettingsMember) => {
    const isBlocked = blocked.has(member.memberId);
    setPending(true);
    try {
      if (isBlocked) await unblockMember(authenticatedRequest, member.memberId);
      else await blockMember(authenticatedRequest, member.memberId);
      onBlockedChange(member.memberId, !isBlocked);
      setPerson(null);
      toast(
        isBlocked
          ? 'Unblocked.'
          : `${member.displayName} is blocked. You won’t see their messages or moments.`,
      );
    } catch (error) {
      toast(userMessage(error, 'Try again.'));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <ScreenScroll>
        <SubHeader onBack={onBack} title="Members" />
        {members === null ? (
          <Lead testID="real-group-members-empty">{membersError ?? 'Loading group members…'}</Lead>
        ) : (
          <ListGroup testID="real-group-members">
            {members.map((member, index) => {
              const you = Boolean(group.memberId) && member.memberId === group.memberId;
              const role = member.role === 'owner' ? 'Owner' : 'Member';
              return (
                <ListRow
                  accessibilityLabel={`${member.displayName}, ${member.role}`}
                  chevron={!you}
                  first={index === 0}
                  key={member.memberId}
                  label={you ? `${member.displayName} (you)` : member.displayName}
                  leading={
                    <Avatar
                      color={memberColor(member.memberId)}
                      name={member.displayName}
                      size={32}
                    />
                  }
                  note={`${role}${blocked.has(member.memberId) ? ' · blocked' : ''}`}
                  onPress={you ? undefined : () => setPerson(member)}
                  testID={`real-group-member-${index}`}
                />
              );
            })}
          </ListGroup>
        )}
        <Text style={styles.pending} testID="real-group-pending-invites">
          {pendingInvites
            ? `${pendingInvites} pending ${pendingInvites === 1 ? 'invitation' : 'invitations'}`
            : members
              ? 'No pending invitations'
              : membersError
                ? 'Invitation status unavailable.'
                : 'Loading invitation status…'}
        </Text>
        <Foot>Blocking hides someone’s messages and moments from you. They aren’t told.</Foot>
      </ScreenScroll>
      {person ? (
        <Dialog
          label={person.displayName}
          onDismiss={() => setPerson(null)}
          testID="real-person-dialog"
        >
          <View style={[styles.personIcon, { backgroundColor: memberColor(person.memberId) }]}>
            <Text style={styles.personInitial}>{person.displayName[0]?.toUpperCase()}</Text>
          </View>
          <Text accessibilityRole="header" style={styles.personName}>
            {person.displayName}
          </Text>
          <Button
            label="Report"
            onPress={() => {
              setReporting(person);
              setPerson(null);
            }}
            testID="real-person-report"
          />
          <Button
            busy={pending}
            busyLabel={blocked.has(person.memberId) ? 'Unblocking…' : 'Blocking…'}
            label={blocked.has(person.memberId) ? 'Unblock' : 'Block'}
            onPress={() => void toggleBlock(person)}
            testID="real-person-block"
          />
          <Button label="Cancel" onPress={() => setPerson(null)} />
        </Dialog>
      ) : null}
      {reporting ? (
        <ReportSheet
          name={reporting.displayName}
          onCancel={() => setReporting(null)}
          onSend={async (reason, alsoBlock) => {
            try {
              await reportContent(
                authenticatedRequest,
                group.group.id,
                { memberId: reporting.memberId },
                reason,
              );
              if (alsoBlock && !blocked.has(reporting.memberId)) {
                await blockMember(authenticatedRequest, reporting.memberId);
                onBlockedChange(reporting.memberId, true);
              }
              setReporting(null);
              toast(
                alsoBlock
                  ? 'Reported and blocked. You won’t see their messages or moments.'
                  : 'Thanks. The Rewind team reviews reports within 24 hours.',
              );
              return null;
            } catch (error) {
              return userMessage(error, 'The report could not be sent. Try again.');
            }
          }}
          what="person"
        />
      ) : null}
    </>
  );
}

/* ---------- S19–S20 Delete account ---------- */

function DeleteAccount<T extends SettingsGroup>({
  onBack,
  onDeleteAccount,
  signInMethod,
}: Props<T>) {
  const typedConfirmation = signInMethod === 'cognito';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const remove = async () => {
    setPending(true);
    const outcome = await onDeleteAccount(password);
    if (!mounted.current) return;
    setPending(false);
    setConfirm(false);
    if (outcome === 'incorrect')
      setError(typedConfirmation ? 'Type DELETE exactly as shown.' : 'The password is incorrect.');
    else if (outcome === 'throttled') setError('Too many attempts. Try again later.');
    else if (outcome === 'unavailable')
      setError('Your account could not be deleted. Retry when connected.');
  };
  return (
    <>
      <ScreenScroll>
        <SubHeader onBack={onBack} title="Delete account" />
        <Glass style={styles.deleteCard}>
          <Text style={styles.deleteLead}>This deletes your account for good:</Text>
          <Text style={styles.bullet}>
            {typedConfirmation ? '• your profile and sign-in' : '• your username and password'}
          </Text>
          <Text style={styles.bullet}>• your chat messages</Text>
          <Text style={styles.bullet}>
            • your photos and videos (films already made stay with the group)
          </Text>
        </Glass>
        <Lead>
          Groups you own pass to the member who joined next. Saved copies on people’s phones stay
          theirs.
        </Lead>
        {typedConfirmation ? (
          <Field
            autoCapitalize="characters"
            autoCorrect={false}
            label="Type DELETE to confirm"
            onChangeText={(value) => {
              setPassword(value);
              setError(null);
            }}
            spellCheck={false}
            testID="real-delete-confirmation"
            value={password}
          />
        ) : (
          <Field
            autoCapitalize="none"
            autoComplete="current-password"
            label="Password"
            onChangeText={(value) => {
              setPassword(value);
              setError(null);
            }}
            secureTextEntry
            testID="real-delete-password"
            textContentType="password"
            value={password}
          />
        )}
        <ErrorText testID="real-delete-error">{error}</ErrorText>
        <Button
          disabled={typedConfirmation ? password !== 'DELETE' : !password}
          label="Delete account"
          onPress={() => setConfirm(true)}
          testID="real-delete-account"
          variant="danger"
        />
      </ScreenScroll>
      {confirm ? (
        <Dialog
          body="This can’t be undone. You’ll be signed out on every device."
          label="Delete account confirmation"
          onDismiss={pending ? undefined : () => setConfirm(false)}
          testID="real-delete-dialog"
          title="Delete your account?"
        >
          <Button disabled={pending} label="Keep my account" onPress={() => setConfirm(false)} />
          <Button
            busy={pending}
            busyLabel="Deleting…"
            label="Delete for good"
            onPress={() => void remove()}
            testID="real-delete-confirm"
            variant="danger"
          />
        </Dialog>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: WARM.bg, flex: 1, overflow: 'hidden' },
  notice: {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderColor: 'rgba(194, 69, 47, 0.35)',
    borderRadius: 14,
    borderWidth: 1,
    color: '#6b2a1a',
    fontFamily: FONT.body,
    fontSize: 13,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  me: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  meText: { flex: 1 },
  meName: { color: WARM.ink, lineHeight: 25, ...serif(22) },
  meHandle: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13 },
  groupRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  groupText: { flex: 1 },
  groupName: { color: WARM.ink, lineHeight: 22, ...serif(19) },
  groupNote: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13, marginTop: 3 },
  stack: { flexDirection: 'row' },
  stackAvatar: { borderColor: '#fbf5ee', marginLeft: -7 },
  more: { marginTop: 10 },
  steps: { gap: 8, marginBottom: 8 },
  stepRow: { alignItems: 'center', flexDirection: 'row' },
  stepText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 13.5, lineHeight: 19 },
  bold: { fontWeight: '600' },
  prompts: { borderRadius: 22, paddingVertical: 4 },
  option: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  optionRule: { borderTopColor: WARM.line, borderTopWidth: 1 },
  radio: {
    alignItems: 'center',
    borderColor: 'rgba(51, 35, 26, 0.45)',
    borderRadius: 9,
    borderWidth: 1.5,
    height: 18,
    justifyContent: 'center',
    marginTop: 1,
    width: 18,
  },
  radioOn: { borderColor: WARM.accent },
  radioDot: { backgroundColor: WARM.accent, borderRadius: 5, height: 10, width: 10 },
  optionText: { color: WARM.ink, flex: 1, fontFamily: FONT.body, fontSize: 14.5, lineHeight: 19.5 },
  custom: {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderRadius: 12,
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 14,
    height: 64,
    marginBottom: 12,
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  inviteCard: {
    alignItems: 'center',
    gap: 6,
    marginBottom: 18,
    paddingBottom: 20,
    paddingHorizontal: 18,
    paddingTop: 22,
  },
  cardKey: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11.5,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  code: {
    color: WARM.ink,
    fontFamily: FONT.monoMedium,
    fontSize: 34,
    letterSpacing: 2.7,
    lineHeight: 38,
  },
  codeWaiting: { color: WARM.muted, fontFamily: FONT.monoMedium, fontSize: 24, lineHeight: 38 },
  note: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13 },
  two: { flexDirection: 'row', gap: 10, marginTop: 10 },
  half: { flex: 1, width: undefined },
  revoke: { marginTop: 16 },
  feedback: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 13,
    marginTop: 12,
    textAlign: 'center',
  },
  personIcon: {
    alignItems: 'center',
    alignSelf: 'center',
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    marginBottom: 4,
    width: 56,
  },
  personInitial: { color: '#2a1a10', fontFamily: FONT.body, fontSize: 22, fontWeight: '600' },
  personName: { color: WARM.ink, textAlign: 'center', ...serif(22) },
  pending: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 13,
    marginTop: 10,
    textAlign: 'center',
  },
  deleteCard: { gap: 6, marginBottom: 18, paddingHorizontal: 18, paddingVertical: 20 },
  deleteLead: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  bullet: { color: WARM.ink, fontFamily: FONT.body, fontSize: 13.5, lineHeight: 21 },
});
