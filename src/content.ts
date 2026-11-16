import { detectJoined, MeetingDebouncer } from './detection';
import { defaults, duration, elapsed, errorMessage, isMeetUrl, meetCode, type Result, type Session, type Settings } from './shared';

const detector = new MeetingDebouncer();
let preferences: Settings = defaults;
let current: Session = { phase: 'idle' };
let tabId: number | undefined;
let busy = false;
let error = '';
let previous = '';
let ticks = 0;
let recorder: MediaRecorder | undefined;
let recordingId: string | undefined;
let activeUrl = '';
let seenJoined = false;
let finished = Promise.resolve();
const host = document.createElement('div');
host.id = 'meetkeep-control';
host.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;display:none;';
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = `
:host{all:initial}button{box-sizing:border-box;display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid #5f6368;border-radius:50%;color:#e8eaed;background:#292a2d;box-shadow:0 2px 6px #0003;cursor:pointer}button:hover{background:#35363a}button:focus-visible{outline:2px solid #8ab4f8;outline-offset:2px}button:disabled{cursor:default;opacity:.65}.dot{width:8px;height:8px;box-sizing:border-box;border:1.5px solid #9aa0a6;border-radius:50%}.recording .dot{background:#f36962;border-color:#f36962;border-radius:2px}.paused .dot{border-radius:1px;border-left:3px solid #fdd663;border-right:3px solid #fdd663;border-top:0;border-bottom:0}.busy .dot{background:none;border:1.5px solid #9aa0a6;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite}.error{position:absolute;left:0;bottom:36px;box-sizing:border-box;width:270px;font:400 11px/1.6 system-ui,sans-serif;color:#f7c6c2;background:#3c2525;border:1px solid #814d48;border-radius:9px;padding:8px 11px}.error:empty{display:none}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.busy .dot{animation:none}}
`;
const button = document.createElement('button');
button.type = 'button';
const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
const feedback = document.createElement('div'); feedback.className = 'error'; feedback.setAttribute('role', 'alert');
button.append(dot);
shadow.append(style, button, feedback);
document.documentElement.append(host);
function render() {
  host.style.display = isMeetUrl(location.href) ? 'block' : 'none';
  const own = current.tabId === tabId && current.phase !== 'idle';
  const elsewhere = current.phase !== 'idle' && !own;
  const phase = own ? current.phase : 'idle';
  const working = busy || phase === 'arming' || phase === 'armed' || phase === 'saving';
  button.className = `${phase}${working ? ' busy' : ''}`;
  button.disabled = busy || tabId === undefined || elsewhere || phase === 'arming' || phase === 'saving';
  const action = phase === 'recording' ? 'Stop and save recording' : phase === 'paused' ? 'Resume recording' : 'Start recording this meeting';
  button.setAttribute('aria-label', action);
  button.setAttribute('aria-pressed', String(phase === 'recording' || phase === 'paused'));
  button.setAttribute('aria-busy', String(working));
  button.title = elsewhere ? 'Stop the other recording before recording this meeting.' : working ? recorder ? 'Saving recording…' : 'Choose this Meet tab and share its audio.' : phase === 'idle' ? 'Start recording this Meet tab' : `${action} · ${duration(elapsed(current))}`;
  feedback.textContent = error;
}
function meeting() { return { joined: detector.joined, title: document.title.trim() || 'Google Meet', url: location.href }; }
async function call<T = undefined>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
  const response: Result<T> = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error ?? 'Meetkeep did not respond.');
  return response.data;
}
function encode(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const data = String(reader.result); resolve(data.slice(data.lastIndexOf(',') + 1)); };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function startRecording() {
  busy = true; error = ''; render();
  let display: MediaStream | undefined;
  let mic: MediaStream | undefined;
  let audio: AudioContext | undefined;
  let combined: MediaStream | undefined;
  let session: Session | undefined;
  async function cleanup() {
    combined?.getTracks().forEach(track => track.stop());
    display?.getTracks().forEach(track => track.stop());
    mic?.getTracks().forEach(track => track.stop());
    await audio?.close().catch(() => {});
  }
  try {
    // Must run directly from this button's click, before any awaited messaging.
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: { ideal: 30 }, width: { ideal: preferences.quality === 'high' ? 1920 : 1280 }, height: { ideal: preferences.quality === 'high' ? 1080 : 720 } },
      audio: { suppressLocalAudioPlayback: false }, preferCurrentTab: true,
      selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude',
    } as DisplayMediaStreamOptions);
    const surface = display.getVideoTracks()[0]?.getSettings().displaySurface;
    if (surface && surface !== 'browser') throw new Error('Select the Meet browser tab in Chrome’s sharing chooser.');
    if (!display.getAudioTracks().length) throw new Error('Select this Meet tab and turn on “Share tab audio” to record the meeting sound.');
    audio = new AudioContext();
    await Promise.race([audio.resume(), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (audio.state !== 'running') throw new Error('Chrome could not start recording audio. Please try the record button again.');
    const destination = audio.createMediaStreamDestination();
    audio.createMediaStreamSource(display).connect(destination);
    if (preferences.includeMic) {
      try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
      catch { throw new Error('Allow microphone access for Meet, or turn off Include my microphone in Meetkeep’s preferences.'); }
      audio.createMediaStreamSource(mic).connect(destination);
    }
    combined = new MediaStream([...display.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This Chrome version does not support WebM recording.');
    const next = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: preferences.quality === 'high' ? 4_000_000 : 1_800_000, audioBitsPerSecond: 128_000 });
    session = await call<Session>('PAGE_BEGIN', { title: meeting().title, mimeType });
    const id = session.recordingId!;
    recordingId = id; activeUrl = location.href; seenJoined = detector.joined;
    recorder = next; current = session;
    let queue = Promise.resolve();
    let index = 0;
    let failure: string | undefined;
    let resolveFinished!: () => void;
    finished = new Promise(resolve => { resolveFinished = resolve; });
    next.ondataavailable = event => {
      if (!event.data.size || failure) return;
      const chunkIndex = index++;
      queue = queue.then(async () => {
        if (failure) return;
        await call('PAGE_CHUNK', { id, index: chunkIndex, data: await encode(event.data) });
      }).catch(problem => { failure = `Recording stopped while saving: ${errorMessage(problem)}`; if (next.state !== 'inactive') next.stop(); });
    };
    next.onerror = () => { failure = 'Chrome interrupted recording. The saved portion is available in the library.'; if (next.state !== 'inactive') next.stop(); };
    next.onstop = () => {
      (async () => {
        await queue;
        try { await cleanup(); current = await call<Session>('PAGE_END', { id, error: failure }); }
        catch (problem) { error = errorMessage(problem); }
        finally {
          await cleanup();
          if (recorder === next) { recorder = undefined; recordingId = undefined; }
          if (failure) error = failure;
          busy = false; render(); resolveFinished();
        }
      })().catch(console.error);
    };
    display.getVideoTracks()[0].addEventListener('ended', () => { stopRecording().catch(() => {}); }, { once: true });
    if (display.getVideoTracks()[0].readyState === 'ended') throw new Error('Tab sharing ended before recording could start.');
    next.start(3000);
  } catch (problem) {
    await cleanup();
    if (session?.recordingId) await call('PAGE_END', { id: session.recordingId, error: errorMessage(problem) }).catch(() => {});
    recorder = undefined; recordingId = undefined; finished = Promise.resolve();
    if (!(problem instanceof DOMException && (problem.name === 'NotAllowedError' || problem.name === 'AbortError'))) error = errorMessage(problem);
  } finally { busy = false; render(); }
}
async function stopRecording() {
  if (recorder?.state !== 'inactive') recorder?.stop();
  await finished;
}
async function control(action: string): Promise<Session> {
  if (!recorder || !recordingId) throw new Error('There is no page recording to control.');
  if (action === 'STOP') { busy = true; render(); await stopRecording(); return current; }
  if (action === 'PAUSE' && recorder.state === 'recording') { recorder.pause(); current = await call<Session>('PAGE_PAUSE', { id: recordingId }); render(); return current; }
  if (action === 'RESUME' && recorder.state === 'paused') { recorder.resume(); current = await call<Session>('PAGE_RESUME', { id: recordingId }); render(); return current; }
  throw new Error('That recording action is not available.');
}
button.addEventListener('click', () => {
  if (button.disabled) return;
  if (current.phase === 'idle') { startRecording().catch(problem => { error = errorMessage(problem); render(); }); return; }
  const action = current.phase === 'paused' ? 'RESUME' : 'STOP';
  const task = recorder ? control(action) : call<Session>('PAGE_ACTION', { action });
  task.then(session => { current = session; render(); }).catch(problem => { busy = false; error = errorMessage(problem); render(); });
});
function poll() {
  if (!chrome.runtime?.id) { clearInterval(interval); clearInterval(clock); host.remove(); stopRecording().catch(() => {}); return; }
  detector.update(isMeetUrl(location.href) && detectJoined(document));
  const state = meeting();
  if (state.joined && recorder) seenJoined = true;
  if (recorder && ((!state.joined && seenJoined) || meetCode(activeUrl) !== meetCode(location.href))) stopRecording().catch(() => {});
  const serialized = JSON.stringify(state);
  if (serialized !== previous || ++ticks % 5 === 0) {
    previous = serialized;
    call<Session>('MEET_STATE', { state }).then(session => { current = session; render(); }).catch(() => {});
  }
  render();
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'GET_MEET_STATE') { respond(meeting()); return; }
  if (message.type === 'SESSION') { current = message.session; render(); return; }
  if (message.type === 'PAGE_CONTROL') {
    control(message.action).then(data => respond({ ok: true, data }), problem => respond({ ok: false, error: errorMessage(problem) }));
    return true;
  }
});
call<{ session: Session; settings: Settings; tabId: number }>('PAGE_CONTEXT').then(context => { current = context.session; preferences = context.settings; tabId = context.tabId; render(); }).catch(problem => { error = errorMessage(problem); render(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) { preferences = { ...defaults, ...(changes.settings.newValue as Partial<Settings>) }; }
});
window.addEventListener('pagehide', () => { stopRecording().catch(() => {}); });
const interval = setInterval(poll, 2000);
const clock = setInterval(render, 1000);
poll();
