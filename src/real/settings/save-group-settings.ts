import { postJson } from '../request';
import type { Request, SettingsGroup } from './types';

function settingsError(response: Response, body: { error?: string } | null) {
  return response.status === 403
    ? 'Only the group owner can change the prompt and timezone.'
    : response.status === 401
      ? 'Sign in again to save these settings.'
      : body?.error === 'cycle_closed'
        ? 'This cycle has closed. Reload your group before editing.'
        : 'Check the prompt and IANA timezone, then retry.';
}

export async function saveGroupSettings<T extends SettingsGroup>(
  request: Request,
  group: T,
  next: { prompt: string; timeZone: string },
): Promise<T> {
  const response = await request(
    `/real/groups/${encodeURIComponent(group.group.id)}/settings`,
    postJson(next),
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(settingsError(response, body));
  }
  const result = (await response.json()) as { group?: T };
  if (!result.group) throw new Error('Settings could not be saved. Retry when connected.');
  return result.group;
}
