import { describe, expect, it } from 'vitest';
import { duration, elapsed, filename, isMeetUrl, isRecordableTabUrl, meetCode, recordingTitle, type Recording } from '../src/shared';

describe('recording timing and filenames', () => {
  it('excludes completed and current pauses from elapsed time', () => {
    expect(elapsed({ phase: 'recording', startedAt: 1000, pausedMs: 2000 }, 7000)).toBe(4000);
    expect(elapsed({ phase: 'paused', startedAt: 1000, pausedAt: 5000, pausedMs: 1000 }, 9000)).toBe(3000);
    expect(elapsed({ phase: 'idle' }, 9000)).toBe(0);
    expect(duration(3_661_000)).toBe('01:01:01');
  });
  it('only accepts actual HTTPS Google Meet meeting URLs', () => {
    expect(isMeetUrl('https://meet.google.com/abc-defg-hij?authuser=0')).toBe(true);
    expect(isMeetUrl('https://meet.google.com/meet/abc-defg-hij')).toBe(true);
    expect(isMeetUrl('https://meet.google.com/meet/abc-defg-hij/?authuser=0')).toBe(true);
    for (const url of ['https://meet.google.com/', 'https://meet.google.com.evil.test/abc-defg-hij', 'http://meet.google.com/abc-defg-hij', 'https://meet.google.com/landing', undefined]) expect(isMeetUrl(url)).toBe(false);
    for (const url of ['https://meet.google.com/meet/', 'https://meet.google.com/meet/landing', 'https://meet.google.com/meet/abc-defg-hij/extra']) expect(isMeetUrl(url)).toBe(false);
  });
  it('recognizes the same meeting across old and new Meet routes', () => {
    expect(meetCode('https://meet.google.com/meet/abc-defg-hij')).toBe(meetCode('https://meet.google.com/abc-defg-hij?authuser=1'));
    expect(meetCode('https://meet.google.com/meet/abc-defg-hij')).not.toBe(meetCode('https://meet.google.com/meet/xyz-abcd-efg'));
  });
  it('allows ordinary website and file tabs, while excluding browser and extension pages', () => {
    for (const url of ['https://example.com/watch', 'http://localhost:3000/', 'file:///C:/Videos/demo.html', 'https://meet.google.com/']) expect(isRecordableTabUrl(url)).toBe(true);
    for (const url of ['chrome://settings', 'chrome-extension://test/library.html', 'about:blank', 'devtools://devtools/', 'javascript:alert(1)', 'invalid', undefined]) expect(isRecordableTabUrl(url)).toBe(false);
  });
  it('makes a Windows-safe download path without traversal', () => {
    const startedAt = new Date(2026, 9, 15, 9, 5).getTime();
    const path = filename({ title: '../Roadmap: Q4? <Team>', startedAt } as Recording);
    expect(path).toMatch(/^Meetkeep\/2026-10-15 09-05 — /);
    expect(path.split('/')).toHaveLength(2);
    expect(path.slice('Meetkeep/'.length)).not.toMatch(/[<>:"/\\|?*]/);
    expect(path).toMatch(/\.webm$/);
  });
  it('uses local start time and the complete tab title without duplicating the timestamp in downloads', () => {
    const startedAt = new Date(2026, 9, 15, 9, 5).getTime();
    const title = recordingTitle(startedAt, '  Meet - Team sync  ');
    expect(title).toBe('2026-10-15 09:05 — Meet - Team sync');
    expect(filename({ title, startedAt } as Recording)).toBe('Meetkeep/2026-10-15 09-05 — Meet - Team sync.webm');
  });
});
