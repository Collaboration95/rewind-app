import { chromium } from '@playwright/test';

import { MEMBER_STATE, signUpAndCreateGroup } from './real-account';

export default async function globalSetup() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await signUpAndCreateGroup(await context.newPage());
    await context.storageState({ path: MEMBER_STATE });
  } finally {
    await browser.close();
  }
}
