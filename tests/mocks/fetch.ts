/** A minimal fetch Response whose json() resolves to `body`. */
export function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
