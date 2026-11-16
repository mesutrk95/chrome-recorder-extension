import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

// The fixture is spoken English synthesized locally with Windows System.Speech.
// This test uses Chrome's real downloaded English model, with no recognition mock.
const fixturePath = resolve('artifacts/english-speech.wav');
let fixture;
try { fixture = await readFile(fixturePath); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (process.platform !== 'win32') throw new Error('Provide artifacts/english-speech.wav with spoken English or generate it on Windows.');
  await mkdir(resolve('artifacts'), { recursive: true });
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/make-speech-fixture.ps1'), '-Destination', fixturePath], { windowsHide: true });
  fixture = await readFile(fixturePath);
}
const root = resolve(tmpdir());
const profile = await mkdtemp(join(root, 'meetkeep-transcription-'));
let context;
try {
  const installedChrome = process.env.MEETKEEP_TEST_CHROME === 'chrome';
  context = await chromium.launchPersistentContext(profile, {
    channel: installedChrome ? 'chrome' : 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-component-update', '--disable-background-networking'],
    args: [...(installedChrome ? [] : [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`]), '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await context.newPage();
  page.on('pageerror', error => console.error('PAGE ERROR', error.message));
  if (installedChrome) {
    // Branded Chrome disallows command-line extension loading. Exercise the same
    // production bundle on a secure, locally fulfilled origin in an empty profile.
    await page.route('https://meetkeep.test/**', route => {
      const path = resolve('dist', `.${new URL(route.request().url()).pathname}`);
      if (!path.startsWith(resolve('dist') + sep)) throw new Error('Unexpected test request.');
      return route.fulfill({path});
    });
    await page.goto('https://meetkeep.test/library.html');
  } else {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/library.html`);
  }
  console.log('Test browser:', await page.evaluate(()=>navigator.userAgent));
  await page.getByRole('heading', { name: 'Your meetings, kept.' }).waitFor();
  await page.evaluate(async base64 => {
    const request = indexedDB.open('meetkeep');
    const database = await new Promise((resolve,reject) => { request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error); });
    const data = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const tx = database.transaction(['recordings','chunks'],'readwrite');
    tx.objectStore('recordings').put({ id:'speech-test', title:'English speech test', meetUrl:'', startedAt:Date.now(), duration:15000, size:data.length, mimeType:'audio/wav', status:'saved', hasMic:false });
    tx.objectStore('chunks').put({recordingId:'speech-test',index:0,data:new Blob([data],{type:'audio/wav'})});
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});database.close();
  },fixture.toString('base64'));
  await page.getByRole('button',{name:'Transcript for English speech test'}).click();
  const install = page.getByRole('button',{name:'Download English language pack',exact:true});
  const start = page.getByRole('button',{name:'Transcribe in English',exact:true});
  await expect(install.or(start)).toBeVisible({timeout:15000});
  if (await install.isVisible()) {
    console.log('Installing the on-device English language pack in the isolated browser…');
    await install.click();
    try {
      await expect(start.or(page.getByRole('alert'))).toBeVisible({timeout:150000});
      if (await page.getByRole('alert').count()) throw new Error(await page.getByRole('alert').innerText());
    } catch (problem) {
      console.error(await page.getByRole('dialog').innerText());
      await page.screenshot({path:'artifacts/transcript-native-blocked.png',fullPage:true});
      throw problem;
    }
  }
  console.log('English model installed; transcribing real spoken audio.');
  await start.click();
  const download = page.getByRole('button',{name:'Download SRT',exact:true});
  try { await download.waitFor({timeout:90000}); }
  catch(problem) { console.error(await page.getByRole('dialog').innerText());throw problem; }
  const preview = await page.getByLabel('Transcript preview').innerText();
  expect(preview.toLowerCase()).toContain('meeting');
  expect(preview.toLowerCase()).toContain('friday');
  console.log('Native transcript:',preview);
  const pending = page.waitForEvent('download');await download.click();
  const file = await pending;
  expect(file.suggestedFilename()).toMatch(/ — English speech test\.en\.srt$/);
  await file.saveAs(resolve('artifacts/english-speech.en.srt'));
  await page.screenshot({path:'artifacts/transcript-native.png',fullPage:true});
  console.log('Native English recognition and SRT download passed.');
} finally {
  await context?.close();
  if (dirname(resolve(profile)) !== root || !basename(profile).startsWith('meetkeep-transcription-')) throw new Error('Unexpected temporary path.');
  await rm(profile,{recursive:true,force:true});
}
