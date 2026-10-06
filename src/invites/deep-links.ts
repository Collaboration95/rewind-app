import {
  INVITE_LINK_HOST,
  INVITE_LINK_SCHEME,
  INVITE_LINK_WEB_PATH,
  isValidInviteCode,
  normalizeInviteCode,
} from '../domain/invites';

export interface InviteLinkPayload {
  code: string;
  expiresAt: string;
  /** Present for real-account invites; links without it carry no group. */
  groupId?: string;
}

export type InviteLinkParseResult =
  ({ kind: 'valid' } & InviteLinkPayload) | { kind: 'invalid'; reason: 'malformed' | 'expired' };

export interface CreateInviteLinkOptions {
  platform: 'native' | 'web';
  webOrigin?: string;
  /** Used only for real-account invitation links. */
  groupId?: string;
  now?: number;
}

function isValidExpiry(expiresAt: string, now: number): boolean {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

function queryForInvite(payload: InviteLinkPayload): string {
  const group = payload.groupId ? `groupId=${encodeURIComponent(payload.groupId)}&` : '';
  return `${group}code=${encodeURIComponent(payload.code)}&expiresAt=${encodeURIComponent(payload.expiresAt)}`;
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
  invite: { code: string; status: 'active' | 'used' | 'expired'; expiresAt: string },
  options: CreateInviteLinkOptions,
): string | null {
  const now = options.now ?? Date.now();
  const code = normalizeInviteCode(invite.code);
  const groupId = options.groupId;
  if (
    invite.status !== 'active' ||
    !isValidInviteCode(code) ||
    !isValidExpiry(invite.expiresAt, now) ||
    (groupId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(groupId))
  ) {
    return null;
  }

  const payload = {
    code,
    expiresAt: invite.expiresAt,
    ...(groupId ? { groupId } : {}),
  } satisfies InviteLinkPayload;
  if (groupId && options.platform === 'native') return null;
  if (options.platform === 'native') {
    return `${INVITE_LINK_SCHEME}://${INVITE_LINK_HOST}?${queryForInvite(payload)}`;
  }

  const origin = options.webOrigin ? normalizeWebOrigin(options.webOrigin) : null;
  if (!origin) return null;
  if (groupId && new URL(origin).protocol !== 'https:') return null;
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
  const groupIds = url.searchParams.getAll('groupId');
  if (codes.length !== 1 || expiries.length !== 1 || groupIds.length > 1) {
    return { kind: 'invalid', reason: 'malformed' };
  }

  const code = normalizeInviteCode(codes[0]);
  const expiresAt = expiries[0];
  const groupId = groupIds[0];
  if (
    !isValidInviteCode(code) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    (groupId !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(groupId) || url.protocol !== 'https:'))
  ) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  if (!isValidExpiry(expiresAt, now)) return { kind: 'invalid', reason: 'expired' };

  return { kind: 'valid', code, expiresAt, ...(groupId ? { groupId } : {}) };
}

export function inviteLinkErrorMessage(reason: 'malformed' | 'expired'): string {
  return reason === 'expired'
    ? 'This invitation link has expired. Ask the owner for a new link or enter an invite code.'
    : 'This invitation link is invalid. Ask the owner for a new link or enter an invite code.';
}
