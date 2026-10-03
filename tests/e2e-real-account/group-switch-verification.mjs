import { expect } from '@playwright/test';

export async function createGroupInvitation(page, groupId) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/api/real/groups/${encodeURIComponent(groupId)}/invites`,
  );
  await page.getByTestId('real-group-create-invite').click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const { invite } = await response.json();
  expect(invite.status).toBe('active');
  expect(invite.groupId).toBe(groupId);
  expect(Date.parse(invite.expiresAt)).toBeGreaterThan(Date.now());
  return invite;
}

export async function verifyForeignGroupDenied(page, groupId) {
  const results = await page.evaluate(async (id) => {
    const group = encodeURIComponent(id);
    const checks = [
      ['group', `/api/real/groups/${group}`, 'GET', undefined, 404],
      ['profiles', `/api/real/groups/${group}/members`, 'GET', undefined, 404],
      ['selection', '/api/real/groups/current', 'POST', { groupId: id }, 404],
      ['contributions', `/api/contributions?groupId=${group}`, 'GET', undefined, 403],
      ['chat history', `/api/realtime/groups/${group}/messages`, 'GET', undefined, 403],
      [
        'chat write',
        `/api/realtime/groups/${group}/messages`,
        'POST',
        { body: 'Foreign-group fixture write must be denied', messageId: crypto.randomUUID() },
        403,
      ],
    ];
    const results = [];
    for (const [label, path, method, body, expectedStatus] of checks) {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        ...(body
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      results.push({ label, status: response.status, expectedStatus, body: await response.json() });
    }
    return results;
  }, groupId);
  for (const result of results) {
    expect(result.status, result.label).toBe(result.expectedStatus);
    expect(result.body.error, result.label).toBe('forbidden');
    expect(result.body.group, result.label).toBeUndefined();
    expect(result.body.members, result.label).toBeUndefined();
    expect(result.body.events, result.label).toBeUndefined();
  }
}

export async function verifySelectedGroupContext(
  page,
  group,
  { owner, member, otherOwner, message, otherMessage },
) {
  await expect(page.getByTestId('real-group-home')).toBeVisible();
  await expect(page.getByTestId('real-group-name-heading')).toHaveText(group.name);
  const profiles = page.getByTestId('real-group-members');
  await expect(profiles.getByTestId(/^real-group-member-/)).toHaveCount(2);
  await expect(profiles.getByText(`${owner} · Owner`, { exact: true })).toBeVisible();
  await expect(profiles.getByText(`${member} · Member`, { exact: true })).toBeVisible();
  await expect(profiles.getByText(`${otherOwner} · Owner`, { exact: true })).toHaveCount(0);
  const current = await page.evaluate(async () => {
    const response = await fetch('/api/real/groups/current', { credentials: 'same-origin' });
    return { status: response.status, body: await response.json() };
  });
  expect(current.status).toBe(200);
  expect(current.body.group.group.id).toBe(group.id);
  expect(current.body.group.group.name).toBe(group.name);
  expect(current.body.group.group.role).toBe('member');

  await page.getByTestId('real-group-capture-action').click();
  await expect(page.getByTestId('camera-group-context')).toHaveText(`Group · ${group.name}`);
  // Inspect the real capability/permission state without requesting access.
  await expect(page.getByTestId(/^camera-(unsupported|permission-undecided)$/)).toBeVisible();
  await page.getByRole('button', { name: 'Back to group', exact: true }).click();
  await expect(page.getByTestId('real-group-name-heading')).toHaveText(group.name);

  await page.getByTestId('real-group-chat-action').click();
  await expect(page.getByTestId('real-chat-context')).toHaveText(`Group · ${group.name}`);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  const timeline = page.getByTestId('real-chat-timeline');
  await expect(timeline.getByText(message, { exact: true })).toHaveCount(1);
  await expect(timeline.getByText(otherMessage, { exact: true })).toHaveCount(0);
  await expect(timeline.getByText(owner, { exact: true }).first()).toBeVisible();
  await expect(timeline.getByText(otherOwner, { exact: true })).toHaveCount(0);
  await page.getByTestId('real-group-chat-back').click();
}

export async function switchGroupThroughUi(page, group) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/real/groups/current' &&
      response.request().postDataJSON()?.groupId === group.id,
  );
  await page.getByTestId(`switch-real-group-${group.id}`).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect((await response.json()).group.group.id).toBe(group.id);
  await expect(page.getByTestId('real-group-name-heading')).toHaveText(group.name);
}
