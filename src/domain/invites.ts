export const INVITE_CODE_LENGTH = 8;
export const INVITE_CODE_PATTERN = /^(?:[A-Z0-9]{8}|[A-Z]{6})$/;
export const INVITE_LINK_SCHEME = 'rewind';
export const INVITE_LINK_HOST = 'invite';
export const INVITE_LINK_WEB_PATH = '/invite';

/**
 * Invite codes are commonly copied with surrounding or grouping whitespace.
 * Normalize that presentation detail before applying the exact code contract.
 */
export function normalizeInviteCode(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

export function isValidInviteCode(value: string): boolean {
  return INVITE_CODE_PATTERN.test(normalizeInviteCode(value));
}
