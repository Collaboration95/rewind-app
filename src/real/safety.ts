import { Linking, Platform } from 'react-native';

import { rateLimitMessage } from '../auth/real-account-client';
import { getConfiguredInviteWebOrigin } from '../runtime/config';

type Request = (path: string, init?: RequestInit) => Promise<Response>;

const json = (body: object): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export type ReportTarget =
  { messageId: string } | { contributionId: string } | { memberId: string };

/** Report a message, a moment or a person to the Rewind team (App Store 1.2). */
export async function reportContent(
  request: Request,
  groupId: string,
  target: ReportTarget,
  reason: string,
): Promise<void> {
  const response = await request(
    `/real/groups/${encodeURIComponent(groupId)}/reports`,
    json({ ...target, reason }),
  );
  if (!response.ok)
    throw new Error(await rateLimitMessage(response, 'The report could not be sent. Try again.'));
}

export async function blockMember(request: Request, profileId: string): Promise<void> {
  const response = await request('/real/blocks', json({ profileId }));
  if (!response.ok)
    throw new Error(
      await rateLimitMessage(response, 'That person could not be blocked. Try again.'),
    );
}

export async function unblockMember(request: Request, profileId: string): Promise<void> {
  const response = await request(`/real/blocks/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  });
  if (!response.ok)
    throw new Error(
      await rateLimitMessage(response, 'That person could not be unblocked. Try again.'),
    );
}

export async function listBlocked(request: Request): Promise<Set<string>> {
  const response = await request('/real/blocks');
  if (!response.ok) throw new Error('Blocked people could not be loaded.');
  const body = (await response.json()) as { blocked?: { profileId: string }[] };
  return new Set((body.blocked ?? []).map((entry) => entry.profileId));
}

/** Help and support, Privacy Policy and Terms of use: public pages on the web app (#430). */
export function openLegalPage(path: '/support' | '/privacy' | '/terms') {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(path, '_blank', 'noopener');
    return;
  }
  const origin = getConfiguredInviteWebOrigin();
  if (origin) void Linking.openURL(`${origin}${path}`).catch(() => undefined);
}
