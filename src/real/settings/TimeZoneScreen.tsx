import { useState } from 'react';

import { userMessage } from '../../domain/user-message';
import {
  ErrorText,
  Lead,
  ListGroup,
  ListRow,
  ScreenScroll,
  SubHeader,
  useToast,
} from '../../ui/primitives';
import { saveGroupSettings } from './save-group-settings';
import type { SettingsGroup, SettingsScreenProps } from './types';

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

export function TimeZoneScreen<T extends SettingsGroup>({
  group,
  onBack,
  authenticatedRequest,
  onGroupUpdated,
}: SettingsScreenProps<T> & { group: T }) {
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
