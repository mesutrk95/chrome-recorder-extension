import { describe, expect, it } from 'vitest';
import { srtFilename, toSrt } from '../src/subtitles';
import type { Recording } from '../src/shared';

describe('SRT export', () => {
  it('writes numbered UTF-8 cues with millisecond timestamps and CRLF separators', () => {
    expect(toSrt([{ startMs: 59_999.6, endMs: 3_661_250, text: 'Hello, café.' }, { startMs: 3_662_000, endMs: 3_664_000, text: 'Next step.' }])).toBe('1\r\n00:01:00,000 --> 01:01:01,250\r\nHello, café.\r\n\r\n2\r\n01:01:02,000 --> 01:01:04,000\r\nNext step.\r\n');
  });
  it('skips invalid cues, sanitizes separators and prevents overlapping or negative times', () => {
    const result = toSrt([{ startMs: NaN, endMs: 100, text: 'Invalid' }, { startMs: -20, endMs: 500, text: '  Hello\n\nworld --> now ' }, { startMs: 200, endMs: 400, text: 'Later' }, { startMs: 600, endMs: 700, text: ' ' }]);
    expect(result).toBe('1\r\n00:00:00,000 --> 00:00:00,500\r\nHello world → now\r\n\r\n2\r\n00:00:00,500 --> 00:00:00,501\r\nLater\r\n');
    expect(toSrt([])).toBe('');
  });
  it('splits long speech into at most two readable lines per subtitle', () => {
    const speech = 'We are reviewing the first project milestone and discussing the next steps with the design team. Please share your feedback by Friday so we can prepare for our next meeting.';
    const blocks = toSrt([{ startMs: 1000, endMs: 16_000, text: speech }]).trim().split('\r\n\r\n');
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.flatMap(block => block.split('\r\n').slice(2)).join(' ')).toBe(speech);
    for (const block of blocks) {
      const lines = block.split('\r\n').slice(2);
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(lines.every(line => line.length <= 42)).toBe(true);
    }
    expect(blocks.at(-1)).toContain('00:00:16,000');
  });
  it('uses the video title for the English subtitle filename', () => {
    const record = { id: 'abc', title: '2026-10-21 12:30 — Meet / Team', startedAt: 1 } as Recording;
    expect(srtFilename(record)).toContain('2026-10-21 12-30');
    expect(srtFilename(record)).toMatch(/\.en\.srt$/);
    expect(srtFilename(record)).not.toContain('/');
  });
});
