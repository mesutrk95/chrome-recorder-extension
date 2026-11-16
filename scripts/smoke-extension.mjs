import { chromium, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const temporaryRoot = resolve(tmpdir());
const profile = await mkdtemp(join(temporaryRoot, 'meetkeep-smoke-'));
const extension = resolve('dist');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/library.html`);
  await expect(page.getByRole('heading', { name: 'Your meetings, kept.' })).toBeVisible();
  await worker.evaluate(async () => {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Verify the packaged recorder loads correctly.' });
  });
  const status = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'OVERVIEW' }));
  expect(status.ok).toBe(true);
  expect(status.data.session.phase).toBe('idle');
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('switch', { name: /Download when finished/ }).uncheck();
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings.autoDownload)).toBe(false);
  await page.goto(`chrome-extension://${id}/popup.html`);
  await expect(page.getByRole('heading', { name: 'A little less to remember.' })).toBeVisible();
  await page.locator('.popup').screenshot({ path: 'artifacts/popup-extension.png' });
  await page.goto(`chrome-extension://${id}/library.html`);
  await expect(page.getByRole('heading', { name: 'Be there. We’ll remember.' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/library-extension.png', fullPage: true });
  expect(errors).toEqual([]);
  console.log('Packaged extension loaded: service worker, offscreen document, popup, library, and persistent settings verified.');
} finally {
  await context?.close();
  // Only remove the temporary profile created by this script, within the verified temp root.
  if (dirname(resolve(profile)) !== temporaryRoot || !basename(profile).startsWith('meetkeep-smoke-')) throw new Error('Unexpected temporary profile path.');
  await rm(profile, { recursive: true, force: true });
}
