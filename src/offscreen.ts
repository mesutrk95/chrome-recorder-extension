import { appendChunk, putRecording, recordingFile } from './db';
import { elapsed, errorMessage, recordingTitle, type Recording, type RecorderCommand, type Session, type Settings } from './shared';

let state: Session = { phase: 'idle' };
let prefs: Settings;
let tabStream: MediaStream | undefined;
let micStream: MediaStream | undefined;
let audio: AudioContext | undefined;
let media: MediaStream | undefined;
let recorder: MediaRecorder | undefined;
let record: Recording | undefined;
let savedRecord: Recording | undefined;
let imported = false;
let writes = Promise.resolve();
let index = 0;
let failure: string | undefined;
let stopResolve: (() => void) | undefined;
let stopped: Promise<void> | undefined;
const downloadUrls = new Set<string>();

async function publish(patch: Partial<Session>) {
  state = { ...state, ...patch };
  await chrome.runtime.sendMessage({ type: 'RECORDER_STATE', session: state });
}
async function cleanup() {
  tabStream?.getTracks().forEach(track => track.stop());
  micStream?.getTracks().forEach(track => track.stop());
  media?.getTracks().forEach(track => track.stop());
  await audio?.close().catch(() => {});
  tabStream = micStream = media = undefined;
  audio = undefined;
  recorder = undefined;
}
async function finish() {
  await publish({ phase: 'saving' });
  await writes;
  const completed = record ? { ...(savedRecord ?? record), duration: failure ? (savedRecord?.duration ?? 0) : elapsed(state), size: savedRecord?.size ?? 0, endedAt: Date.now(), status: failure ? 'interrupted' as const : 'saved' as const } : undefined;
  let warning: string | undefined;
  try {
    if (completed) {
      await putRecording(completed);
      await cleanup();
      // Finalize once, even when automatic downloads are disabled.
      const file = completed.size > 0 ? await recordingFile(completed) : undefined;
      warning = file?.warning;
      if (prefs.autoDownload && file) {
        const url = URL.createObjectURL(file.blob);
        downloadUrls.add(url);
        try {
          const response = await chrome.runtime.sendMessage({ type: 'DOWNLOAD', url, recording: file.recording });
          if (!response?.ok) throw new Error(response?.error ?? 'Download did not start.');
        } catch {
          URL.revokeObjectURL(url);
          downloadUrls.delete(url);
          warning = [warning, 'Automatic download failed. Your recording is still in the library; download it there.'].filter(Boolean).join(' ');
        }
      }
    }
  } catch (error) { failure = `Could not finish saving: ${errorMessage(error)}. Open the library to recover saved chunks.`; }
  finally {
    await cleanup();
    imported = false;
    record = undefined;
    state = { phase: 'idle', error: failure, warning };
    await publish({});
    stopResolve?.();
    stopResolve = undefined;
  }
}
async function arm(message: Extract<RecorderCommand, { type: 'ARM' }>) {
  if (state.phase !== 'idle') throw new Error('Another tab is already being prepared.');
  prefs = message.settings;
  failure = undefined;
  await publish({ phase: 'arming', source: 'tab', tabId: message.tabId, title: message.title, meetUrl: message.meetUrl, error: undefined, warning: message.warning });
  try {
    const capture = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } } as unknown as MediaTrackConstraints;
    tabStream = await navigator.mediaDevices.getUserMedia({ audio: capture, video: { ...capture, mandatory: { ...((capture as any).mandatory), maxWidth: prefs.quality === 'high' ? 1920 : 1280, maxHeight: prefs.quality === 'high' ? 1080 : 720, maxFrameRate: 30 } } as MediaTrackConstraints });
    audio = new AudioContext();
    await audio.resume();
    const mix = audio.createMediaStreamDestination();
    if (tabStream.getAudioTracks().length) {
      const source = audio.createMediaStreamSource(tabStream);
      source.connect(audio.destination); // Tab capture otherwise silences the tab for the user.
      source.connect(mix);
    }
    if (prefs.includeMic) {
      try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
      catch { throw new Error('Microphone access is needed. Open Microphone setup in the library, allow access, then arm this tab again.'); }
      audio.createMediaStreamSource(micStream).connect(mix);
    }
    media = new MediaStream([...tabStream.getVideoTracks(), ...mix.stream.getAudioTracks()]);
    tabStream.getVideoTracks().forEach(track => track.addEventListener('ended', () => { stop().catch(console.error); }));
    await publish({ phase: 'armed' });
  } catch (error) {
    await cleanup();
    state = { phase: 'idle', error: errorMessage(error) };
    await publish({});
    throw error;
  }
}
async function begin(tabTitle = state.title ?? 'Browser tab') {
  if (state.phase !== 'armed' || !media) throw new Error('Select a tab to record first.');
  const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('This Chrome version does not support WebM recording.');
  const startedAt = Date.now();
  record = { id: crypto.randomUUID(), source: 'tab', title: recordingTitle(startedAt, tabTitle), meetUrl: state.meetUrl!, startedAt, duration: 0, size: 0, mimeType, status: 'recording', hasMic: prefs.includeMic };
  await putRecording(record);
  savedRecord = undefined;
  index = 0;
  writes = Promise.resolve();
  recorder = new MediaRecorder(media, { mimeType, videoBitsPerSecond: prefs.quality === 'high' ? 4_000_000 : 1_800_000, audioBitsPerSecond: 128_000 });
  stopped = new Promise(resolve => { stopResolve = resolve; });
  recorder.ondataavailable = event => {
    if (!event.data.size || !record || failure) return;
    const chunkIndex = index++;
    const chunkRecord = { ...record, size: record.size + event.data.size, duration: elapsed(state) };
    record = chunkRecord;
    writes = writes.then(async () => {
      if (failure) return;
      await appendChunk(chunkRecord, chunkIndex, event.data);
      savedRecord = chunkRecord;
    }).catch(error => {
      failure = `Local saving stopped: ${errorMessage(error)}. Free some disk space. Saved chunks can be recovered in the library.`;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    });
  };
  recorder.onerror = () => { failure = 'Chrome interrupted the recorder. Recover the saved portion from the library.'; if (recorder?.state !== 'inactive') recorder?.stop(); };
  recorder.onstop = () => { finish().catch(console.error); };
  recorder.start(3000);
  await publish({ phase: 'recording', title: tabTitle, recordingId: record.id, startedAt, pausedAt: undefined, pausedMs: 0 });
}
async function stop() {
  if (state.phase === 'idle') return;
  if (imported) {
    failure = 'The meeting tab closed before its final video chunk arrived. The saved portion is available in the library.';
    await finish();
    return;
  }
  if (recorder) {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
  } else {
    await cleanup();
    state = { phase: 'idle' };
    await publish({});
  }
}
async function handle(message: RecorderCommand) {
  switch (message.type) {
    case 'IMPORT_BEGIN': {
      if (state.phase !== 'idle') throw new Error('Another meeting is already being recorded.');
      const startedAt = Date.now();
      prefs = message.settings; failure = undefined; savedRecord = undefined; index = 0;
      writes = Promise.resolve();
      record = { id: crypto.randomUUID(), source: 'tab', title: recordingTitle(startedAt, message.title), meetUrl: message.meetUrl, startedAt, duration: 0, size: 0, mimeType: message.mimeType, status: 'recording', hasMic: prefs.includeMic };
      await putRecording(record);
      imported = true;
      state = { phase: 'recording', source: 'page', tabId: message.tabId, title: message.title, meetUrl: message.meetUrl, recordingId: record.id, startedAt, pausedMs: 0 };
      await publish({});
      break;
    }
    case 'IMPORT_CHUNK': {
      if (!imported || !record || record.id !== message.id) throw new Error('The page recording is no longer active.');
      if (message.index !== index) throw new Error('A recording chunk arrived out of order.');
      const binary = atob(message.data);
      const chunk = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) chunk[i] = binary.charCodeAt(i);
      const data = new Blob([chunk], { type: record.mimeType });
      const next = { ...record, size: record.size + data.size, duration: elapsed(state) };
      await appendChunk(next, index, data);
      index++; record = next; savedRecord = next;
      break;
    }
    case 'IMPORT_END':
      if (!imported || !record || record.id !== message.id) throw new Error('The page recording is no longer active.');
      if (message.error) failure = message.error;
      await finish();
      break;
    case 'ARM': await arm(message); break;
    case 'BEGIN': await begin(message.title); break;
    case 'STOP': await stop(); break;
    case 'PAUSE':
      if (imported) {
        if (state.phase !== 'recording') throw new Error('There is no running recording to pause.');
        await publish({ phase: 'paused', pausedAt: Date.now() }); break;
      }
      if (recorder?.state !== 'recording') throw new Error('There is no running recording to pause.');
      recorder.pause(); await publish({ phase: 'paused', pausedAt: Date.now() }); break;
    case 'RESUME':
      if (imported) {
        if (state.phase !== 'paused') throw new Error('There is no paused recording to resume.');
        await publish({ phase: 'recording', pausedMs: (state.pausedMs ?? 0) + Date.now() - state.pausedAt!, pausedAt: undefined }); break;
      }
      if (recorder?.state !== 'paused') throw new Error('There is no paused recording to resume.');
      recorder.resume(); await publish({ phase: 'recording', pausedMs: (state.pausedMs ?? 0) + Date.now() - state.pausedAt!, pausedAt: undefined }); break;
    case 'RELEASE_URL':
      if (downloadUrls.has(message.url)) { URL.revokeObjectURL(message.url); downloadUrls.delete(message.url); } break;
  }
  return state;
}
let commands = Promise.resolve();
chrome.runtime.onMessage.addListener((message: RecorderCommand, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'recorder') return;
  if (message.type === 'STATUS') { respond({ ok: true, data: state }); return; }
  if (message.type === 'RELEASE_URL') {
    if (downloadUrls.has(message.url)) { URL.revokeObjectURL(message.url); downloadUrls.delete(message.url); }
    respond({ ok: true, data: state }); return;
  }
  commands = commands.then(async () => {
    try { respond({ ok: true, data: await handle(message) }); }
    catch (error) { respond({ ok: false, error: errorMessage(error) }); }
  });
  return true;
});
