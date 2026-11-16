import { expect, test } from '@playwright/test';

test('finalizes a real multi-chunk WebM, preserves media bytes, and seeks before playback', async ({ page }) => {
  test.setTimeout(45000);
  await page.goto('/library.html');
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const paint = canvas.getContext('2d')!;
    const begin = performance.now();
    const frames = setInterval(() => { paint.fillStyle = performance.now() - begin < 4000 ? '#c41920' : '#0abe1e'; paint.fillRect(0, 0, 320, 180); }, 40);
    const context = new AudioContext(); await context.resume();
    const tone = context.createOscillator(); const output = context.createMediaStreamDestination(); tone.connect(output); tone.start();
    const capture = new MediaStream([...canvas.captureStream(15).getVideoTracks(), ...output.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(capture, { mimeType: 'video/webm;codecs=vp8,opus', videoKeyFrameIntervalDuration: 1000 } as MediaRecorderOptions);
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    await new Promise<void>(resolve => { recorder.onstop = () => resolve(); recorder.start(1000); setTimeout(() => recorder.stop(), 6500); });
    clearInterval(frames); capture.getTracks().forEach(track => track.stop()); tone.stop(); await context.close();
    const original = new Blob(chunks, { type: recorder.mimeType });
    const path = '/src/db.ts'; const db = await import(path);
    const record = { id: 'indexed', title: 'Seekable recording', meetUrl: '', startedAt: Date.now(), duration: 6500, size: original.size, mimeType: original.type, status: 'saved', hasMic: false };
    await db.putRecording(record);
    for (let index = 0; index < chunks.length; index++) await db.appendChunk(record, index, chunks[index]);
    const start = performance.now();
    const file = await db.recordingFile(record);
    const indexingMs = performance.now() - start;
    const persisted = (await db.listRecordings()).find((value: any) => value.id === record.id);
    const reused = await db.recordingFile(record); // Stale metadata must not trigger another rewrite.
    // Independent binary inspection of the output's SeekHead, Cues and payloads.
    function parse(bytes: Uint8Array) {
      function vint(at: number, id = false) {
        let width = 1, mask = 128; while (!(bytes[at] & mask)) { width++; mask >>= 1; }
        let value = id ? bytes[at] : bytes[at] & (mask - 1);
        let unknown = !id && value === mask - 1;
        for (let i = 1; i < width; i++) { value = value * 256 + bytes[at + i]; unknown &&= bytes[at + i] === 255; }
        return { value, width, unknown };
      }
      function header(at: number, limit = bytes.length) {
        const id = vint(at, true); const size = vint(at + id.width);
        const data = at + id.width + size.width;
        return { id: id.value, start: at, data, end: size.unknown ? limit : data + size.value, unknown: size.unknown };
      }
      function children(data: number, end: number) {
        const result = []; for (let at = data; at < end;) { const entry = header(at, end); result.push(entry); at = entry.end; } return result;
      }
      function uint(data: number, end: number) { let result = 0; for (let at = data; at < end; at++) result = result * 256 + bytes[at]; return result; }
      const ebml = header(0); const segment = header(ebml.end);
      const top = []; const media = [];
      for (let at = segment.data; at < segment.end;) {
        const entry = header(at, segment.end);
        if (entry.id === 0x1f43b675 && entry.unknown) {
          let childAt = entry.data;
          while (childAt < entry.end) {
            const child = header(childAt, entry.end);
            if ([0x1f43b675, 0x1c53bb6b].includes(child.id)) break;
            childAt = child.end;
          }
          entry.end = childAt;
        }
        top.push(entry);
        if (entry.id === 0x1f43b675) media.push(bytes.slice(entry.start, entry.end));
        at = entry.end;
      }
      const index = top.find(entry => entry.id === 0x1c53bb6b);
      const points = index ? children(index.data, index.end).map(point => {
        const positions = children(point.data, point.end).find(field => field.id === 0xb7)!;
        const fields = children(positions.data, positions.end);
        const cluster = fields.find(field => field.id === 0xf1)!;
        const relative = fields.find(field => field.id === 0xf0)!;
        const clusterAt = segment.data + uint(cluster.data, cluster.end);
        const target = header(clusterAt);
        const block = header(target.data + uint(relative.data, relative.end));
        const track = vint(block.data);
        const key = block.id === 0xa3 ? !!(bytes[block.data + track.width + 2] & 128) : block.id === 0xa0 && !children(block.data, block.end).some(child => child.id === 0xfb);
        return { valid: target.id === 0x1f43b675 && key, blockId: block.id };
      }) : [];
      const seek = top.find(entry => entry.id === 0x114d9b74);
      const validSeekHead = seek && children(seek.data, seek.end).every(entry => {
        const fields = children(entry.data, entry.end);
        const id = fields.find(field => field.id === 0x53ab)!; const position = fields.find(field => field.id === 0x53ac)!;
        return header(segment.data + uint(position.data, position.end)).id === uint(id.data, id.end);
      });
      return { top, media, points, validSeekHead };
    }
    const old = parse(new Uint8Array(await original.arrayBuffer()));
    const prepared = parse(new Uint8Array(await file.blob.arrayBuffer()));
    const oldHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob(old.media).arrayBuffer()))];
    const newHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob(prepared.media).arrayBuffer()))];
    const url = URL.createObjectURL(file.blob); const video = document.createElement('video'); video.muted = true; video.preload = 'metadata'; video.src = url;
    await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error('Indexed video failed to load.')); });
    const duration = video.duration;
    const seekableEnd = video.seekable.length ? video.seekable.end(0) : 0;
    await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error('Indexed video failed to seek.')); video.currentTime = duration * .8; });
    const view = document.createElement('canvas'); view.width = 320; view.height = 180;
    const draw = view.getContext('2d')!; draw.drawImage(video, 0, 0);
    const pixel = [...draw.getImageData(150, 90, 1, 1).data];
    const seeked = video.currentTime;
    const stopped = video.paused;
    video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
    return { duration, seekableEnd, seeked, stopped, pixel, indexingMs, originalBytes: original.size, indexedBytes: file.blob.size, persisted, warning: file.warning, cueCount: prepared.points.length, validCues: prepared.points.every(point => point.valid), validSeekHead: prepared.validSeekHead, beforeMedia: prepared.top.findIndex(entry => entry.id === 0x1c53bb6b) < prepared.top.findIndex(entry => entry.id === 0x1f43b675), unchangedPackets: JSON.stringify(oldHash) === JSON.stringify(newHash), reusedSize: reused.blob.size };
  });
  console.log('Indexed WebM:', result);
  expect(result.warning).toBeUndefined();
  expect(result.persisted.webmIndexed).toBe(1);
  expect(result.duration).toBeGreaterThan(6);
  expect(result.duration).toBeLessThan(8);
  expect(result.seekableEnd).toBeCloseTo(result.duration, 1);
  expect(result.seeked).toBeCloseTo(result.duration * .8, 1);
  expect(result.stopped).toBe(true); // Jumped directly without playing through the recording.
  expect(result.pixel[1]).toBeGreaterThan(150);
  expect(result.pixel[0]).toBeLessThan(80);
  expect(result.cueCount).toBeGreaterThan(2);
  expect(result.validCues).toBe(true);
  expect(result.validSeekHead).toBe(true);
  expect(result.beforeMedia).toBe(true);
  expect(result.unchangedPackets).toBe(true);
  expect(result.reusedSize).toBe(result.indexedBytes);
});
