import { errorMessage, type Recording, type Transcript } from './shared';
import { indexWebM } from './webm';

interface Chunk { recordingId: string; index: number; data: Blob }
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('meetkeep', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('recordings')) request.result.createObjectStore('recordings', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('chunks')) request.result.createObjectStore('chunks', { keyPath: ['recordingId', 'index'] }).createIndex('recordingId', 'recordingId');
      if (!request.result.objectStoreNames.contains('transcripts')) request.result.createObjectStore('transcripts', { keyPath: 'recordingId' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Could not save to local storage.')); });
}
export async function putRecording(recording: Recording) {
  const tx = (await db()).transaction('recordings', 'readwrite');
  const done = complete(tx);
  tx.objectStore('recordings').put(recording);
  await done;
}
export async function listRecordings(): Promise<Recording[]> {
  const tx = (await db()).transaction('recordings', 'readonly');
  return (await result<Recording[]>(tx.objectStore('recordings').getAll())).sort((a, b) => b.startedAt - a.startedAt);
}
export async function appendChunk(recording: Recording, index: number, data: Blob) {
  const tx = (await db()).transaction(['recordings', 'chunks'], 'readwrite');
  const done = complete(tx);
  tx.objectStore('chunks').add({ recordingId: recording.id, index, data } satisfies Chunk);
  tx.objectStore('recordings').put(recording);
  await done;
}
export interface RecordingFile { blob: Blob; recording: Recording; warning?: string }
const filesInProgress = new Map<string, Promise<RecordingFile>>();
async function prepareFile(recording: Recording): Promise<RecordingFile> {
  const tx = (await db()).transaction(['recordings', 'chunks'], 'readonly');
  const [chunks, current] = await Promise.all([
    result<Chunk[]>(tx.objectStore('chunks').index('recordingId').getAll(recording.id)),
    result<Recording | undefined>(tx.objectStore('recordings').get(recording.id)),
  ]);
  if (!chunks.length || !current) throw new Error('This recording has no saved video yet.');
  const blob = new Blob(chunks.sort((a, b) => a.index - b.index).map(c => c.data), { type: current.mimeType });
  if (current.webmIndexed === 1 || !current.mimeType.startsWith('video/webm') || current.status === 'recording') return { blob, recording: current };
  let indexed;
  try { indexed = await indexWebM(blob); }
  catch (error) {
    // Incomplete/recovered files must remain downloadable even if not indexable.
    return { blob, recording: current, warning: `The original video is saved, but its playback index could not be prepared: ${errorMessage(error)} Players may need time to scan it.` };
  }
  try {
    // Replace chunks and metadata together. A failed/quota-limited transaction
    // leaves the original chunks intact; do not resurrect deleted recordings or
    // overwrite a name edited in another library tab while indexing was running.
    const save = (await db()).transaction(['recordings', 'chunks'], 'readwrite');
    const done = complete(save);
    const request = save.objectStore('recordings').get(current.id);
    let saved = current;
    request.onsuccess = () => {
      const latest: Recording | undefined = request.result;
      if (!latest || latest.status === 'recording' || latest.size !== current.size || latest.webmIndexed === 1) return;
      const cursor = save.objectStore('chunks').index('recordingId').openKeyCursor(IDBKeyRange.only(current.id));
      cursor.onsuccess = () => {
        if (cursor.result) { save.objectStore('chunks').delete(cursor.result.primaryKey); cursor.result.continue(); }
        else {
          saved = { ...latest, size: indexed.blob.size, duration: Math.round(indexed.durationMs), webmIndexed: 1 };
          save.objectStore('chunks').put({ recordingId: latest.id, index: 0, data: indexed.blob } satisfies Chunk);
          save.objectStore('recordings').put(saved);
        }
      };
    };
    await done;
    return { blob: indexed.blob, recording: saved };
  } catch (error) {
    return { blob: indexed.blob, recording: current, warning: `The video is ready to play or download, but Chrome could not keep its playback index for next time: ${errorMessage(error)} The original recording is still saved.` };
  }
}
export function recordingFile(recording: Recording): Promise<RecordingFile> {
  const pending = filesInProgress.get(recording.id);
  if (pending) return pending;
  const file = prepareFile(recording).finally(() => filesInProgress.delete(recording.id));
  filesInProgress.set(recording.id, file);
  return file;
}
export async function recordingBlob(recording: Recording): Promise<Blob> {
  return (await recordingFile(recording)).blob;
}
export async function deleteRecording(id: string) {
  const tx = (await db()).transaction(['recordings', 'chunks', 'transcripts'], 'readwrite');
  const done = complete(tx);
  tx.objectStore('recordings').delete(id);
  tx.objectStore('transcripts').delete(id);
  const request = tx.objectStore('chunks').index('recordingId').openKeyCursor(IDBKeyRange.only(id));
  request.onsuccess = () => { const cursor = request.result; if (cursor) { tx.objectStore('chunks').delete(cursor.primaryKey); cursor.continue(); } };
  await done;
}
export async function getTranscript(recordingId: string): Promise<Transcript | undefined> {
  const tx = (await db()).transaction('transcripts', 'readonly');
  return result(tx.objectStore('transcripts').get(recordingId));
}
export async function putTranscript(transcript: Transcript) {
  const tx = (await db()).transaction(['recordings', 'transcripts'], 'readwrite');
  const done = complete(tx);
  const exists = tx.objectStore('recordings').getKey(transcript.recordingId);
  exists.onsuccess = () => { if (exists.result !== undefined) tx.objectStore('transcripts').put(transcript); };
  await done;
}
