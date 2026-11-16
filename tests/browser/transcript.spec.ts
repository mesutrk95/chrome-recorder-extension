import { expect, test, type Page } from '@playwright/test';

async function seedAudio(page: Page, seconds = 2, video = false) {
  await page.goto('/library.html');
  await page.evaluate(async ({ length, video }) => {
    const sampleRate = 16000;
    const buffer = new ArrayBuffer(44 + sampleRate * length * 2);
    const wav = new DataView(buffer);
    const string = (offset: number, text: string) => [...text].forEach((char, index) => wav.setUint8(offset + index, char.charCodeAt(0)));
    string(0, 'RIFF'); wav.setUint32(4, buffer.byteLength - 8, true); string(8, 'WAVE'); string(12, 'fmt ');
    wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true); wav.setUint32(24, sampleRate, true); wav.setUint32(28, sampleRate * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); string(36, 'data'); wav.setUint32(40, buffer.byteLength - 44, true);
    let blob = new Blob([buffer], { type: 'audio/wav' });
    if (video) {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const paint = canvas.getContext('2d')!;
      const frames = setInterval(() => { paint.fillStyle = '#2b634c'; paint.fillRect(0, 0, 320, 180); paint.fillStyle = 'white'; paint.fillText(`Meeting ${Date.now()}`, 20, 50); }, 40);
      const audio = new AudioContext(); await audio.resume();
      const oscillator = audio.createOscillator(); const output = audio.createMediaStreamDestination();
      oscillator.connect(output); oscillator.start();
      const capture = new MediaStream([...canvas.captureStream(15).getVideoTracks(), ...output.stream.getAudioTracks()]);
      const recorder = new MediaRecorder(capture, { mimeType: 'video/webm;codecs=vp8,opus' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      blob = await new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType })); recorder.start(); setTimeout(() => recorder.stop(), length * 1000); });
      clearInterval(frames); capture.getTracks().forEach(track => track.stop()); oscillator.stop(); await audio.close();
    }
    const modulePath = '/src/db.ts'; const db = await import(modulePath);
    const record = { id: 'english', title: '2026-10-21 09:30 — Weekly meeting', startedAt: new Date(2026, 9, 21, 9, 30).getTime(), duration: length * 1000, size: blob.size, mimeType: blob.type, status: 'saved', hasMic: false, meetUrl: '' };
    await db.putRecording(record); await db.appendChunk(record, 0, blob);
  }, { length: seconds, video });
}
async function mockSpeech(page: Page, availability = 'available') {
  await page.addInitScript(value => {
    const state = window as any;
    state.__availability = value; state.__speechStarts = []; state.__microphoneCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { state.__microphoneCalls++; throw new Error('Microphone must never be used.'); };
    class Speech {
      static async available() { return state.__availability; }
      static async install() { state.__availability = 'available'; return true; }
      get processLocally() { return (this as any)._local; }
      set processLocally(value: boolean) { (this as any)._local = value; }
      onstart?: Function; onspeechstart?: Function; onspeechend?: Function; onend?: Function; onresult?: Function;
      timer?: number; speechTimer?: number;
      start(track: MediaStreamTrack) {
        state.__speechStarts.push({ kind: track?.kind, live: track?.readyState, local: this.processLocally, language: (this as any).lang });
        setTimeout(() => this.onstart?.(), 0);
        this.speechTimer = window.setTimeout(() => this.onspeechstart?.(), 100);
        this.timer = window.setTimeout(() => { this.onspeechend?.(); this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'Hello team. We will finish on Friday.' } }] }); }, 650);
      }
      stop() { setTimeout(() => this.onend?.(), 0); }
      abort() { clearTimeout(this.timer); clearTimeout(this.speechTimer); }
    }
    state.SpeechRecognition = Speech;
  }, availability);
}

test('transcribes saved audio locally, persists the transcript, and downloads English SRT', async ({ page }) => {
  await mockSpeech(page, 'downloadable');
  await seedAudio(page, 2, true);
  await page.getByRole('button', { name: 'Transcript for 2026-10-21 09:30 — Weekly meeting' }).click();
  await page.getByRole('button', { name: 'Download English language pack', exact: true }).click();
  await page.getByRole('button', { name: 'Transcribe in English', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel('Transcript preview')).toContainText('Hello team. We will finish on Friday.');
  expect(await page.evaluate(() => (window as any).__speechStarts)).toEqual([{ kind: 'audio', live: 'live', local: true, language: 'en-US' }]);
  expect(await page.evaluate(() => (window as any).__microphoneCalls)).toBe(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download SRT', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('2026-10-21 09-30 — Weekly meeting.en.srt');
  const stream = (await download.createReadStream())!;
  let contents = '';
  for await (const chunk of stream) contents += chunk.toString();
  expect(contents).toMatch(/^1\r\n00:00:00,\d{3} --> 00:00:00,\d{3}\r\nHello team/);
  await page.getByRole('button', { name: 'Close transcript' }).click();
  await page.reload();
  await page.getByRole('button', { name: /Transcript for/ }).click();
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__speechStarts)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/transcript-mobile.png', fullPage: true });
});

test('stopping saves a usable partial SRT and closing releases the job', async ({ page }) => {
  await mockSpeech(page);
  await seedAudio(page, 12);
  await page.getByRole('button', { name: /Transcript for/ }).click();
  await page.getByRole('button', { name: 'Transcribe in English', exact: true }).click();
  await expect(page.getByLabel('Transcript preview')).toContainText('Hello team');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download partial SRT' })).toBeVisible();
  await page.getByRole('button', { name: 'Transcribe again' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Transcript for/ }).click();
  await expect(page.getByRole('button', { name: 'Download partial SRT' })).toBeVisible();
});

test('unsupported Chrome explains requirements while keeping existing subtitle downloads available', async ({ page }) => {
  await page.addInitScript(() => { (window as any).SpeechRecognition = undefined; });
  await seedAudio(page);
  await page.evaluate(async () => {
    const modulePath = '/src/db.ts'; const db = await import(modulePath);
    await db.putTranscript({ recordingId: 'english', language: 'en-US', engine: 'chrome-on-device', timing: 'approximate', status: 'completed', cues: [{ startMs: 0, endMs: 1500, text: 'Saved transcript.' }], processedMs: 2000, durationMs: 2000, updatedAt: Date.now() });
  });
  await page.getByRole('button', { name: /Transcript for/ }).click();
  await expect(page.getByText(/Local transcription needs desktop Chrome/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Transcribe in English', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeVisible();
});
