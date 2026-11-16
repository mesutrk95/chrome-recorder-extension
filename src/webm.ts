// Finalize our MediaRecorder WebM files without decoding or rewriting media packets.
// Cues/SeekHead positions are relative to the Segment payload, not the file start.
// https://www.webmproject.org/docs/container/#muxer-and-demuxer-guidelines
const ID = {
  ebml: 0x1a45dfa3, segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b,
  cluster: 0x1f43b675, cues: 0x1c53bb6b, seekHead: 0x114d9b74,
  scale: 0x2ad7b1, duration: 0x4489, crc: 0xbf, entry: 0xae,
  track: 0xd7, type: 0x83, defaultDuration: 0x23e383, time: 0xe7,
  simpleBlock: 0xa3, blockGroup: 0xa0, block: 0xa1, reference: 0xfb,
};
type Element = { id: number; start: number; data: number; end: number; unknown: boolean };
type Cue = { time: number; track: number; cluster: number; relative: number };
type Track = { number: number; type: number; defaultNs: number; last?: number; gap?: number; lastDuration?: number; end?: number };
export interface IndexedWebM { blob: Blob; durationMs: number; cueCount: number }

function vint(bytes: Uint8Array, offset: number, keepMarker = false) {
  const first = bytes[offset];
  if (!first) throw new Error('Invalid WebM element header.');
  let length = 1, marker = 0x80;
  while (!(first & marker)) { length++; marker >>= 1; }
  if (length > (keepMarker ? 4 : 8) || offset + length > bytes.length) throw new Error('Incomplete WebM element header.');
  let value = keepMarker ? first : first & (marker - 1);
  let unknown = !keepMarker && value === marker - 1;
  for (let i = 1; i < length; i++) { value = value * 256 + bytes[offset + i]; unknown &&= bytes[offset + i] === 255; }
  if (!unknown && !Number.isSafeInteger(value)) throw new Error('WebM element is too large.');
  return { value, length, unknown };
}
function uint(bytes: Uint8Array) {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  if (!Number.isSafeInteger(value)) throw new Error('WebM integer is too large.');
  return value;
}
function integer(value: number, length?: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid WebM index position.');
  const result = new Uint8Array(length ?? Math.max(1, Math.ceil(Math.log2(value + 1) / 8)));
  for (let i = result.length - 1; i >= 0; i--) { result[i] = value % 256; value = Math.floor(value / 256); }
  if (value) throw new Error('WebM index position overflow.');
  return result;
}
function size(value: number) {
  let length = 1;
  while (value >= 2 ** (7 * length) - 1) length++;
  if (length > 8) throw new Error('WebM file is too large.');
  const result = integer(value, length);
  result[0] |= 1 << (8 - length);
  return result;
}
function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function element(id: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const data = join(parts);
  return join([integer(id), size(data.length), data]);
}
function number(id: number, value: number, length?: number) { return element(id, integer(value, length)); }
function duration(value: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return element(ID.duration, bytes);
}

class Reader {
  private cache = new Uint8Array(0);
  private offset = 0;
  constructor(readonly blob: Blob) {}
  async bytes(offset: number, count: number): Promise<Uint8Array> {
    if (offset < 0 || offset + count > this.blob.size) throw new Error('The saved WebM is incomplete.');
    if (offset < this.offset || offset + count > this.offset + this.cache.length) {
      // Bounded read cache: long meetings never become a full-file ArrayBuffer.
      this.offset = offset;
      this.cache = new Uint8Array(await this.blob.slice(offset, offset + Math.max(count, 1024 * 1024)).arrayBuffer());
    }
    return this.cache.subarray(offset - this.offset, offset - this.offset + count);
  }
  async header(start: number, limit: number): Promise<Element> {
    const bytes = await this.bytes(start, Math.min(12, limit - start));
    const id = vint(bytes, 0, true);
    const length = vint(bytes, id.length);
    const data = start + id.length + length.length;
    const end = length.unknown ? limit : data + length.value;
    if (end > limit || end < data) throw new Error('The saved WebM ends inside an element.');
    return { id: id.value, start, data, end, unknown: length.unknown };
  }
  async children(parent: Element): Promise<Element[]> {
    const children: Element[] = [];
    for (let at = parent.data; at < parent.end;) {
      const child = await this.header(at, parent.end);
      if (child.unknown) throw new Error('Unexpected unknown-sized WebM metadata.');
      children.push(child); at = child.end;
    }
    return children;
  }
  async unsigned(field: Element) {
    if (field.end - field.data > 8) throw new Error('Invalid WebM integer.');
    return uint(await this.bytes(field.data, field.end - field.data));
  }
  slice(field: Element) { return this.blob.slice(field.start, field.end); }
}

export async function indexWebM(blob: Blob): Promise<IndexedWebM> {
  const reader = new Reader(blob);
  const ebml = await reader.header(0, blob.size);
  if (ebml.id !== ID.ebml || ebml.unknown) throw new Error('This recording is not a supported WebM file.');
  const segment = await reader.header(ebml.end, blob.size);
  if (segment.id !== ID.segment) throw new Error('The recording has no WebM segment.');
  let info: Element | undefined;
  let tracksElement: Element | undefined;
  let scale = 1_000_000;
  const tracks = new Map<number, Track>();
  const metadata: Element[] = [];
  const clusters: Element[] = [];
  const cues: Cue[] = [];
  let videoTrack: number | undefined;
  let audioTrack: number | undefined;
  let lastYield = performance.now();
  async function block(field: Element, cluster: Element, timestamp: number, keyframe: boolean | undefined, relative: number, blockDuration?: number) {
    const data = await reader.bytes(field.data, Math.min(12, field.end - field.data));
    const trackNumber = vint(data, 0);
    if (data.length < trackNumber.length + 3) throw new Error('Incomplete WebM media block.');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const time = timestamp + view.getInt16(trackNumber.length);
    const flags = data[trackNumber.length + 2];
    const track = tracks.get(trackNumber.value);
    if (track && time >= 0) {
      if (track.last !== undefined && time > track.last) track.gap = Math.min(track.gap ?? Infinity, time - track.last);
      if (blockDuration !== undefined) track.end = Math.max(track.end ?? 0, time + blockDuration);
      if (time >= (track.last ?? 0)) track.lastDuration = blockDuration;
      track.last = Math.max(track.last ?? 0, time);
    }
    const primary = videoTrack ?? audioTrack;
    if (time >= 0 && trackNumber.value === primary && (videoTrack ? keyframe ?? !!(flags & 0x80) : !cues.length || cues.at(-1)!.cluster !== cluster.start)) {
      cues.push({ time, track: trackNumber.value, cluster: cluster.start, relative });
    }
  }
  async function clusterAt(cluster: Element) {
    let timestamp = 0;
    let at = cluster.data;
    while (at < cluster.end) {
      const child = await reader.header(at, cluster.end);
      // Chrome writes unknown-sized live Clusters. A level-one sibling closes one.
      if ([ID.cluster, ID.cues, ID.info, ID.tracks, ID.seekHead, 0x1254c367, 0x1941a469, 0x1043a770].includes(child.id)) break;
      if (child.unknown) throw new Error('Unexpected unknown-sized WebM cluster child.');
      if (child.id === ID.time) timestamp = await reader.unsigned(child);
      if (child.id === ID.simpleBlock) await block(child, cluster, timestamp, undefined, child.start - cluster.data);
      if (child.id === ID.blockGroup) {
        const fields = await reader.children(child);
        const media = fields.find(field => field.id === ID.block);
        const length = fields.find(field => field.id === 0x9b);
        if (media) await block(media, cluster, timestamp, !fields.some(field => field.id === ID.reference), child.start - cluster.data, length ? await reader.unsigned(length) : undefined);
      }
      at = child.end;
      if (performance.now() - lastYield > 16) { await new Promise(resolve => setTimeout(resolve, 0)); lastYield = performance.now(); }
    }
    if (!cluster.unknown && at !== cluster.end) throw new Error('Invalid WebM cluster boundary.');
    cluster.end = at;
  }
  for (let at = segment.data; at < segment.end;) {
    const field = await reader.header(at, segment.end);
    if (field.id === ID.info) {
      info = field;
      const timeScale = (await reader.children(field)).find(child => child.id === ID.scale);
      if (timeScale) scale = await reader.unsigned(timeScale);
      if (!scale) throw new Error('Invalid WebM timestamp scale.');
    } else if (field.id === ID.tracks) {
      tracksElement = field;
      for (const entry of (await reader.children(field)).filter(child => child.id === ID.entry)) {
        const track: Track = { number: 0, type: 0, defaultNs: 0 };
        for (const child of await reader.children(entry)) {
          if (child.id === ID.track) track.number = await reader.unsigned(child);
          if (child.id === ID.type) track.type = await reader.unsigned(child);
          if (child.id === ID.defaultDuration) track.defaultNs = await reader.unsigned(child);
        }
        tracks.set(track.number, track);
        if (track.type === 1) videoTrack ??= track.number;
        if (track.type === 2) audioTrack ??= track.number;
      }
    } else if (field.id === ID.cluster) {
      if (!info || !tracksElement) throw new Error('WebM track metadata must precede media.');
      await clusterAt(field); clusters.push(field);
    } else if (![ID.seekHead, ID.cues, ID.crc].includes(field.id)) {
      if (field.unknown) throw new Error('Unsupported WebM metadata size.');
      metadata.push(field);
    }
    at = field.end;
  }
  if (!info || !tracksElement || !clusters.length || !cues.length) throw new Error('The recording has no complete keyframe to index.');
  let endTicks = 0;
  for (const track of tracks.values()) {
    if (track.last === undefined) continue;
    const estimate = Math.min(track.gap ?? (track.type === 2 ? 20 : 1000 / 30) * 1_000_000 / scale, (track.type === 2 ? 120 : 1000 / 30) * 1_000_000 / scale);
    const tail = track.lastDuration ?? (track.defaultNs ? track.defaultNs / scale : estimate);
    endTicks = Math.max(endTicks, track.end ?? 0, track.last + tail);
  }
  const durationMs = endTicks * scale / 1_000_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('The recording has no valid media duration.');
  const infoParts = (await reader.children(info)).filter(child => child.id !== ID.duration && child.id !== ID.crc);
  const newInfo = new Blob([integer(ID.info), size(infoParts.reduce((sum, child) => sum + child.end - child.start, 0) + duration(endTicks).length), ...infoParts.map(child => reader.slice(child)), duration(endTicks)]);
  const headerParts = [newInfo, reader.slice(tracksElement), ...metadata.map(field => reader.slice(field))];
  const headerSize = headerParts.reduce((sum, part) => sum + part.size, 0);
  // Fixed-width offsets keep the index length stable when relocating media.
  function makeCues(mediaOffset: number) {
    const positions = new Map<number, number>();
    let at = mediaOffset;
    for (const cluster of clusters) { positions.set(cluster.start, at); at += cluster.end - cluster.start; }
    return element(ID.cues, ...cues.map(cue => element(0xbb,
      number(0xb3, cue.time), element(0xb7, number(0xf7, cue.track), number(0xf1, positions.get(cue.cluster)!, 8), number(0xf0, cue.relative, 8)),
    )));
  }
  function seekHead(cuesPosition: number, infoPosition: number, tracksPosition: number) {
    return element(ID.seekHead, ...[[ID.info, infoPosition], [ID.tracks, tracksPosition], [ID.cues, cuesPosition]].map(([id, position]) => element(0x4dbb, element(0x53ab, integer(id)), number(0x53ac, position, 8))));
  }
  const seekLength = seekHead(0, 0, 0).length;
  const cuesPosition = seekLength + headerSize;
  const cuesLength = makeCues(0).length;
  const index = makeCues(cuesPosition + cuesLength);
  const seek = seekHead(cuesPosition, seekLength, seekLength + newInfo.size);
  const mediaParts = clusters.map(cluster => reader.slice(cluster));
  const segmentLength = seek.length + headerSize + index.length + mediaParts.reduce((sum, part) => sum + part.size, 0);
  return { blob: new Blob([reader.slice(ebml), integer(ID.segment), size(segmentLength), seek, ...headerParts, index, ...mediaParts], { type: blob.type }), durationMs, cueCount: cues.length };
}
