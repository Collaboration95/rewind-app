/** Encode stable keyset cursor tuples without exposing SQL expressions. */
export function encodePageCursor(values: readonly string[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodePageCursor(value: string | null, tupleLength: number): string[] | null {
  if (!value || value.length > 512) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== tupleLength ||
      decoded.some((part) => typeof part !== 'string' || part.length > 128)
    )
      return null;
    return decoded;
  } catch {
    return null;
  }
}
