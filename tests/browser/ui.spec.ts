import { expect, test } from '@playwright/test';

test('library, preferences, search, and mobile layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/library.html');
  await expect(page.getByRole('heading', { name: 'Your meetings, kept.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Be there. We’ll remember.' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/library.png', fullPage: true });
  await page.getByRole('textbox', { name: 'Search recordings' }).fill('missing');
  await expect(page.getByRole('heading', { name: 'No matching conversations.' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recording preferences' })).toBeVisible();
  await page.getByRole('switch', { name: /Download when finished/ }).uncheck();
  await page.reload();
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await expect(page.getByRole('switch', { name: /Download when finished/ })).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('popup clearly describes arming and opens library', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto('/popup.html');
  await expect(page.getByRole('heading', { name: 'A little less to remember.' })).toBeVisible();
  await expect(page.getByText('No recordable tab', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeDisabled();
  await page.locator('.popup').screenshot({ path: 'artifacts/popup.png' });
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open recording library' }).click();
  await expect((await popup).getByRole('heading', { name: 'Your meetings, kept.' })).toBeVisible();
});
