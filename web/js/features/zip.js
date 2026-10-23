// Minimal ZIP writer: STORE method (no compression), CRC32, UTF-8 names.
// Images are already compressed, so storing them is as small as deflating
// and much faster. No ZIP64: one archive holds up to 65,535 files and 4 GB.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// CRC-32 (IEEE 802.3), as used by ZIP and PNG. Pass the previous result as
// `crc` to continue over several chunks.
export function crc32(bytes, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const UTF8_FLAG = 0x0800;
const VERSION = 20;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const enc = new TextEncoder();

// Date -> MS-DOS time and date words (local time, 2 s resolution, 1980..2107).
export function dosDateTime(date = new Date()) {
  let d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  if (d.getFullYear() < 1980) d = new Date(1980, 0, 1);
  if (d.getFullYear() > 2107) d = new Date(2107, 11, 31, 23, 59, 58);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { time, date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

// Keep names portable: forward slashes, no absolute paths or "..", and no
// characters Windows refuses in file names.
export function zipEntryName(name) {
  const parts = String(name ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim())
    .filter((p) => p && p !== "." && p !== "..");
  return parts.join("/") || "file";
}

function uniqueName(name, used) {
  if (!used.has(name.toLowerCase())) return name;
  const slash = name.lastIndexOf("/");
  const dot = name.lastIndexOf(".");
  const cut = dot > slash + 1 ? dot : name.length;
  const stem = name.slice(0, cut);
  const ext = name.slice(cut);
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

async function bytesOf(file) {
  if (file.bytes instanceof Uint8Array) return file.bytes;
  if (file.bytes instanceof ArrayBuffer) return new Uint8Array(file.bytes);
  if (ArrayBuffer.isView(file.bytes)) return new Uint8Array(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
  if (typeof file.text === "string") return enc.encode(file.text);
  if (file.blob && typeof file.blob.arrayBuffer === "function") return new Uint8Array(await file.blob.arrayBuffer());
  throw Error(`Nothing to add for "${file.name}".`);
}

function localHeader(entry) {
  const b = new Uint8Array(30 + entry.nameBytes.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, UTF8_FLAG, true);
  v.setUint16(8, 0, true); // method: store
  v.setUint16(10, entry.time, true);
  v.setUint16(12, entry.date, true);
  v.setUint32(14, entry.crc, true);
  v.setUint32(18, entry.size, true);
  v.setUint32(22, entry.size, true);
  v.setUint16(26, entry.nameBytes.length, true);
  v.setUint16(28, 0, true);
  b.set(entry.nameBytes, 30);
  return b;
}

function centralHeader(entry) {
  const b = new Uint8Array(46 + entry.nameBytes.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, VERSION, true); // made by: MS-DOS, spec 2.0
  v.setUint16(6, VERSION, true);
  v.setUint16(8, UTF8_FLAG, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, entry.time, true);
  v.setUint16(14, entry.date, true);
  v.setUint32(16, entry.crc, true);
  v.setUint32(20, entry.size, true);
  v.setUint32(24, entry.size, true);
  v.setUint16(28, entry.nameBytes.length, true);
  v.setUint16(30, 0, true); // extra
  v.setUint16(32, 0, true); // comment
  v.setUint16(34, 0, true); // disk
  v.setUint16(36, 0, true); // internal attributes
  v.setUint32(38, 0, true); // external attributes
  v.setUint32(42, entry.offset, true);
  b.set(entry.nameBytes, 46);
  return b;
}

function endRecord(count, cdSize, cdOffset, commentBytes) {
  const b = new Uint8Array(22 + commentBytes.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(4, 0, true);
  v.setUint16(6, 0, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  v.setUint16(20, commentBytes.length, true);
  b.set(commentBytes, 22);
  return b;
}

// files: [{ name, blob | bytes | text, date? }] -> Blob (application/zip).
// Duplicate names get " (2)", " (3)" before the extension.
export async function makeZip(files, { comment = "" } = {}) {
  const list = [...(files || [])];
  if (list.length > MAX_ENTRIES) throw Error("Too many files for one zip.");
  const used = new Set();
  const parts = [];
  const entries = [];
  let offset = 0;
  for (const file of list) {
    if (!file) continue;
    const name = uniqueName(zipEntryName(file.name), used);
    used.add(name.toLowerCase());
    const data = await bytesOf(file);
    const { time, date } = dosDateTime(file.date instanceof Date ? file.date : file.date ? new Date(file.date) : new Date());
    const entry = { nameBytes: enc.encode(name), size: data.length, crc: crc32(data), time, date, offset };
    const header = localHeader(entry);
    offset += header.length + data.length;
    if (offset > MAX_U32) throw Error("The files are too large for one zip.");
    parts.push(header, data);
    entries.push(entry);
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const entry of entries) {
    const c = centralHeader(entry);
    cdSize += c.length;
    parts.push(c);
  }
  if (cdOffset + cdSize > MAX_U32) throw Error("The files are too large for one zip.");
  const commentBytes = enc.encode(String(comment)).slice(0, 0xffff);
  parts.push(endRecord(entries.length, cdSize, cdOffset, commentBytes));
  return new Blob(parts, { type: "application/zip" });
}
