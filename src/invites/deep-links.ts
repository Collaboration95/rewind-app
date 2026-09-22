import {
  INVITE_LINK_HOST,
  INVITE_LINK_SCHEME,
  INVITE_LINK_WEB_PATH,
  isValidInviteCode,
  normalizeInviteCode,
  type LocalInvite,
} from '../domain/invites';

export interface InviteLinkPayload {
  code: string;
  expiresAt: string;
}

export type InviteLinkParseResult =
  ({ kind: 'valid' } & InviteLinkPayload) | { kind: 'invalid'; reason: 'malformed' | 'expired' };

export interface CreateInviteLinkOptions {
  platform: 'native' | 'web';
  webOrigin?: string;
  now?: number;
}

function isValidExpiry(expiresAt: string, now: number): boolean {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

function queryForInvite(payload: InviteLinkPayload): string {
  return `code=${encodeURIComponent(payload.code)}&expiresAt=${encodeURIComponent(payload.expiresAt)}`;
}

function normalizeWebOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Creates a link with only the bounded invite code and its expiry. Group
 * identity, status, and member data are deliberately not serialized.
 */
export function createInviteLink(
  invite: Pick<LocalInvite, 'code' | 'status' | 'expiresAt'>,
  options: CreateInviteLinkOptions,
): string | null {
  const now = options.now ?? Date.now();
  const code = normalizeInviteCode(invite.code);
  if (
    invite.status !== 'active' ||
    !isValidInviteCode(code) ||
    !isValidExpiry(invite.expiresAt, now)
  ) {
    return null;
  }

  const payload = { code, expiresAt: invite.expiresAt } satisfies InviteLinkPayload;
  if (options.platform === 'native') {
    return `${INVITE_LINK_SCHEME}://${INVITE_LINK_HOST}?${queryForInvite(payload)}`;
  }

  const origin = options.webOrigin ? normalizeWebOrigin(options.webOrigin) : null;
  if (!origin) return null;
  return `${origin}${INVITE_LINK_WEB_PATH}?${queryForInvite(payload)}`;
}

function isSupportedInviteTarget(url: URL): boolean {
  if (url.protocol === `${INVITE_LINK_SCHEME}:`) {
    return url.hostname === INVITE_LINK_HOST && (url.pathname === '' || url.pathname === '/');
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return url.pathname === INVITE_LINK_WEB_PATH || url.pathname === `${INVITE_LINK_WEB_PATH}/`;
  }
  return false;
}

/** Returns true only for URLs that belong to the invite route. */
export function isInviteLinkCandidate(value: string): boolean {
  try {
    return isSupportedInviteTarget(new URL(value));
  } catch {
    return false;
  }
}

/**
 * Parses only the invite route and returns no payload for malformed or
 * expired links. In particular, a link can never disclose a destination
 * group before the runtime authorizes and accepts its code.
 */
export function parseInviteLink(value: string, now = Date.now()): InviteLinkParseResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'invalid', reason: 'malformed' };
  }

  if (!isSupportedInviteTarget(url)) return { kind: 'invalid', reason: 'malformed' };

  const codes = url.searchParams.getAll('code');
  const expiries = url.searchParams.getAll('expiresAt');
  if (codes.length !== 1 || expiries.length !== 1) {
    return { kind: 'invalid', reason: 'malformed' };
  }

  const code = normalizeInviteCode(codes[0]);
  const expiresAt = expiries[0];
  if (!isValidInviteCode(code) || !Number.isFinite(Date.parse(expiresAt))) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  if (!isValidExpiry(expiresAt, now)) return { kind: 'invalid', reason: 'expired' };

  return { kind: 'valid', code, expiresAt };
}

export function inviteLinkErrorMessage(reason: 'malformed' | 'expired'): string {
  return reason === 'expired'
    ? 'This invitation link has expired. Ask the owner for a new link or enter an invite code.'
    : 'This invitation link is invalid. Ask the owner for a new link or enter an invite code.';
}
