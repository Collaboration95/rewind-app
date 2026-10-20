import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { withBoundaryRuntime } from './boundary-runtime.mjs';

export const JSON_TYPE = 'application/json; charset=utf-8';
/** 43-character opaque credential that no session row matches. */
export const UNKNOWN_TOKEN = 'A'.repeat(43);

/**
 * Start one runtime for a whole test file and build the actors every route
 * contract needs: an owner with a group, a member of that group, and an
 * outsider who owns a different group (so a session is valid but never a member
 * of the owner's group). Stops with the file via `after`.
 */
export async function routeFixture({ env, options } = {}) {
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let ready;
  const started = new Promise((resolve) => (ready = resolve));
  const finished = withBoundaryRuntime(
    async (c) => {
      ready(c);
      await released;
    },
    { env, options },
  );
  finished.catch((error) => ready(Promise.reject(error)));
  const c = await started;
  after(async () => {
    release();
    await finished;
  });
  const owner = await c.account('rc-owner');
  const member = await c.account('rc-member');
  const outsider = await c.account('rc-outsider');
  const creator = await c.account('rc-creator');
  const created = await c.group(owner, { name: 'Route contract group' });
  const other = await c.group(outsider, { name: 'Outsider group' });
  await c.join(owner, member, created.group.id);
  const fx = {
    c,
    actors: { owner, member, outsider, creator },
    ids: { g: created.group.id, og: other.group.id, c: created.cycle.id },
  };
  return fx;
}

export function fill(fx, text) {
  return text.replace(/\{(g|og|c)\}/g, (_, key) => encodeURIComponent(fx.ids[key]));
}

function credentials(fx, actor) {
  if (actor === 'none') return {};
  if (actor === 'unknown') return { Authorization: `Bearer ${UNKNOWN_TOKEN}` };
  if (actor === 'garbage') return { Authorization: 'Bearer not-a-session' };
  const account = fx.actors[actor];
  assert.ok(account, `unknown actor ${actor}`);
  return account.headers;
}

/** Issue a request described by a case and return a small normalised result. */
export async function send(fx, spec) {
  const headers = { ...credentials(fx, spec.actor ?? 'none'), ...spec.headers };
  let body;
  if (spec.oversize) {
    body = JSON.stringify({ pad: 'x'.repeat(spec.oversize) });
  } else if (spec.raw !== undefined) {
    body = spec.raw;
  } else if (spec.body !== undefined) {
    body = fill(fx, JSON.stringify(spec.body));
  }
  if (body !== undefined) headers['Content-Type'] ??= 'application/json';
  const response = await fetch(fx.c.baseUrl + fill(fx, spec.path), {
    method: spec.method ?? 'GET',
    headers,
    redirect: 'manual',
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { response, status: response.status, text, json };
}

/** Assert one table row against the live server. */
export async function checkCase(fx, spec) {
  const { response, status, json, text } = await send(fx, spec);
  assert.equal(status, spec.status, `status (body ${text.slice(0, 200)})`);
  if (spec.error !== undefined) assert.equal(json?.error, spec.error, 'error code');
  if (spec.keys) assert.deepEqual(Object.keys(json ?? {}).sort(), [...spec.keys].sort(), 'keys');
  if (spec.noBody) return;
  if (spec.contentType !== null) {
    assert.equal(response.headers.get('content-type'), spec.contentType ?? JSON_TYPE);
  }
  if (spec.cacheControl !== null) {
    assert.equal(response.headers.get('cache-control'), spec.cacheControl ?? 'no-store');
  }
  assert.ok(response.headers.get('x-request-id'), 'x-request-id header');
}

/** Register one node:test per row so a refactor reports the exact route. */
export function defineCases(fx, cases) {
  for (const spec of cases) {
    const label = `${spec.method ?? 'GET'} ${spec.path} as ${spec.actor ?? 'none'}: ${spec.name ?? `${spec.status} ${spec.error ?? ''}`.trim()}`;
    test(label, () => checkCase(fx, spec));
  }
}
