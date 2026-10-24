// Run: deno test --allow-read tests/compress-zip.test.js
import { assert, assertEquals } from "./compress-assert.js";
import { crc32, dosDateTime, makeZip, zipEntryName } from "../web/js/features/zip.js";

const dec = new TextDecoder();

// Parse the archive back the way an unzip tool does: EOCD -> central
// directory -> local headers -> data.
function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert(eocd >= 0, "has an end of central directory record");
  const count = v.getUint16(eocd + 10, true);
  assertEquals(v.getUint16(eocd + 8, true), count, "entries on this disk");
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  assertEquals(cdOffset + cdSize, eocd, "central directory ends at the EOCD");
  const commentLen = v.getUint16(eocd + 20, true);
  const comment = dec.decode(bytes.subarray(eocd + 22, eocd + 22 + commentLen));
  const files = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    assertEquals(v.getUint32(at, true), 0x02014b50, "central header signature");
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const time = v.getUint16(at + 12, true);
    const date = v.getUint16(at + 14, true);
    const crc = v.getUint32(at + 16, true);
    const compSize = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const cmtLen = v.getUint16(at + 32, true);
    const offset = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    // Local header must agree with the central directory.
    assertEquals(v.getUint32(offset, true), 0x04034b50, "local header signature");
    assertEquals(v.getUint16(offset + 6, true), flags, "local flags");
    assertEquals(v.getUint16(offset + 8, true), method, "local method");
    assertEquals(v.getUint16(offset + 10, true), time, "local time");
    assertEquals(v.getUint16(offset + 12, true), date, "local date");
    assertEquals(v.getUint32(offset + 14, true), crc, "local crc");
    assertEquals(v.getUint32(offset + 18, true), compSize, "local compressed size");
    assertEquals(v.getUint32(offset + 22, true), size, "local size");
    const lNameLen = v.getUint16(offset + 26, true);
    const lExtraLen = v.getUint16(offset + 28, true);
    assertEquals(dec.decode(bytes.subarray(offset + 30, offset + 30 + lNameLen)), name, "local name");
    const start = offset + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + compSize);
    files.push({ name, flags, method, time, date, crc, size, compSize, data });
    at += 46 + nameLen + extraLen + cmtLen;
  }
  assertEquals(at, eocd, "central directory size matches");
  return { files, comment };
}

Deno.test("makeZip writes a valid stored archive", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 250, 0, 7]);
  const when = new Date(2026, 9, 23, 14, 37, 58);
  const blob = await makeZip(
    [
      { name: "thumbnail.png", bytes: png, date: when },
      { name: "notes.txt", text: "Longitude export" },
      { name: "covers/Ünïcödé café ☕.jpg", blob: new Blob([new Uint8Array([9, 8, 7])]) },
      { name: "empty.bin", bytes: new Uint8Array(0) },
    ],
    { comment: "made with Longitude" },
  );
  assertEquals(blob.type, "application/zip");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { files, comment } = readZip(bytes);
  assertEquals(comment, "made with Longitude");
  assertEquals(files.map((f) => f.name), ["thumbnail.png", "notes.txt", "covers/Ünïcödé café ☕.jpg", "empty.bin"]);
  for (const f of files) {
    assertEquals(f.method, 0, `${f.name} is stored`);
    assertEquals(f.flags & 0x0800, 0x0800, `${f.name} has the UTF-8 flag`);
    assertEquals(f.size, f.compSize, `${f.name} sizes match`);
    assertEquals(crc32(f.data), f.crc, `${f.name} CRC`);
  }
  assertEquals([...files[0].data], [...png]);
  assertEquals(dec.decode(files[1].data), "Longitude export");
  assertEquals([...files[2].data], [9, 8, 7]);
  assertEquals(files[3].size, 0);
  const t = dosDateTime(when);
  assertEquals(files[0].time, t.time);
  assertEquals(files[0].date, t.date);
});

Deno.test("DOS timestamps pack the local date and time", () => {
  const { time, date } = dosDateTime(new Date(2026, 9, 23, 14, 37, 58));
  assertEquals(time >> 11, 14);
  assertEquals((time >> 5) & 63, 37);
  assertEquals((time & 31) * 2, 58);
  assertEquals((date >> 9) + 1980, 2026);
  assertEquals((date >> 5) & 15, 10);
  assertEquals(date & 31, 23);
  const early = dosDateTime(new Date(1970, 0, 1));
  assertEquals(early.date, (0 << 9) | (1 << 5) | 1, "clamps to 1980-01-01");
});

Deno.test("names are made portable and unique", async () => {
  assertEquals(zipEntryName("../../etc/passwd"), "etc/passwd");
  assertEquals(zipEntryName("C:\\Users\\me\\a.png"), "C_/Users/me/a.png");
  assertEquals(zipEntryName("/abs/./x?.png"), "abs/x_.png");
  assertEquals(zipEntryName(""), "file");
  const blob = await makeZip([
    { name: "a.png", bytes: new Uint8Array([1]) },
    { name: "a.png", bytes: new Uint8Array([2]) },
    { name: "A.PNG", bytes: new Uint8Array([3]) },
    { name: "noext", bytes: new Uint8Array([4]) },
    { name: "noext", bytes: new Uint8Array([5]) },
  ]);
  const { files } = readZip(new Uint8Array(await blob.arrayBuffer()));
  assertEquals(files.map((f) => f.name), ["a.png", "a (2).png", "A (3).PNG", "noext", "noext (2)"]);
});

Deno.test("an empty list makes an empty but valid zip", async () => {
  const blob = await makeZip([]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assertEquals(bytes.length, 22);
  assertEquals(readZip(bytes).files.length, 0);
});

Deno.test("compress.js makeZip loads the zip writer on first use", async () => {
  const exporter = await import("../web/js/features/compress.js");
  const blob = await exporter.makeZip([{ name: "a.txt", text: "hi" }]);
  assertEquals(blob.type, "application/zip");
  const direct = await makeZip([{ name: "a.txt", text: "hi", date: new Date(2024, 0, 1) }]);
  const lazy = await exporter.makeZip([{ name: "a.txt", text: "hi", date: new Date(2024, 0, 1) }]);
  assertEquals(new Uint8Array(await lazy.arrayBuffer()), new Uint8Array(await direct.arrayBuffer()));
});
