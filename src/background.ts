import { defaults, errorMessage, filename, isMeetUrl, isRecordableTabUrl, meetCode, type MeetState, type Overview, type RecorderCommand, type Result, type Session, type Settings } from './shared';

let creating: Promise<void> | undefined;
let arming = false;
async function hasRecorder() {
  return (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [chrome.runtime.getURL('offscreen.html')] })).length > 0;
}
async function ensureRecorder() {
  if (await hasRecorder()) return;
  if (!creating) creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.BLOBS], justification: 'Record a user-selected browser tab, persist video chunks locally, and prepare downloads.' }).finally(() => { creating = undefined; });
  await creating;
}
async function command(message: RecorderCommand): Promise<Session> {
  const response: Result<Session> = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'The recorder did not respond. Try reloading the extension.');
  return response.data;
}
async function session(): Promise<Session> {
  return await hasRecorder() ? command({ target: 'recorder', type: 'STATUS' }) : { phase: 'idle' };
}
async function settings(): Promise<Settings> {
  const saved = (await chrome.storage.local.get('settings')).settings as Partial<Settings> | undefined;
  return { autoDownload: saved?.autoDownload ?? defaults.autoDownload, includeMic: saved?.includeMic ?? defaults.includeMic, quality: saved?.quality === 'high' ? 'high' : 'standard' };
}
async function updateSession(value: Session) {
  await chrome.storage.session.set({ session: value });
  const badge = { idle: '', arming: '…', armed: 'ON', recording: 'REC', paused: 'Ⅱ', saving: '…' }[value.phase];
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color: value.phase === 'recording' ? '#dc5044' : '#286953' });
  for (const tab of await chrome.tabs.query({ url: 'https://meet.google.com/*' })) {
    if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'SESSION', session: value }).catch(() => {});
  }
}
async function overview(): Promise<Overview> {
  const [current, prefs, tabs] = await Promise.all([session(), settings(), chrome.tabs.query({ active: true, currentWindow: true })]);
  const tab = tabs[0];
  let meeting: MeetState | undefined;
  if (tab?.id && isMeetUrl(tab.url)) {
    try { meeting = await chrome.tabs.sendMessage(tab.id, { type: 'GET_MEET_STATE' }); } catch { /* A pre-install Meet tab needs a refresh. */ }
  }
  return { session: current, settings: prefs, tab: tab?.id && isRecordableTabUrl(tab.url) ? { id: tab.id, title: meeting?.title ?? tab.title ?? 'Browser tab', url: tab.url!, joined: meeting?.joined ?? false } : undefined };
}
async function arm(tabId: number) {
  if (arming) throw new Error('A recording is already being prepared.');
  arming = true;
  try {
    const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (active?.id !== tabId || !isRecordableTabUrl(active.url)) throw new Error('Open the extension from the website tab you want to record. Chrome’s internal and extension pages cannot be recorded.');
    if ((await session()).phase !== 'idle') throw new Error('Stop the current recording before recording another tab.');
    const prefs = await settings();
    await ensureRecorder();
    let meeting: MeetState = { title: active.title ?? 'Browser tab', url: active.url!, joined: false };
    let warning: string | undefined;
    if (isMeetUrl(active.url)) {
      try { meeting = await chrome.tabs.sendMessage(tabId, { type: 'GET_MEET_STATE' }); }
      catch {
        // An extension update may disconnect scripts in already-open Meet tabs.
        // Toolbar capture only needs the invoked tab; never force a call reload.
        warning = 'The corner button is not connected in this tab. Use this popup to stop recording. Refresh the Meet tab after your call to restore the button and automatic stop when leaving.';
      }
    }
    await chrome.storage.session.set({ watchJoined: meeting.joined });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await command({ target: 'recorder', type: 'ARM', streamId, tabId, title: meeting.title, meetUrl: active.url!, settings: prefs, joined: meeting.joined, warning });
    return await command({ target: 'recorder', type: 'BEGIN', title: meeting.title });
  } finally { arming = false; }
}
async function handle(message: any, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) throw new Error('Untrusted request.');
  const fromRecorder = sender.url === chrome.runtime.getURL('offscreen.html');
  const fromUI = sender.url?.startsWith(chrome.runtime.getURL('')) && !fromRecorder;
  if (message.type === 'RECORDER_STATE' && fromRecorder) { await updateSession(message.session); return; }
  if (message.type === 'DOWNLOAD' && fromRecorder) {
    if (!message.url.startsWith(`blob:${chrome.runtime.getURL('')}`)) throw new Error('Invalid recording URL.');
    const id = await chrome.downloads.download({ url: message.url, filename: filename(message.recording), saveAs: false, conflictAction: 'uniquify' });
    await chrome.storage.session.set({ [`download:${id}`]: message.url });
    // Completion can race the storage write for a small recording.
    const [item] = await chrome.downloads.search({ id });
    if (item && item.state !== 'in_progress') await releaseDownload(id);
    return;
  }
  const fromMeet = sender.tab?.id !== undefined && isMeetUrl(sender.url);
  if (message.type === 'PAGE_CONTEXT' && fromMeet) return { session: await session(), settings: await settings(), tabId: sender.tab!.id };
  if (message.type === 'PAGE_ACTION' && fromMeet) {
    const current = await session();
    if (current.tabId !== sender.tab!.id || !['STOP', 'PAUSE', 'RESUME'].includes(message.action)) throw new Error('There is no recording for this meeting.');
    if (current.source === 'page') throw new Error('Refresh this Meet tab if its recording control is unavailable.');
    return command({ target: 'recorder', type: message.action });
  }
  if (message.type === 'PAGE_BEGIN' && fromMeet) {
    if (arming) throw new Error('Another meeting is being prepared.');
    arming = true;
    try {
      const prefs = await settings();
      if ((await session()).phase !== 'idle') throw new Error('Another meeting is already being recorded.');
      if (!['video/webm;codecs=vp8,opus', 'video/webm'].includes(message.mimeType)) throw new Error('Unsupported recording format.');
      await ensureRecorder();
      return await command({ target: 'recorder', type: 'IMPORT_BEGIN', tabId: sender.tab!.id!, title: sender.tab!.title ?? message.title ?? 'Google Meet', meetUrl: sender.url!, settings: prefs, mimeType: message.mimeType });
    } finally { arming = false; }
  }
  if (message.type === 'PAGE_ERROR' && fromMeet) {
    if ((await session()).phase === 'idle') await updateSession({ phase: 'idle', error: String(message.error).slice(0, 500) });
    return;
  }
  if (['PAGE_CHUNK', 'PAGE_END', 'PAGE_PAUSE', 'PAGE_RESUME'].includes(message.type) && fromMeet) {
    const current = await session();
    if (current.source !== 'page' || current.tabId !== sender.tab!.id || current.recordingId !== message.id) throw new Error('This meeting is no longer being recorded.');
    if (message.type === 'PAGE_CHUNK') {
      if (!Number.isSafeInteger(message.index) || message.index < 0 || typeof message.data !== 'string' || message.data.length > 40_000_000) throw new Error('Invalid recording chunk.');
      return command({ target: 'recorder', type: 'IMPORT_CHUNK', id: message.id, index: message.index, data: message.data });
    }
    if (message.type === 'PAGE_END') return command({ target: 'recorder', type: 'IMPORT_END', id: message.id, error: typeof message.error === 'string' ? message.error.slice(0, 500) : undefined });
    return command({ target: 'recorder', type: message.type === 'PAGE_PAUSE' ? 'PAUSE' : 'RESUME' });
  }
  if (message.type === 'MEET_STATE' && sender.tab?.id && isMeetUrl(sender.url)) {
    const current = await session();
    if (current.source === 'page' || !isMeetUrl(current.meetUrl)) return current;
    if (current.tabId !== sender.tab.id || !['armed', 'recording', 'paused'].includes(current.phase)) return current;
    if (message.state.joined) {
      await chrome.storage.session.set({ watchJoined: true });
    } else if ((await chrome.storage.session.get('watchJoined')).watchJoined) {
      await command({ target: 'recorder', type: 'STOP' });
    }
    return session();
  }
  if (!fromUI) throw new Error('This action must come from the extension.');
  switch (message.type) {
    case 'OVERVIEW': return overview();
    case 'ARM': return arm(message.tabId);
    case 'BEGIN': {
      const current = await session();
      if (!current.tabId) throw new Error('There is no active recording.');
      const tab = await chrome.tabs.get(current.tabId);
      return command({ target: 'recorder', type: 'BEGIN', title: tab.title });
    }
    case 'STOP': case 'PAUSE': case 'RESUME': {
      const current = await session();
      if (current.source === 'page' && current.tabId) {
        const response: Result<Session> = await chrome.tabs.sendMessage(current.tabId, { type: 'PAGE_CONTROL', action: message.type });
        if (!response?.ok) throw new Error(response?.error ?? 'The meeting recorder did not respond.');
        return response.data;
      }
      if (!await hasRecorder()) throw new Error('There is no active recording.');
      return command({ target: 'recorder', type: message.type });
    }
    case 'SETTINGS': {
      if ((await session()).phase !== 'idle') throw new Error('Stop or disarm the current meeting before changing recording preferences.');
      const patch = message.settings as Partial<Settings>;
      const next = { ...await settings() };
      for (const key of ['autoDownload', 'includeMic'] as const) if (typeof patch[key] === 'boolean') next[key] = patch[key]!;
      if (patch.quality === 'standard' || patch.quality === 'high') next.quality = patch.quality;
      await chrome.storage.local.set({ settings: next });
      return next;
    }
    default: throw new Error('Unknown action.');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || message.target === 'recorder' || message.type === 'SESSION' || message.type === 'GET_MEET_STATE') return;
  handle(message, sender).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: errorMessage(error) }));
  return true;
});
async function releaseDownload(id: number) {
  const key = `download:${id}`;
  const url = (await chrome.storage.session.get(key))[key];
  if (url && await hasRecorder()) await chrome.runtime.sendMessage({ target: 'recorder', type: 'RELEASE_URL', url });
  await chrome.storage.session.remove(key);
}
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') releaseDownload(delta.id).catch(console.error);
});
async function stopForTab(tabId: number, change?: { url?: string; loading?: boolean }) {
  const current = await session();
  if (current.tabId === tabId && current.phase !== 'idle') {
    if (change) {
      // A normal tab recording follows the tab through navigation/reloads. Only
      // Meet recordings stop when navigating away from their original meeting.
      if (current.source === 'tab' && !isMeetUrl(current.meetUrl)) return;
      if (change.url && isMeetUrl(change.url) && meetCode(change.url) === meetCode(current.meetUrl)) return;
    }
    if (current.source === 'page') {
      // Give an orderly pagehide/leave flush a moment to finish before recovering.
      await new Promise(resolve => setTimeout(resolve, 750));
      if ((await session()).recordingId !== current.recordingId) return;
    }
    await command({ target: 'recorder', type: 'STOP' });
  }
}
chrome.tabs.onRemoved.addListener(id => { stopForTab(id).catch(console.error); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url || change.status === 'loading') stopForTab(id, { url: change.url, loading: change.status === 'loading' }).catch(console.error);
});
chrome.runtime.onInstalled.addListener(async details => {
  await chrome.storage.local.set({ settings: await settings() });
  if (details.reason === 'install') await chrome.tabs.create({ url: 'library.html?welcome=1' });
});
chrome.runtime.onStartup.addListener(() => { updateSession({ phase: 'idle' }).catch(console.error); });
