import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { appendChunk, deleteRecording, getTranscript, listRecordings, putRecording, putTranscript, recordingBlob, recordingFile } from '../src/db';
import type { Recording, Transcript } from '../src/shared';

describe('durable local recordings', () => {
  it('assembles chunks in order, survives metadata edits, and deletes just the selected recording', async () => {
    const first: Recording = { id: 'one', title: 'Planning', meetUrl: 'https://meet.google.com/abc-defg-hij', startedAt: 1, duration: 3000, size: 2, mimeType: 'video/webm', status: 'recording', hasMic: false };
    const second = { ...first, id: 'two', startedAt: 2, title: 'Keep me' };
    await putRecording(first); await putRecording(second);
    await appendChunk(first, 1, new Blob(['B']));
    await appendChunk(first, 0, new Blob(['A']));
    await appendChunk(second, 0, new Blob(['C']));
    expect(await (await recordingBlob(first)).text()).toBe('AB');
    const transcript: Transcript = { recordingId: first.id, language: 'en-US', engine: 'chrome-on-device', timing: 'approximate', status: 'completed', cues: [{ startMs: 0, endMs: 2000, text: 'Hello team.' }], processedMs: 3000, durationMs: 3000, updatedAt: 1 };
    await putTranscript(transcript);
    await putRecording({ ...first, title: 'Renamed', status: 'saved' });
    expect((await listRecordings()).find(record => record.id === first.id)?.title).toBe('Renamed');
    expect(await getTranscript(first.id)).toEqual(transcript);
    const recovered = await recordingFile(first);
    expect(recovered.warning).toContain('original video is saved');
    expect(await recovered.blob.text()).toBe('AB'); // Failed indexing must keep the original data downloadable.
    expect(recovered.recording.webmIndexed).toBeUndefined();
    await deleteRecording(first.id);
    expect(await getTranscript(first.id)).toBeUndefined();
    await putTranscript(transcript); // An in-flight job must not restore subtitles for a deleted video.
    expect(await getTranscript(first.id)).toBeUndefined();
    expect((await listRecordings()).map(record => record.id)).toEqual(['two']);
    expect(await (await recordingBlob(second)).text()).toBe('C');
    await expect(recordingBlob(first)).rejects.toThrow('no saved video');
    await deleteRecording(second.id);
  });
});
