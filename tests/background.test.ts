import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let handler: (message: unknown, sender: unknown, respond: (value: any) => void) => void;
let changed: (id: number, change: { url?: string; status?: string }) => void;
let removed: (id: number) => void;
let current: any;
let recorderExists: boolean;
let pageConnected: boolean;
let api: any;
const tab = { id: 17, url: 'https://meet.google.com/meet/abc-defg-hij', title: 'Meet - Team sync' };
const sender = { id: 'test', url: 'chrome-extension://test/popup.html' };
const send = (message: unknown) => new Promise<any>(resolve => handler(message, sender, resolve));

beforeEach(async () => {
  vi.resetModules();
  tab.url = 'https://meet.google.com/meet/abc-defg-hij'; tab.title = 'Meet - Team sync';
  current = { phase: 'idle' }; recorderExists = false; pageConnected = false;
  api = {
    runtime: {
      id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: vi.fn(async () => recorderExists ? [{}] : []),
      onMessage: { addListener: (value: typeof handler) => { handler = value; } },
      onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() },
      sendMessage: vi.fn(async (message: any) => {
        if (message.type === 'ARM') current = { phase: 'armed', source: 'tab', tabId: message.tabId, meetUrl: message.meetUrl, title: message.title, warning: message.warning };
        if (message.type === 'BEGIN') current = { ...current, phase: 'recording', recordingId: 'test-video' };
        if (message.type === 'STOP') current = { phase: 'idle' };
        return { ok: true, data: current };
      }),
    },
    offscreen: { Reason: { USER_MEDIA: 'USER_MEDIA', BLOBS: 'BLOBS' }, createDocument: vi.fn(async () => { recorderExists = true; }) },
    tabs: {
      query: vi.fn(async () => [tab]),
      sendMessage: vi.fn(async () => { if (!pageConnected) throw new Error('Could not establish connection. Receiving end does not exist.'); return { title: tab.title, url: tab.url, joined: true }; }),
      onRemoved: { addListener: (value: typeof removed) => { removed = value; } }, onUpdated: { addListener: (value: typeof changed) => { changed = value; } },
    },
    tabCapture: { getMediaStreamId: vi.fn(async () => 'user-invoked-tab-stream') },
    storage: { local: { get: vi.fn(async () => ({})) }, session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    downloads: { onChanged: { addListener: vi.fn() } },
  };
  api.runtime.ContextType = { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' };
  vi.stubGlobal('chrome', api);
  await import('../src/background');
});
afterEach(() => { vi.unstubAllGlobals(); });

it('shows a /meet/code meeting in the popup even when its page control is disconnected', async () => {
  const result = await send({ type: 'OVERVIEW' });
  expect(result.ok).toBe(true);
  expect(result.data.tab).toMatchObject({ id: tab.id, url: tab.url, title: tab.title });
});
it('starts manual popup recording without forcing a refresh of an ongoing call', async () => {
  const result = await send({ type: 'ARM', tabId: tab.id });
  expect(result.ok).toBe(true);
  expect(result.data.phase).toBe('recording');
  expect(api.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: tab.id });
  expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ARM', joined: false, meetUrl: tab.url, warning: expect.stringContaining('after your call') }));
  expect(api.storage.session.set).toHaveBeenCalledWith({ watchJoined: false });
});
it('keeps normal page detection when the corner control is connected', async () => {
  pageConnected = true;
  const result = await send({ type: 'ARM', tabId: tab.id });
  expect(result.ok).toBe(true);
  expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ARM', joined: true, warning: undefined }));
  expect(api.storage.session.set).toHaveBeenCalledWith({ watchJoined: true });
});
it('keeps recording across a route alias change and stops for a different meeting', async () => {
  pageConnected = true;
  await send({ type: 'ARM', tabId: tab.id });
  api.runtime.sendMessage.mockClear();
  changed(tab.id, { url: 'https://meet.google.com/abc-defg-hij' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(api.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'STOP', target: 'recorder' });
  changed(tab.id, { url: 'https://meet.google.com/meet/xyz-abcd-efg' });
  await vi.waitFor(() => expect(api.runtime.sendMessage).toHaveBeenCalledWith({ type: 'STOP', target: 'recorder' }));
});
it('offers and records a non-Meet tab without contacting a meeting page script', async () => {
  tab.url = 'https://example.test/watch'; tab.title = 'Demo video';
  expect((await send({ type: 'OVERVIEW' })).data.tab).toMatchObject({ id: tab.id, title: tab.title, url: tab.url });
  const result = await send({ type: 'ARM', tabId: tab.id });
  expect(result.ok).toBe(true);
  expect(result.data.phase).toBe('recording');
  expect(result.data.warning).toBeUndefined();
  expect(api.tabs.sendMessage).not.toHaveBeenCalled();
  expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ARM', title: 'Demo video', meetUrl: tab.url, joined: false }));
});
it('keeps a generic tab recording through navigation/reload and saves when that tab closes', async () => {
  tab.url = 'https://example.test/watch';
  await send({ type: 'ARM', tabId: tab.id });
  api.runtime.sendMessage.mockClear();
  changed(tab.id, { url: 'https://other.test/page', status: 'loading' });
  changed(tab.id, { status: 'loading' });
  removed(999);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(api.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'STOP', target: 'recorder' });
  removed(tab.id);
  await vi.waitFor(() => expect(api.runtime.sendMessage).toHaveBeenCalledWith({ type: 'STOP', target: 'recorder' }));
});
it('refuses protected pages and a tab that is no longer the active target', async () => {
  tab.url = 'chrome://settings';
  expect((await send({ type: 'OVERVIEW' })).data.tab).toBeUndefined();
  expect((await send({ type: 'ARM', tabId: tab.id })).ok).toBe(false);
  tab.url = 'https://example.test/watch';
  expect((await send({ type: 'ARM', tabId: 999 })).ok).toBe(false);
  expect(api.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
});
