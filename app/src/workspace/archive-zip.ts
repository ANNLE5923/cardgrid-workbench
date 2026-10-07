/** Restricted ordinary ZIP: two UTF-8 JSON entries, STORE/DEFLATE, no ZIP64/encryption.
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * https://compression.spec.whatwg.org/ (raw DEFLATE, bounded stream consumption)
 */
import { V06ContractError } from './v06-validation.ts';
import type { CapacityPolicy } from './contracts-v06.ts';
import { MAX_BACKUP_BYTES, MAX_INPUT_BYTES } from './format.ts';
export const archiveCapacity: CapacityPolicy = Object.freeze({
  status: 'validated',
  maxActiveBackupBytes: MAX_BACKUP_BYTES,
  maxInputBytes: MAX_INPUT_BYTES,
  maxArchiveCompressedBytes: MAX_BACKUP_BYTES,
  maxArchiveExpandedBytes: MAX_INPUT_BYTES,
  maxArchiveEntries: 2,
  maxLoadedArchiveMonths: 1,
});
export const archiveNeed = (
  condition: unknown,
  code:
    | 'ARCHIVE_INVALID'
    | 'ARCHIVE_BUDGET_EXCEEDED'
    | 'ARCHIVE_INCOMPLETE'
    | 'ARCHIVE_CONFLICT'
    | 'ARCHIVE_MISSING'
    | 'ARCHIVE_NOT_VERIFIED',
  message: string,
): void => {
  if (!condition) throw new V06ContractError(code, '$', message);
};
export async function shaBytes(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.slice().buffer as ArrayBuffer;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of b) c = table[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const bytes = (n: number) => new Uint8Array(n),
  view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
async function bounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      length += r.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new V06ContractError('ARCHIVE_BUDGET_EXCEEDED', '$', 'ZIP 实际解压字节超过上限');
      }
      chunks.push(r.value);
    }
    const out = bytes(length);
    let offset = 0;
    for (const b of chunks) {
      out.set(b, offset);
      offset += b.length;
    }
    return out;
  } finally {
    reader.releaseLock();
  }
}
export async function encodeArchiveZip(
  input: { 'manifest.json': Uint8Array; 'records.json': Uint8Array },
  policy = archiveCapacity,
): Promise<Blob> {
  const expanded = Object.values(input).reduce((n, b) => n + b.length, 0);
  archiveNeed(
    expanded <= policy.maxArchiveExpandedBytes,
    'ARCHIVE_BUDGET_EXCEEDED',
    '归档解压容量超限',
  );
  const locals: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(input)) {
    const encoded = new TextEncoder().encode(name);
    let method = 0,
      compressed = raw;
    try {
      const stream = new CompressionStream('deflate-raw');
      const zipped = await bounded(
        new Blob([raw.slice().buffer]).stream().pipeThrough(stream),
        policy.maxArchiveCompressedBytes,
      );
      if (zipped.length < raw.length) {
        method = 8;
        compressed = zipped;
      }
    } catch (e) {
      if (e instanceof V06ContractError)
        throw e; /* A browser without raw DEFLATE still exports interoperable STORE ZIP. */
    }
    const crc = crc32(raw),
      local = bytes(30 + encoded.length),
      l = view(local);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x800, true);
    l.setUint16(8, method, true);
    l.setUint16(12, 33, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, compressed.length, true);
    l.setUint32(22, raw.length, true);
    l.setUint16(26, encoded.length, true);
    local.set(encoded, 30);
    const header = bytes(46 + encoded.length),
      c = view(header);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint16(10, method, true);
    c.setUint16(14, 33, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, compressed.length, true);
    c.setUint32(24, raw.length, true);
    c.setUint16(28, encoded.length, true);
    c.setUint32(42, offset, true);
    header.set(encoded, 46);
    locals.push(local, compressed);
    central.push(header);
    offset += local.length + compressed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0),
    end = bytes(22),
    e = view(end);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, 2, true);
  e.setUint16(10, 2, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);
  const blob = new Blob(
    [...locals, ...central, end].map((b) => b.slice().buffer as ArrayBuffer),
    { type: 'application/zip' },
  );
  archiveNeed(
    blob.size <= policy.maxArchiveCompressedBytes,
    'ARCHIVE_BUDGET_EXCEEDED',
    '归档压缩容量超限',
  );
  return blob;
}
export async function decodeArchiveZip(
  blob: Blob,
  policy = archiveCapacity,
): Promise<Record<'manifest.json' | 'records.json', Uint8Array>> {
  archiveNeed(
    blob.size <= policy.maxArchiveCompressedBytes,
    'ARCHIVE_BUDGET_EXCEEDED',
    'ZIP 压缩字节超限',
  );
  archiveNeed(blob.size >= 22, 'ARCHIVE_INVALID', 'ZIP 截断');
  const b = new Uint8Array(await blob.arrayBuffer()),
    v = view(b),
    end = b.length - 22;
  const u16 = (o: number) => {
      archiveNeed(o >= 0 && o + 2 <= b.length, 'ARCHIVE_INVALID', 'ZIP 越界');
      return v.getUint16(o, true);
    },
    u32 = (o: number) => {
      archiveNeed(o >= 0 && o + 4 <= b.length, 'ARCHIVE_INVALID', 'ZIP 越界');
      return v.getUint32(o, true);
    };
  archiveNeed(
    u32(end) === 0x06054b50 &&
      u16(end + 4) === 0 &&
      u16(end + 6) === 0 &&
      u16(end + 8) === 2 &&
      u16(end + 10) === 2 &&
      u16(end + 20) === 0 &&
      policy.maxArchiveEntries >= 2,
    'ARCHIVE_INVALID',
    '只接受无分卷、无注释的两文件普通 ZIP',
  );
  let position = u32(end + 16),
    localEnd = 0,
    total = 0;
  archiveNeed(position + u32(end + 12) === end, 'ARCHIVE_INVALID', '中央目录范围错误');
  const centralStart = position,
    result: any = {};
  for (let i = 0; i < 2; i++) {
    archiveNeed(u32(position) === 0x02014b50, 'ARCHIVE_INVALID', '中央目录签名错误');
    const flags = u16(position + 8),
      method = u16(position + 10),
      crc = u32(position + 16),
      compressed = u32(position + 20),
      expanded = u32(position + 24),
      length = u16(position + 28),
      offset = u32(position + 42);
    archiveNeed(
      flags === 0x800 &&
        (method === 0 || method === 8) &&
        u16(position + 30) === 0 &&
        u16(position + 32) === 0 &&
        u16(position + 34) === 0,
      'ARCHIVE_INVALID',
      '加密、额外字段、脚本路径或不支持的 ZIP 格式',
    );
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      b.slice(position + 46, position + 46 + length),
    );
    archiveNeed(
      ['manifest.json', 'records.json'].includes(name) && !Object.hasOwn(result, name),
      'ARCHIVE_INVALID',
      'ZIP 文件白名单或重复名称错误',
    );
    archiveNeed(
      offset === localEnd &&
        u32(offset) === 0x04034b50 &&
        u16(offset + 6) === flags &&
        u16(offset + 8) === method &&
        u32(offset + 14) === crc &&
        u32(offset + 18) === compressed &&
        u32(offset + 22) === expanded &&
        u16(offset + 26) === length &&
        u16(offset + 28) === 0,
      'ARCHIVE_INVALID',
      '本地目录与中央目录不一致',
    );
    archiveNeed(
      new TextDecoder().decode(b.slice(offset + 30, offset + 30 + length)) === name,
      'ARCHIVE_INVALID',
      'ZIP 名称不一致',
    );
    const start = offset + 30 + length;
    localEnd = start + compressed;
    archiveNeed(localEnd <= centralStart, 'ARCHIVE_INVALID', 'ZIP 记录重叠或截断');
    const limit = Math.min(
      policy.maxArchiveExpandedBytes - total,
      name === 'manifest.json' ? 1024 * 1024 : policy.maxArchiveExpandedBytes,
    );
    archiveNeed(expanded <= limit, 'ARCHIVE_BUDGET_EXCEEDED', '声明解压容量超限');
    const raw =
      method === 0
        ? b.slice(start, localEnd)
        : await bounded(
            new Blob([b.slice(start, localEnd)])
              .stream()
              .pipeThrough(new DecompressionStream('deflate-raw')),
            limit,
          );
    total += raw.length;
    archiveNeed(
      raw.length <= limit && total <= policy.maxArchiveExpandedBytes,
      'ARCHIVE_BUDGET_EXCEEDED',
      '实际解压容量超限',
    );
    archiveNeed(
      raw.length === expanded && crc32(raw) === crc,
      'ARCHIVE_INVALID',
      'ZIP 长度或 CRC32 校验失败',
    );
    result[name] = raw;
    position += 46 + length;
  }
  archiveNeed(
    position === end && localEnd === centralStart,
    'ARCHIVE_INVALID',
    'ZIP 多余或隐藏内容',
  );
  return result;
}
