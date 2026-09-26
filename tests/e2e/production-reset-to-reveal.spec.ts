import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';

const SAFE_DENIAL = {
  allowed: false,
  status: 403,
  error: 'forbidden',
  message: 'You do not have access to this resource.',
};
const CROSS_GROUP_BOOTSTRAP_GROUP_ID = 'production-e2e-bootstrap-group';

let stage = 'start';
const apiEvents: string[] = [];

function redact(value: string): string {
  return value
    .replace(/(?:demo-session|local-group|local-cycle|contribution|clip-job)-[a-f0-9-]+/gi, '<id>')
    .replace(
      /((?:sessionId|groupId|cycleId|jobId|contributionId|sourceUri|code)=)[^&\s)]+/gi,
      '$1<redacted>',
    )
    .replace(/\b[A-Z0-9]{8}\b/g, '<invite>')
    .replace(/(?:\/Users\/|\/private\/var\/|\/var\/folders\/|\/tmp\/)[^\s)]+/g, '<local-path>')
    .replace(/\b(?:https?:\/\/)?127\.0\.0\.1:\d+\b/g, '<local-url>');
}

async function writeRedactedFailure(testInfo: TestInfo, error: unknown): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const message = error instanceof Error ? error.message : String(error);
  await testInfo.attach('redacted-failure-summary.json', {
    body: JSON.stringify(
      {
        suite: 'production-reset-to-reveal',
        stage,
        status: testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        error: redact(message),
        mediaArtifacts: 'not captured',
        secrets: 'redacted',
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
}

async function expectJson<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  status: number,
): Promise<T> {
  expect(response.status()).toBe(status);
  return (await response.json()) as T;
}

async function waitForDemoSession(page: Page, action: () => Promise<void>): Promise<string> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/sessions/demo',
    { timeout: 15_000 },
  );
  await action();
  let response;
  try {
    response = await responsePromise;
  } catch (error) {
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => 'unavailable');
    throw new Error(
      `Demo access response was not observed. ${redact(error instanceof Error ? error.message : String(error))} API: ${apiEvents.slice(-8).join('; ') || 'none'} Page: ${redact(bodyText)}`,
    );
  }
  const body = await response.json();
  expect(body.session?.id).toEqual(expect.any(String));
  return body.session.id;
}

async function runtimeJson(page: Page, path: string) {
  const response = await page.request.get(path);
  expect(response.status()).toBe(200);
  return response.json();
}

async function expectSafeDenial(page: Page, path: string): Promise<void> {
  const response = await page.request.get(path);
  expect(response.status(), path).toBe(SAFE_DENIAL.status);
  expect(await response.json(), path).toEqual(SAFE_DENIAL);
}

test.afterEach(async ({ page }, testInfo) => {
  void page;
  await writeRedactedFailure(testInfo, testInfo.error);
});

test('redacts session and capability values from failure diagnostics', () => {
  const sensitive =
    'sessionId=session-secret groupId=group-secret contributionId=clip-secret sourceUri=/private/media.mp4 code=INVITE42';
  const safe = redact(sensitive);

  expect(safe).toBe(
    'sessionId=<redacted> groupId=<redacted> contributionId=<redacted> sourceUri=<redacted> code=<redacted>',
  );
  expect(safe).not.toContain('session-secret');
  expect(safe).not.toContain('INVITE42');
});

test('proves the disposable reset-to-reveal Demo journey through the production web boundary', async ({
  page,
}) => {
  test.setTimeout(120_000);
  stage = 'demo access';
  let ownerSessionId = '';
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) {
      apiEvents.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/'))
      apiEvents.push(`${request.method()} ${url.pathname} failed`);
  });
  // Expo's browser polyfill can expose an unbound fetch reference before the
  // exported app captures it. Bind the browser primitive at the production
  // boundary without changing application code or the runtime contract.
  await page.addInitScript(() => {
    window.fetch = window.fetch.bind(window);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose who you are showing' })).toBeVisible();
  await expect
    .poll(async () => page.evaluate(async () => (await fetch('/api/health')).ok))
    .toBe(true);
  ownerSessionId = await waitForDemoSession(page, async () => {
    await page.getByTestId('demo-entry-demo-1').click();
  });
  await expect(page.getByTestId('capsule-ready')).toBeVisible();
  await expect(page.getByTestId('settings-group')).toHaveCount(0);

  stage = 'group and invite';
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-group')).toContainText('Weekend People');
  await page.getByTestId('generate-invite').click();
  const inviteCode = await page
    .getByTestId('settings-invites')
    .locator('[aria-label^="Invite code "]')
    .getAttribute('aria-label');
  expect(inviteCode).toMatch(/^Invite code [A-Z0-9]{8}$/);
  const code = inviteCode?.slice('Invite code '.length) ?? '';

  await page.getByTestId('sign-out').click();
  await expect(page.getByRole('heading', { name: 'Choose who you are showing' })).toBeVisible();
  let guestSessionId = '';
  guestSessionId = await waitForDemoSession(page, async () => {
    await page.getByTestId('demo-entry-demo-2').click();
  });
  await expect(page.getByTestId('capsule-ready')).toBeVisible();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('invite-code-input').fill(code);
  await page.getByTestId('accept-invite').click();
  // The deterministic fixture may already include demo-2 in the seeded group.
  // In that case the invite is still created and safely rejected as duplicate
  // membership; the full successful invite-acceptance path is covered by the
  // server full-cycle proof.
  await expect(page.getByTestId('settings-invites')).toContainText(
    /Joined Weekend People\.|already in that group\./,
  );

  stage = 'labelled synthetic contribution';
  await page.getByTestId('nav-camera').click();
  await page.getByTestId('camera-record-clip').click();
  await expect(page.getByTestId('video-unsupported')).toBeVisible();
  const syntheticResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/demo/synthetic-clip',
  );
  await page.getByRole('button', { name: 'Create synthetic Demo clip' }).click();
  const syntheticResponse = await syntheticResponsePromise;
  expect(syntheticResponse.status()).toBe(201);
  const syntheticBody = await syntheticResponse.json();
  expect(syntheticBody.synthetic).toBe(true);
  expect(syntheticBody.upload?.contribution?.memberId).toBe('demo-2');
  const clipJobId = syntheticBody.upload?.job?.id;
  expect(clipJobId).toEqual(expect.any(String));
  await expect(page.getByText('Contribution sealed', { exact: true })).toBeVisible({
    timeout: 90_000,
  });

  stage = 'sealed before release';
  const guestGroup = await runtimeJson(
    page,
    `/api/groups/current?sessionId=${encodeURIComponent(guestSessionId)}`,
  );
  const groupId = guestGroup.group.id;
  const cycleId = guestGroup.group.currentCycleId;
  const lockedPremiere = await runtimeJson(
    page,
    `/api/cycles/${encodeURIComponent(cycleId)}/premiere?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(guestSessionId)}`,
  );
  expect(lockedPremiere.premiere).toEqual({ state: 'locked', cycleId });
  await page.getByTestId('nav-archive').click();
  await expect(page.getByTestId('archive-locked')).toBeVisible();
  await expect(page.getByTestId('archive-video-player')).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Download released group film/i })).toHaveCount(0);

  stage = 'owner advance and release';
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('sign-out').click();
  await expect(page.getByRole('heading', { name: 'Choose who you are showing' })).toBeVisible();
  ownerSessionId = await waitForDemoSession(page, async () => {
    await page.getByTestId('demo-entry-demo-1').click();
  });
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-local-reveal')).toBeVisible();
  const revealQuery = `sessionId=${encodeURIComponent(ownerSessionId)}&groupId=${encodeURIComponent(groupId)}`;
  const advanceResponse = await page.request.post(
    `/api/cycles/demo/advance?${revealQuery}&advanceSeconds=86400`,
  );
  expect(advanceResponse.status()).toBe(200);
  const compilingResponse = await page.request.post(`/api/demo/reveal?${revealQuery}`);
  expect(compilingResponse.status()).toBe(200);
  expect((await compilingResponse.json()).reveal.state).toBe('compiling');
  const releasedResponse = await page.request.post(`/api/demo/reveal?${revealQuery}`);
  expect(releasedResponse.status()).toBe(200);
  expect((await releasedResponse.json()).reveal.state).toBe('released');

  stage = 'released playback';
  await page.getByTestId('nav-archive').click();
  await expect(page.getByTestId('archive-premiere-ready')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Your capsule film', { exact: true })).toBeVisible();
  const archive = await runtimeJson(
    page,
    `/api/archive?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(ownerSessionId)}`,
  );
  expect(archive.archive.films).toHaveLength(1);
  expect(archive.archive.films[0]).toMatchObject({
    cycleId,
    downloadPath: expect.any(String),
  });
  expect(archive.archive.clips).toHaveLength(1);
  expect(archive.archive.clips[0]).toMatchObject({
    id: 'demo-clip',
    contributionId: 'demo-contribution',
    cycleId,
    downloadPath: expect.any(String),
  });
  const seededClipDownload = await page.request.get(`/api${archive.archive.clips[0].downloadPath}`);
  expect(seededClipDownload.status()).toBe(200);
  expect(seededClipDownload.headers()['content-type']).toContain('video/mp4');
  expect(Number(seededClipDownload.headers()['content-length'] ?? 0)).toBeGreaterThan(0);
  const premiere = await runtimeJson(
    page,
    `/api/cycles/${encodeURIComponent(cycleId)}/premiere?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(ownerSessionId)}`,
  );
  expect(premiere.premiere.state).toBe('ready');
  expect(premiere.premiere.playbackPath).toEqual(expect.any(String));
  const filmId = premiere.premiere.filmId;
  expect(filmId).toEqual(expect.any(String));
  const playback = await page.request.get(`/api${premiere.premiere.playbackPath}`);
  expect(playback.status()).toBe(200);
  expect(playback.headers()['content-type']).toContain('video/mp4');
  expect(Number(playback.headers()['content-length'] ?? 0)).toBeGreaterThan(0);

  const processedClip = await runtimeJson(
    page,
    `/api/clips/${encodeURIComponent(clipJobId)}?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(ownerSessionId)}`,
  );
  expect(processedClip.clip).toMatchObject({ id: clipJobId, status: 'ready' });
  const film = await runtimeJson(
    page,
    `/api/films/${encodeURIComponent(filmId)}?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(ownerSessionId)}`,
  );
  expect(film.film).toMatchObject({ id: filmId, kind: 'film', status: 'ready' });
  const downloadJob = await runtimeJson(
    page,
    `/api/downloads/demo-download?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(ownerSessionId)}`,
  );
  expect(downloadJob.download).toMatchObject({ id: 'demo-download', kind: 'download' });
  const filmDownload = await page.request.get(
    `/api/films/${filmId}/download?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(ownerSessionId)}`,
  );
  expect(filmDownload.status()).toBe(200);
  expect(filmDownload.headers()['content-type']).toContain('video/mp4');

  const releasedMemberSessionResponse = await page.request.post('/api/sessions/demo', {
    data: { memberId: 'demo-2', groupId },
  });
  const releasedMemberSessionBody = await expectJson<{
    session: { id: string; groupId: string; actor: { memberId: string } };
  }>(releasedMemberSessionResponse, 201);
  const releasedMemberSessionId = releasedMemberSessionBody.session.id;
  expect(releasedMemberSessionBody.session).toMatchObject({
    groupId,
    actor: { memberId: 'demo-2' },
  });
  const memberArchive = await runtimeJson(
    page,
    `/api/archive?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(releasedMemberSessionId)}`,
  );
  expect(memberArchive.archive.films).toHaveLength(1);
  expect(memberArchive.archive.films[0].id).toBe(filmId);
  expect(memberArchive.archive.clips).toHaveLength(1);
  expect(memberArchive.archive.clips[0].id).toBe(clipJobId);
  expect(memberArchive.archive.clips[0].cycleId).toBe(cycleId);
  const otherMemberSeededClip = await page.request.get(
    `/api/clips/demo-clip/download?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(releasedMemberSessionId)}`,
  );
  expect(otherMemberSeededClip.status()).toBe(404);
  const clipDownload = await page.request.get(
    `/api/clips/${clipJobId}/download?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(releasedMemberSessionId)}`,
  );
  expect(clipDownload.status()).toBe(200);
  expect(clipDownload.headers()['content-type']).toContain('video/mp4');

  stage = 'cross-group fixture session';
  const secondMemberSessionResponse = await page.request.post('/api/sessions/demo', {
    data: { memberId: 'demo-6', groupId: CROSS_GROUP_BOOTSTRAP_GROUP_ID },
  });
  const secondMemberSessionBody = await expectJson<{
    session: { id: string; groupId: string; actor: { memberId: string } };
  }>(secondMemberSessionResponse, 201);
  const secondMemberSessionId = secondMemberSessionBody.session.id;
  expect(secondMemberSessionBody.session.actor.memberId).toBe('demo-6');
  expect(secondMemberSessionBody.session.groupId).toBe(CROSS_GROUP_BOOTSTRAP_GROUP_ID);

  const otherGroupResponse = await page.request.post(
    `/api/groups?sessionId=${encodeURIComponent(secondMemberSessionId)}`,
    {
      data: { name: 'E2E denial group', prompt: 'A separate safe-denial check.' },
    },
  );
  const otherGroupBody = await expectJson<{
    group: { id: string; memberIds: string[]; actingMemberRole: string };
    session: { id: string; groupId: string; actor: { memberId: string } };
  }>(otherGroupResponse, 201);
  expect(otherGroupBody.group.id).not.toBe(groupId);
  expect(otherGroupBody.group.memberIds).toEqual(['demo-6']);
  expect(otherGroupBody.group.actingMemberRole).toBe('owner');
  const otherGroupId = otherGroupBody.group.id;
  expect(otherGroupBody.session).toMatchObject({
    id: secondMemberSessionId,
    groupId: otherGroupId,
    actor: { memberId: 'demo-6' },
  });

  stage = 'cross-group safe denial';
  const originalGroupQuery = `groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(secondMemberSessionId)}`;
  const deniedPaths = [
    `/api/groups/${encodeURIComponent(groupId)}?sessionId=${encodeURIComponent(secondMemberSessionId)}`,
    `/api/clips/${encodeURIComponent(clipJobId)}?${originalGroupQuery}`,
    `/api/films/${encodeURIComponent(filmId)}?${originalGroupQuery}`,
    `/api/cycles/${encodeURIComponent(cycleId)}/premiere?${originalGroupQuery}`,
    `/api/archive?${originalGroupQuery}`,
    `/api/downloads/demo-download?${originalGroupQuery}`,
    `/api/films/${encodeURIComponent(filmId)}/play?${originalGroupQuery}`,
    `/api/films/${encodeURIComponent(filmId)}/download?${originalGroupQuery}`,
    `/api/clips/${encodeURIComponent(clipJobId)}/download?${originalGroupQuery}`,
  ];
  for (const path of deniedPaths) await expectSafeDenial(page, path);
});
