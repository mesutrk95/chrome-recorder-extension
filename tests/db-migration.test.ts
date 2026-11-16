import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import type { Recording } from '../src/shared';

it('adds transcripts without losing an existing version-one library', async () => {
  const record: Recording = { id: 'legacy', title: 'Existing meeting', startedAt: 1, duration: 1, size: 3, mimeType: 'video/webm', status: 'saved', hasMic: false, meetUrl: '' };
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('meetkeep', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('recordings', { keyPath: 'id' });
      request.result.createObjectStore('chunks', { keyPath: ['recordingId', 'index'] }).createIndex('recordingId', 'recordingId');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const tx = database.transaction(['recordings', 'chunks'], 'readwrite');
      tx.objectStore('recordings').put(record);
      tx.objectStore('chunks').put({ recordingId: record.id, index: 0, data: new Blob(['old']) });
      tx.oncomplete = () => { database.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  const { listRecordings, recordingBlob, putTranscript, getTranscript } = await import('../src/db');
  expect(await listRecordings()).toEqual([record]);
  expect(await (await recordingBlob(record)).text()).toBe('old');
  await putTranscript({ recordingId: record.id, language: 'en-US', engine: 'chrome-on-device', timing: 'approximate', status: 'completed', cues: [], processedMs: 1, durationMs: 1, updatedAt: 1 });
  expect((await getTranscript(record.id))?.status).toBe('completed');
});
