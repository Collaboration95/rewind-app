import { expect } from '@playwright/test';
import { openChat } from './navigation.mjs';

function messageRow(page, body) {
  return page
    .getByTestId(/^real-chat-message-/)
    .filter({ has: page.getByText(body, { exact: true }) });
}

async function sendText(page, groupId, body) {
  const path = `/api/realtime/groups/${encodeURIComponent(groupId)}/messages`;
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === path,
  );
  await page.getByTestId('real-chat-composer').fill(body);
  await page.getByTestId('real-chat-send').click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const { event } = await response.json();
  expect(event.message.body).toBe(body);
  await expect(messageRow(page, body)).toHaveCount(1);
  await expect(page.getByTestId('real-chat-composer')).toHaveValue('');
  return event;
}

export async function verifyOwnerChat(page, groupId, suffix) {
  await openChat(page, groupId);
  await expect(page.getByTestId('real-chat-empty')).toBeVisible();
  const event = await sendText(page, groupId, `Fixture owner chat ${suffix}`);
  await page.getByTestId('real-group-nav-home').click();
  return event;
}

export async function verifyMemberChat(page, groupId, ownerEvent, suffix) {
  await openChat(page, groupId);
  await expect(messageRow(page, ownerEvent.message.body)).toHaveCount(1);
  const memberEvent = await sendText(page, groupId, `Fixture member chat ${suffix}`);
  expect(memberEvent.message.memberId).not.toBe(ownerEvent.message.memberId);

  await page.getByTestId(`real-chat-message-${ownerEvent.message.id}`).click();
  await page.getByTestId(`real-chat-reply-${ownerEvent.message.id}`).click();
  const replyBody = `Fixture member reply ${suffix}`;
  await page.getByTestId('real-chat-composer').fill(replyBody);
  const messagesPath = `/api/realtime/groups/${encodeURIComponent(groupId)}/messages`;
  // Let the real server persist the reply, then lose only its response. The UI
  // must keep the failed message/identity and safely replay the same write on retry.
  await page.evaluate((targetPath) => {
    window.__rewindChatResponseLoss.targetPath = targetPath;
  }, messagesPath);
  await page.getByTestId('real-chat-send').click();
  await expect(page.getByTestId('real-chat-retry-send')).toBeVisible();
  await expect(page.getByTestId('real-chat-retry-send')).toBeEnabled();
  await expect(page.getByTestId('real-chat-retry-send').locator('..')).toContainText(replyBody);
  await expect(page.getByTestId('real-chat-composer')).toHaveValue('');
  const { firstRequestBody, persistedReply, status } = await page.evaluate(
    () => window.__rewindChatResponseLoss,
  );
  expect(status).toBe(201);
  expect(persistedReply.message.id).toBe(firstRequestBody.messageId);
  const replayResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === messagesPath,
  );
  await page.getByTestId('real-chat-retry-send').click();
  const replay = await replayResponse;
  expect(replay.status()).toBe(200);
  expect(replay.request().postDataJSON()).toEqual(firstRequestBody);
  const replayBody = await replay.json();
  expect(replayBody.deduplicated).toBe(true);
  expect(replayBody.event).toEqual(persistedReply);
  expect(persistedReply.message.replyTo.id).toBe(ownerEvent.message.id);
  await expect(messageRow(page, replyBody)).toHaveCount(1);
  await expect(page.getByTestId('real-chat-composer')).toHaveValue('');
  await expect(page.getByTestId('real-chat-reply-target')).toHaveCount(0);

  await page.getByTestId(`real-chat-message-${ownerEvent.message.id}`).click();
  await page.getByTestId(`real-chat-reaction-${ownerEvent.message.id}`).click();
  const reaction = page.getByTestId(`real-chat-sparks-${ownerEvent.message.id}`);
  await expect(reaction).toHaveText('✨ 1');
  await reaction.click();
  await expect(reaction).toHaveCount(0);
  await page.getByTestId('real-group-nav-home').click();
  await page.reload();
  await expect(page.getByTestId('real-group-home')).toBeVisible();
  await openChat(page, groupId);
  for (const body of [ownerEvent.message.body, memberEvent.message.body, replyBody]) {
    await expect(messageRow(page, body)).toHaveCount(1);
  }
  await expect(page.getByTestId(`real-chat-sparks-${ownerEvent.message.id}`)).toHaveCount(0);
  await expect(page.getByTestId('real-chat-retry-send')).toHaveCount(0);
  await page.getByTestId('real-group-nav-home').click();
}

// Install before RealAccountClient captures fetch. Firefox service-worker API
// forwarding can bypass page.route; this drops only the application response
// after the genuine authorized server write, with the service worker still active.
export function installChatResponseLoss() {
  const fetch = window.fetch.bind(window);
  const fixture = { targetPath: null, firstRequestBody: null, persistedReply: null, status: null };
  window.__rewindChatResponseLoss = fixture;
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input.url ?? String(input)),
      window.location.href,
    );
    const loseResponse = fixture.targetPath === url.pathname && init?.method === 'POST';
    if (loseResponse) {
      fixture.targetPath = null;
      fixture.firstRequestBody = JSON.parse(init.body);
    }
    const response = await fetch(input, init);
    if (loseResponse) {
      fixture.status = response.status;
      fixture.persistedReply = (await response.clone().json()).event;
      throw new TypeError('Fixture response lost after persistence');
    }
    return response;
  };
}
