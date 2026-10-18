import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

import { openGroupHome, SECURE_ORIGIN, signUpAndCreateGroup, uniqueUsername } from './real-account';

type RecordingMember = {
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>;
  groupsUsed: number;
};

/** Keep real upload/processing state out of the next recording test's review. */
export const recordingTest = base.extend<
  { recordingGroup: void },
  { recordingMembers: Map<string, RecordingMember> }
>({
  baseURL: SECURE_ORIGIN,
  ignoreHTTPSErrors: true,
  recordingMembers: [new Map(), { scope: 'worker' }],
  storageState: async ({ browser, recordingMembers }, provide, info) => {
    // Files may share a worker in the aggregate suite. Each needs its own
    // account to respect the server's group-creation limit without mocking it.
    let member = recordingMembers.get(info.file);
    if (!member) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        await signUpAndCreateGroup(await context.newPage(), uniqueUsername('recording'));
        member = { storageState: await context.storageState(), groupsUsed: 0 };
        recordingMembers.set(info.file, member);
      } finally {
        await context.close();
      }
    }
    await provide(member.storageState);
  },
  recordingGroup: [
    async ({ page, recordingMembers }, provide, info) => {
      await openGroupHome(page);
      const recordingMember = recordingMembers.get(info.file)!;
      // The first group came from registration. Reuse its empty state once so
      // each file stays within the real five-groups-per-account creation limit.
      if (recordingMember.groupsUsed++ > 0) {
        const name = uniqueUsername('Recording ');
        await page.getByTestId('real-group-menu-button').click();
        await page.getByTestId('real-group-menu-create').click();
        await page.getByTestId('real-group-name').fill(name);
        await page.getByTestId('real-group-create-submit').click();
        await expect(page.getByTestId('real-group-name-heading')).toHaveText(name);
      }
      await provide();
    },
    { auto: true },
  ],
});

/** Arm before Seal: upload acceptance and successful processing are separate responses. */
export function waitForRecordingProcessed(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /^\/api\/contributions\/jobs\/[^/]+\/process$/.test(new URL(response.url()).pathname),
  );
}
