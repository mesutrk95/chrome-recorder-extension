import { putTranscript, recordingBlob } from './db';
import { type Recording, type SubtitleCue, type Transcript } from './shared';

export type SpeechAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';
interface NativeResult { isFinal: boolean; [index: number]: { transcript: string } }
interface ResultEvent { resultIndex: number; results: { length: number; [index: number]: NativeResult } }
interface NativeRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: ResultEvent) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  start(track: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}
interface RecognitionConstructor {
  new(): NativeRecognition;
  prototype: NativeRecognition;
  available(options: { langs: string[]; processLocally: true }): Promise<SpeechAvailability>;
  install(options: { langs: string[]; processLocally: true }): Promise<boolean>;
}
const english = { langs: ['en-US'], processLocally: true as const };
function constructor(): RecognitionConstructor | undefined {
  // Unprefixed SpeechRecognition plus local APIs require a newer desktop Chrome.
  // Never use the old microphone-only API or silently fall back to a cloud service.
  const speech = (window as unknown as { SpeechRecognition?: RecognitionConstructor }).SpeechRecognition;
  if (!speech || typeof speech.available !== 'function' || typeof speech.install !== 'function' || !('processLocally' in speech.prototype)) return;
  return speech;
}
export async function englishAvailability(): Promise<SpeechAvailability> {
  const Speech = constructor();
  if (!Speech) return 'unavailable';
  return Speech.available(english);
}
export async function installEnglish(): Promise<boolean> {
  const Speech = constructor();
  if (!Speech) throw new Error('Update desktop Google Chrome to use its built-in on-device speech recognition.');
  // Some Chrome builds miss the install completion callback. Check readiness too,
  // and never leave the panel spinning forever if Chrome's component download stalls.
  const installation = Speech.install(english);
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (value?: boolean, error?: unknown) => {
      if (settled) return;
      settled = true; clearInterval(poll); clearTimeout(timeout);
      if (error) reject(error); else resolve(!!value);
    };
    const poll = setInterval(() => { Speech.available(english).then(value => { if (value === 'available') finish(true); }).catch(() => {}); }, 2000);
    const timeout = setTimeout(() => finish(false, new Error('Chrome has not finished the English pack download. Update Chrome and try again. If it keeps stalling, enable English Live Caption in Chrome’s Accessibility settings, then return here.')), 120_000);
    installation.then(value => finish(value), error => finish(false, error));
  });
}
export interface SpeechProgress {
  phase: 'loading' | 'transcribing' | 'finishing';
  processedMs: number;
  durationMs: number;
  cues: SubtitleCue[];
}
export async function transcribeRecording(recording: Recording, signal: AbortSignal, onProgress: (value: SpeechProgress) => void): Promise<Transcript> {
  const NativeSpeech = constructor();
  if (!NativeSpeech) throw new Error('This Chrome version does not support local transcription of saved audio.');
  const Speech = NativeSpeech;
  // Resume from the user's click before awaiting IndexedDB or media loading.
  const context = new AudioContext();
  const resumed = context.resume().catch(() => {});
  const media = document.createElement('audio');
  media.preload = 'auto';
  let url: string | undefined;
  let track: MediaStreamTrack | undefined;
  let recognition: NativeRecognition | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const cues: SubtitleCue[] = [];
  let total = Math.max(0, recording.duration);
  let phase: SpeechProgress['phase'] = 'loading';
  let speechStart: number | undefined;
  let speechEnd: number | undefined;
  let reachedEnd = false;
  let recognizing = false;
  let settled = false;
  let writes = Promise.resolve();
  let lastRestart = -1;
  let stalledRestarts = 0;
  const position = () => Math.max(0, Math.round(media.currentTime * 1000));
  const snapshot = (status: Transcript['status']): Transcript => ({ recordingId: recording.id, language: 'en-US', engine: 'chrome-on-device', timing: 'approximate', status, cues: [...cues], processedMs: position(), durationMs: total, updatedAt: Date.now() });
  const emit = () => onProgress({ phase, cues: [...cues], processedMs: position(), durationMs: total });
  let complete!: (status: Transcript['status'], error?: Error) => Promise<void>;
  const cancel = () => { complete?.('partial').catch(() => {}); };
  try {
    if (signal.aborted) throw new DOMException('Transcription canceled.', 'AbortError');
    const available = await Speech.available(english);
    if (available !== 'available') throw new Error('Download Chrome’s English language pack before transcribing.');
    emit();
    url = URL.createObjectURL(await recordingBlob(recording));
    media.src = url;
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        media.onloadeddata = () => resolve();
        media.onerror = () => reject(new Error('Chrome could not decode the recording’s audio.'));
        if (signal.aborted) reject(new DOMException('Transcription canceled.', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('Transcription canceled.', 'AbortError')), { once: true });
      }),
      new Promise<never>((_, reject) => { finishTimer = setTimeout(() => reject(new Error('The recording took too long to load. Try downloading and checking the video.')), 20_000); }),
    ]);
    clearTimeout(finishTimer);
    if (signal.aborted) throw new DOMException('Transcription canceled.', 'AbortError');
    if (Number.isFinite(media.duration) && media.duration > 0) total = Math.round(media.duration * 1000);
    await Promise.race([resumed, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (context.state !== 'running') throw new Error('Chrome paused audio processing. Click Transcribe again.');
    const source = context.createMediaElementSource(media);
    const destination = context.createMediaStreamDestination();
    source.connect(destination); // Feed the saved audio to recognition, never to speakers or a microphone.
    track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('The recording has no audio track to transcribe.');
    return await new Promise<Transcript>((resolve, reject) => {
      complete = async (status, error) => {
        if (settled) return;
        settled = true;
        clearInterval(progressTimer); clearTimeout(finishTimer); clearTimeout(restartTimer); clearTimeout(startTimer);
        media.pause();
        recognition?.abort();
        const value = snapshot(status);
        try {
          await writes;
          // Do not erase an existing transcript when startup failed before any audio was processed.
          if (cues.length || status === 'completed') await putTranscript(value);
          if (error) reject(error); else resolve(value);
        } catch (problem) { reject(problem); }
      };
      const fail = (message: string) => { complete('partial', new Error(message)).catch(reject); };
      function start() {
        if (settled) return;
        if (signal.aborted) { complete('partial').catch(reject); return; }
        if (reachedEnd) { complete('completed').catch(reject); return; }
        const next = new Speech();
        recognition = next;
        next.lang = 'en-US'; next.continuous = true; next.interimResults = true; next.processLocally = true;
        next.onspeechstart = () => { speechStart = position(); speechEnd = undefined; };
        next.onspeechend = () => { speechEnd = position(); };
        next.onresult = event => {
          if (settled) return;
          for (let index = event.resultIndex; index < event.results.length; index++) {
            const result = event.results[index];
            if (!result.isFinal) { speechStart ??= position(); continue; }
            const text = result[0]?.transcript.trim();
            if (!text) continue;
            const end = speechEnd ?? position();
            const start = Math.max(cues.at(-1)?.endMs ?? 0, speechStart ?? Math.max(0, end - text.split(/\s+/).length * 350));
            cues.push({ startMs: start, endMs: Math.max(start + 1, end), text });
            speechStart = speechEnd = undefined;
            const partial = snapshot('partial');
            writes = writes.then(() => putTranscript(partial));
            writes.catch(() => fail('Chrome could not save the transcript locally.'));
          }
          emit();
        };
        next.onerror = event => {
          if (settled || event.error === 'no-speech' || event.error === 'aborted') return;
          const messages: Record<string, string> = {
            'language-not-supported': 'Chrome’s English speech pack is unavailable. Download it again or update Chrome.',
            'audio-capture': 'Chrome could not read the saved audio track. Update Chrome and try again.',
            'not-allowed': 'Chrome blocked its on-device speech service. Check your browser settings.',
            'service-not-allowed': 'On-device speech recognition is not available in this Chrome installation.',
            network: 'Chrome’s local speech service could not start. No cloud fallback was used.',
          };
          fail(messages[event.error] ?? `Chrome speech recognition stopped (${event.error}). A partial transcript was kept if any speech was recognized.`);
        };
        next.onstart = () => {
          if (settled) return;
          clearTimeout(startTimer);
          recognizing = true;
          phase = 'transcribing'; emit();
          media.play().catch(() => fail('Chrome blocked playback of the saved audio. Click Transcribe again.'));
        };
        next.onend = () => {
          if (settled) return;
          clearTimeout(startTimer);
          recognizing = false;
          if (reachedEnd) { complete('completed').catch(reject); return; }
          media.pause();
          const now = position();
          stalledRestarts = now - lastRestart < 200 ? stalledRestarts + 1 : 0;
          lastRestart = now;
          if (stalledRestarts > 3) { fail('Chrome stopped speech recognition repeatedly. Your partial transcript is saved; try again.'); return; }
          restartTimer = setTimeout(start, 150);
        };
        startTimer = setTimeout(() => fail('Chrome’s speech service took too long to start. Try again.'), 15_000);
        try { next.start(track!); }
        catch { fail('Chrome could not start recognition from the saved audio. Update desktop Chrome and try again.'); }
      }
      media.onended = () => {
        reachedEnd = true; phase = 'finishing'; emit();
        if (!recognizing) { complete('completed').catch(reject); return; }
        finishTimer = setTimeout(() => fail('Chrome did not finish the last audio segment. The partial transcript is saved.'), 10_000);
        try { recognition?.stop(); } catch { fail('Chrome could not finish the last audio segment. The partial transcript is saved.'); }
      };
      media.onerror = () => fail('Chrome could not finish playing the recording’s audio. The partial transcript is saved.');
      signal.addEventListener('abort', cancel, { once: true });
      progressTimer = setInterval(emit, 500);
      start();
    });
  } finally {
    settled = true;
    signal.removeEventListener('abort', cancel);
    clearInterval(progressTimer); clearTimeout(finishTimer); clearTimeout(restartTimer); clearTimeout(startTimer);
    media.pause(); recognition?.abort(); track?.stop();
    media.removeAttribute('src'); media.load();
    if (url) URL.revokeObjectURL(url);
    await context.close().catch(() => {});
  }
}
