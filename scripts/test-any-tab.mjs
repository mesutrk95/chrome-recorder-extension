import { chromium, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const temporaryRoot = resolve(tmpdir());
const profile = await mkdtemp(join(temporaryRoot, 'meetkeep-any-tab-'));
let context;
try {
  // The debug flag grants test automation access to Chrome's toolbar action in
  // this empty, disposable profile only. It is never used by the extension.
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const library = await context.newPage();
  await library.goto(`chrome-extension://${id}/library.html`);
  await expect(library.getByRole('heading', { name: 'Your meetings, kept.' })).toBeVisible();
  await library.evaluate(() => chrome.runtime.sendMessage({ type: 'SETTINGS', settings: { autoDownload: false } }));
  const site = await context.newPage();
  const markup = name => `<!doctype html><title>${name}</title><body style="margin:0;background:#27664d;color:white;font:25px system-ui"><main style="padding:60px">${name}<p id="clock"></p><button id="sound">Play audio</button></main><script>setInterval(()=>document.querySelector('#clock').textContent=new Date().toISOString(),100);document.querySelector('#sound').onclick=async()=>{const a=new AudioContext();await a.resume();const o=a.createOscillator();const g=a.createGain();g.gain.value=.01;o.connect(g).connect(a.destination);o.start()};</script>`;
  await context.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: markup('Demo browser tab') }));
  await context.route('https://other.test/**', route => route.fulfill({ contentType: 'text/html', body: markup('Another page in the same tab') }));
  await site.goto('https://example.test/watch');
  await site.getByRole('button', { name: 'Play audio' }).click();
  await expect(site.locator('#meetkeep-control')).toHaveCount(0);
  const cdp = await context.browser().newBrowserCDPSession();
  async function popup() {
    // Headless Chrome does not expose its toolbar popup as a Playwright Page.
    // Run the same built popup UI in a background extension tab, while invoking
    // the actual toolbar action to grant native capture access to the site.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await site.bringToFront();
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
    const target = targetInfos.find(target => target.url === site.url());
    if (!target) throw new Error(`Test tab target was not found: ${JSON.stringify(targetInfos)}`);
    await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
    return page;
  }
  const click = (page, name) => page.getByRole('button', { name, exact: true }).evaluate(button => button.click());
  const state = () => library.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'OVERVIEW' })).data.session);
  const records = () => library.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('meetkeep'); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result; const query = db.transaction('recordings', 'readonly').objectStore('recordings').getAll(); query.onsuccess = () => { db.close(); resolve(query.result.sort((a,b) => b.startedAt - a.startedAt)); }; query.onerror = () => reject(query.error); };
  }));
  const first = await popup();
  await expect(first.getByText('Demo browser tab', { exact: true })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
  await click(first, 'Start recording');
  await expect.poll(async () => (await state()).phase, { timeout: 15000 }).toBe('recording');
  await expect(first.getByRole('button', { name: 'Stop & save' })).toBeVisible();
  expect((await state()).warning).toBeUndefined();
  await first.screenshot({ path: 'artifacts/popup-any-tab.png' });
  await first.close();
  await expect.poll(async () => (await records())[0]?.size ?? 0, { timeout: 15000 }).toBeGreaterThan(0);
  await site.goto('https://other.test/next');
  await site.getByRole('button', { name: 'Play audio' }).click();
  await site.reload();
  const previousBytes = (await records())[0].size;
  await expect.poll(async () => (await records())[0]?.size ?? 0, { timeout: 15000 }).toBeGreaterThan(previousBytes);
  expect((await state()).phase).toBe('recording');
  const stop = await popup();
  await expect(stop.getByRole('button', { name: 'Stop & save' })).toBeEnabled();
  await click(stop, 'Stop & save');
  await expect.poll(async () => (await state()).phase, { timeout: 15000 }).toBe('idle');
  const saved = (await records())[0];
  expect(saved.status).toBe('saved'); expect(saved.webmIndexed).toBe(1);
  expect(saved.title).toMatch(/ — Demo browser tab$/);
  expect(saved.meetUrl).toBe('https://example.test/watch');
  await stop.close();
  // Closing a generic tab also flushes the offscreen recording.
  const second = await popup();
  await expect(second.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
  await click(second, 'Start recording');
  await expect.poll(async () => (await state()).phase, { timeout: 15000 }).toBe('recording');
  await second.close();
  await expect.poll(async () => (await records()).filter(record => record.size > 0).length, { timeout: 15000 }).toBe(2);
  await site.close();
  await expect.poll(async () => (await state()).phase, { timeout: 15000 }).toBe('idle');
  expect((await records()).every(record => record.status === 'saved' && record.webmIndexed === 1)).toBe(true);
  console.log('PASS: actual toolbar invocation, non-Meet tab capture, popup controls, navigation/reload, finalized video and tab-close saving.');
} finally {
  await context?.close();
  if (dirname(resolve(profile)) !== temporaryRoot || !basename(profile).startsWith('meetkeep-any-tab-')) throw new Error('Unexpected temporary profile path.');
  await rm(profile, { recursive: true, force: true });
}
