import { expect, test } from '@playwright/test';

test('offscreen recorder arms, records real WebM chunks, pauses, resumes, and saves', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const listeners: Function[] = [];
    (window as any).chrome = {
      runtime: {
        id: 'test-extension',
        onMessage: { addListener: (listener: Function) => listeners.push(listener) },
        sendMessage: async () => ({ ok: true }),
      },
    };
    (window as any).__command = (message: unknown) => new Promise(resolve => listeners[0](message, { id: 'test-extension' }, resolve));
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const draw = canvas.getContext('2d')!;
    setInterval(() => { draw.fillStyle = '#25634b'; draw.fillRect(0, 0, 640, 360); draw.fillStyle = 'white'; draw.fillText(`Test meeting ${Date.now()}`, 100, 100); }, 50);
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const output = context.createMediaStreamDestination();
    oscillator.connect(output); oscillator.start();
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!(constraints?.audio as any)?.mandatory) throw new Error('Microphone permission denied');
      return new MediaStream([...canvas.captureStream(15).getVideoTracks(), ...output.stream.getAudioTracks()]);
    };
  });
  await page.goto('/offscreen.html');
  await page.waitForFunction(() => !!(window as any).__command);
  const send = (message: Record<string, unknown>) => page.evaluate(async value => (window as any).__command({ target: 'recorder', ...value }), message);
  const arm = await send({ type: 'ARM', streamId: 'synthetic', tabId: 10, title: 'Test meeting', meetUrl: 'https://meet.google.com/abc-defg-hij', settings: { autoStart: true, autoDownload: false, includeMic: false, quality: 'standard' }, joined: false });
  expect(arm.ok).toBe(true);
  expect(arm.data.phase).toBe('armed');
  const started = await send({ type: 'BEGIN', title: 'Meet - Updated team sync' });
  expect(started.data.phase).toBe('recording');
  await expect.poll(() => page.evaluate(async () => {
    const modulePath = '/src/db.ts'; const db = await import(modulePath);
    return (await db.listRecordings())[0]?.size ?? 0;
  }), { timeout: 15_000 }).toBeGreaterThan(0);
  expect((await send({ type: 'PAUSE' })).data.phase).toBe('paused');
  expect((await send({ type: 'RESUME' })).data.phase).toBe('recording');
  expect((await send({ type: 'STOP' })).data.phase).toBe('idle');
  const saved = await page.evaluate(async () => {
    const modulePath = '/src/db.ts'; const db = await import(modulePath);
    const record = (await db.listRecordings())[0]; const blob = await db.recordingBlob(record);
    const header = [...new Uint8Array(await blob.slice(0, 4).arrayBuffer())];
    return { record, blobSize: blob.size, header };
  });
  expect(saved.record.status).toBe('saved');
  expect(saved.record.webmIndexed).toBe(1); // Finalized even with automatic downloads disabled.
  expect(saved.record.title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — Meet - Updated team sync$/);
  expect(saved.record.duration).toBeGreaterThan(0);
  expect(saved.blobSize).toBe(saved.record.size);
  expect(saved.header).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // WebM EBML header.
  const denied = await send({ type: 'ARM', streamId: 'synthetic', tabId: 10, title: 'Test meeting', meetUrl: 'https://meet.google.com/abc-defg-hij', settings: { autoStart: true, autoDownload: false, includeMic: true, quality: 'standard' }, joined: true });
  expect(denied.ok).toBe(false);
  expect(denied.error).toContain('Microphone access');
  expect((await send({ type: 'STATUS' })).data.phase).toBe('idle');
  expect(errors).toEqual([]);
});
