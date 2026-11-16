export interface Settings {
  autoDownload: boolean;
  includeMic: boolean;
  quality: 'standard' | 'high';
}
export const defaults: Settings = { autoDownload: true, includeMic: false, quality: 'standard' };
export type Phase = 'idle' | 'arming' | 'armed' | 'recording' | 'paused' | 'saving';
export interface Session {
  source?: 'tab' | 'page';
  phase: Phase;
  tabId?: number;
  title?: string;
  meetUrl?: string;
  recordingId?: string;
  startedAt?: number;
  pausedAt?: number;
  pausedMs?: number;
  error?: string;
  warning?: string;
}
export interface Recording {
  webmIndexed?: 1;
  source?: 'tab' | 'meet';
  id: string;
  title: string;
  meetUrl: string;
  startedAt: number;
  endedAt?: number;
  duration: number;
  size: number;
  mimeType: string;
  status: 'recording' | 'saved' | 'interrupted';
  hasMic: boolean;
}
export interface SubtitleCue { startMs: number; endMs: number; text: string }
export interface Transcript {
  recordingId: string;
  language: 'en-US';
  engine: 'chrome-on-device';
  timing: 'approximate';
  status: 'partial' | 'completed';
  cues: SubtitleCue[];
  processedMs: number;
  durationMs: number;
  updatedAt: number;
}
export interface MeetState { joined: boolean; title: string; url: string }
export interface Overview { session: Session; settings: Settings; tab?: { id: number; title: string; url: string; joined: boolean } }
export type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
export type RecorderCommand =
  | { target: 'recorder'; type: 'IMPORT_BEGIN'; tabId: number; title: string; meetUrl: string; settings: Settings; mimeType: string }
  | { target: 'recorder'; type: 'IMPORT_CHUNK'; id: string; index: number; data: string }
  | { target: 'recorder'; type: 'IMPORT_END'; id: string; error?: string }
  | { target: 'recorder'; type: 'ARM'; streamId: string; tabId: number; title: string; meetUrl: string; settings: Settings; joined: boolean; warning?: string }
  | { target: 'recorder'; type: 'BEGIN'; title?: string }
  | { target: 'recorder'; type: 'STOP' | 'PAUSE' | 'RESUME' | 'STATUS' }
  | { target: 'recorder'; type: 'RELEASE_URL'; url: string };

export function meetCode(url: string | undefined): string | undefined {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://meet.google.com') return;
    return /^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/.exec(parsed.pathname)?.[1];
  } catch { return; }
}
export function isMeetUrl(url: string | undefined): boolean {
  return meetCode(url) !== undefined;
}
export function isRecordableTabUrl(url: string | undefined): boolean {
  if (!url) return false;
  try { return ['https:', 'http:', 'file:'].includes(new URL(url).protocol); }
  catch { return false; }
}
export function elapsed(session: Session, now = Date.now()): number {
  return session.startedAt ? Math.max(0, (session.pausedAt ?? now) - session.startedAt - (session.pausedMs ?? 0)) : 0;
}
export function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export function bytes(size: number): string { return size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GB` : `${(size / 1024 ** 2).toFixed(1)} MB`; }
function recordingDateTime(startedAt: number): string {
  const date = new Date(startedAt);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function recordingTitle(startedAt: number, tabTitle: string): string {
  return `${recordingDateTime(startedAt)} — ${tabTitle.trim() || 'Browser tab'}`;
}
export function filename(record: Recording): string {
  const name = record.title.startsWith(`${recordingDateTime(record.startedAt)} — `) ? record.title : recordingTitle(record.startedAt, record.title);
  const title = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').slice(0, 140).replace(/[. ]+$/g, '');
  return `Meetkeep/${title}.webm`;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
