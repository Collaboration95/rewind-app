/**
 * Text that is safe to show a person. Our own error messages pass through;
 * browser network failures ("Failed to fetch", "Load failed"), aborted
 * requests and unparseable responses ("Unexpected token <") get the fallback.
 */
export function userMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  if (error instanceof TypeError || error instanceof SyntaxError) return fallback;
  if (error.name === 'AbortError') return fallback;
  return error.message;
}
