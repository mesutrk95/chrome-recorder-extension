import { filename, type Recording, type SubtitleCue } from './shared';

function timestamp(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(value / 3_600_000))}:${pad(Math.floor(value / 60_000) % 60)}:${pad(Math.floor(value / 1000) % 60)},${pad(value % 1000, 3)}`;
}
function lines(text: string): string[] {
  const result: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!result.length || result.at(-1)!.length + word.length + 1 > 42) result.push(word);
    else result[result.length - 1] += ` ${word}`;
  }
  return result;
}
export function toSrt(cues: SubtitleCue[]): string {
  const blocks: string[] = [];
  let previousEnd = 0;
  for (const cue of cues) {
    const text = cue.text.replace(/[\u0000-\u001f]+/g, ' ').replace(/-->/g, '→').trim();
    if (!text || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)) continue;
    const wrapped = lines(text);
    const start = Math.max(0, previousEnd, Math.round(cue.startMs));
    const end = Math.max(start + 1, Math.round(cue.endMs));
    const count = Math.ceil(wrapped.length / 2);
    for (let i = 0; i < count; i++) {
      const from = Math.max(previousEnd, start + Math.floor((end - start) * i / count));
      const to = Math.max(from + 1, start + Math.floor((end - start) * (i + 1) / count));
      blocks.push(`${blocks.length + 1}\r\n${timestamp(from)} --> ${timestamp(to)}\r\n${wrapped.slice(i * 2, i * 2 + 2).join('\r\n')}`);
      previousEnd = to;
    }
  }
  return blocks.length ? `${blocks.join('\r\n\r\n')}\r\n` : '';
}
export function srtFilename(recording: Recording): string {
  return filename(recording).split('/').pop()!.replace(/\.webm$/i, '.en.srt');
}
