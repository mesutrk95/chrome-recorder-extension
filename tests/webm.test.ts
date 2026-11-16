import { describe, expect, it } from 'vitest';
import { indexWebM } from '../src/webm';

const hex = (value: string) => Uint8Array.from(value.replace(/\s/g, '').match(/../g) ?? [], byte => parseInt(byte, 16));
const ebml = hex('1a45dfa3 87 4282 84 7765626d');
const segment = hex('18538067 01ffffffffffffff');
const info = hex('1549a966 87 2ad7b1 83 0f4240');
const videoTrack = hex('ae8e d78101 838101 23e3838401fca055');
const audioTrack = hex('ae8e d78102 838102 23e3838401312d00');
function field(id: string, ...parts: Uint8Array[]) {
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) { body.set(part, at); at += part.length; }
  return new Uint8Array([...hex(id), 0x80 + body.length, ...body]);
}
const video = (time = '0000', key = '80') => field('a3', hex(`81 ${time} ${key} 1f43b675`)); // Cluster ID bytes inside a packet must be skipped.
const audio = (time = '0000') => field('a3', hex(`82 ${time} 80 aabb`));
const cluster = (...parts: Uint8Array<ArrayBuffer>[]) => new Blob([hex('1f43b675 01ffffffffffffff'), ...parts]);
function fixture(options: { audioOnly?: boolean; scale?: Uint8Array<ArrayBuffer>; incomplete?: boolean; key?: boolean } = {}) {
  return new Blob([ebml, segment, options.scale ?? info, field('1654ae6b', ...(options.audioOnly ? [] : [videoTrack]), audioTrack),
    cluster(hex('e78100'), audio(), ...(options.audioOnly ? [] : [video('0000', options.key === false ? '00' : '80'), video('0021', '00')])),
    cluster(hex('e78203e8'), audio(), ...(options.audioOnly ? [] : [video('0000', options.key === false ? '00' : '80')])),
    ...(options.incomplete ? [hex('a3 88 81')] : []),
  ], { type: 'video/webm' });
}
function occurrences(bytes: Uint8Array, pattern: Uint8Array) {
  const result: number[] = [];
  for (let i = 0; i <= bytes.length - pattern.length; i++) if (pattern.every((value, index) => bytes[i + index] === value)) result.push(i);
  return result;
}
describe('seekable WebM finalization', () => {
  it('writes a front index and accurate scaled duration without touching existing clusters', async () => {
    const source = fixture();
    const file = await indexWebM(source);
    expect(file.cueCount).toBe(2); // Video keyframes only, not every audio packet or delta frame.
    expect(file.durationMs).toBeCloseTo(1033.333333, 3);
    const old = new Uint8Array(await source.arrayBuffer());
    const prepared = new Uint8Array(await file.blob.arrayBuffer());
    const clusterId = hex('1f43b675 01ffffffffffffff');
    const start = occurrences(old, clusterId)[0];
    const newStart = occurrences(prepared, clusterId)[0];
    expect(prepared.slice(newStart)).toEqual(old.slice(start));
    expect(occurrences(prepared, hex('114d9b74'))[0]).toBeLessThan(newStart);
    expect(occurrences(prepared, hex('1c53bb6b'))[0]).toBeLessThan(newStart);
    const durationAt = occurrences(prepared, hex('448988'))[0] + 3;
    expect(new DataView(prepared.buffer).getFloat64(durationAt)).toBeCloseTo(file.durationMs, 3);
  });
  it('does not accumulate metadata or alter media if an indexed file is processed again', async () => {
    const first = await indexWebM(fixture());
    const second = await indexWebM(first.blob);
    expect(new Uint8Array(await second.blob.arrayBuffer())).toEqual(new Uint8Array(await first.blob.arrayBuffer()));
  });
  it('honors a timestamp scale other than one millisecond', async () => {
    const file = await indexWebM(fixture({ scale: hex('1549a966 88 2ad7b1 84 00989680') }));
    expect(file.durationMs).toBeCloseTo(10033.333333, 3);
    expect(file.cueCount).toBe(2);
  });
  it('indexes audio-only WebM at cluster boundaries', async () => {
    const file = await indexWebM(fixture({ audioOnly: true }));
    expect(file.cueCount).toBe(2);
    expect(file.durationMs).toBe(1020);
  });
  it('honors the final BlockDuration for a held video frame', async () => {
    const group = field('a0', field('a1', hex('81000000 deadbeef')), field('9b', hex('2328')));
    const source = new Blob([ebml, segment, info, field('1654ae6b', videoTrack), cluster(hex('e78203e8'), group)], { type: 'video/webm' });
    const file = await indexWebM(source);
    expect(file.durationMs).toBe(10000);
    expect(file.cueCount).toBe(1);
  });
  it('rejects truncated data or missing video keyframes instead of producing an invalid file', async () => {
    await expect(indexWebM(fixture({ incomplete: true }))).rejects.toThrow('ends inside an element');
    await expect(indexWebM(fixture({ key: false }))).rejects.toThrow('no complete keyframe');
    await expect(indexWebM(new Blob(['bad']))).rejects.toThrow();
  });
  it('skips large encoded packets safely across the bounded read cache', async () => {
    const payload = new Uint8Array(2 * 1024 * 1024).fill(0xa3);
    const largeBlock = new Blob([hex('a3 10200004 81000080'), payload]);
    const source = new Blob([ebml, segment, info, field('1654ae6b', videoTrack), hex('1f43b675 01ffffffffffffff e78100'), largeBlock, cluster(hex('e78203e8'), video())], { type: 'video/webm' });
    const indexed = await indexWebM(source);
    expect(indexed.cueCount).toBe(2);
    expect(indexed.blob.size - source.size).toBeLessThan(500);
    const bytes = new Uint8Array(await indexed.blob.arrayBuffer());
    const location = occurrences(bytes, hex('a3 10200004 81000080'))[0];
    const copied = bytes.slice(location + 9, location + 9 + payload.length);
    const originalHash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
    const copiedHash = new Uint8Array(await crypto.subtle.digest('SHA-256', copied));
    expect(copiedHash).toEqual(originalHash);
  });
});
