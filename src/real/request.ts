/** The RequestInit for a JSON POST, the shape of every real-account mutation. */
export function postJson(body: object = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
