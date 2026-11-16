import { defaults, type Overview, type Result, type Settings } from './shared';

export const inExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
export async function request<T = undefined>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
  if (!inExtension) {
    const settings: Settings = { ...defaults, ...JSON.parse(localStorage.getItem('meetkeep-settings') ?? '{}') };
    if (type === 'OVERVIEW') return { session: { phase: 'idle' }, settings } as T;
    if (type === 'SETTINGS') { const next = { ...settings, ...(fields.settings as Partial<Settings>) }; localStorage.setItem('meetkeep-settings', JSON.stringify(next)); return next as T; }
    throw new Error('Load the built extension in Chrome to record a meeting.');
  }
  const response: Result<T> = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error ?? 'Meetkeep did not respond. Reload the extension and try again.');
  return response.data;
}
export const initialOverview: Overview = { session: { phase: 'idle' }, settings: defaults };
export function openPage(path: string) {
  if (inExtension) chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  else window.open(`/${path}`, '_blank', 'noopener');
}
