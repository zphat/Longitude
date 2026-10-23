// Run: deno test --allow-read tests/compress-png8.test.js
import { assert, assertEquals } from "./compress-assert.js";
import { bitDepthFor, encodePng8Data, filterScanlines, quantize } from "../web/js/features/png8.js";
import { crc32 } from "../web/js/features/zip.js";

// ---- a minimal PNG decoder (indexed colour only) -----------------------

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readChunks(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  sig.forEach((b, i) => assertEquals(bytes[i], b, "PNG signature"));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let at = 8;
  while (at < bytes.length) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + len);
    const crc = v.getUint32(at + 8 + len);
    assertEquals(crc, crc32(bytes.subarray(at + 4, at + 8 + len)), `CRC of ${type}`);
    chunks.push({ type, data });
    at += 12 + len;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(data, rowBytes, height) {
  const out = new Uint8Array(rowBytes * height);
  const types = new Set();
  for (let y = 0; y < height; y++) {
    const t = data[y * (rowBytes + 1)];
    types.add(t);
    const src = data.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let i = 0; i < rowBytes; i++) {
      const a = i > 0 ? row[i - 1] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i > 0 ? prev[i - 1] : 0;
      const x = src[i];
      if (t === 0) row[i] = x;
      else if (t === 1) row[i] = (x + a) & 255;
      else if (t === 2) row[i] = (x + b) & 255;
      else if (t === 3) row[i] = (x + ((a + b) >> 1)) & 255;
      else if (t === 4) row[i] = (x + paeth(a, b, c)) & 255;
      else throw Error(`bad filter ${t}`);
    }
  }
  return { raw: out, types };
}

async function decodePng(bytes) {
  const chunks = readChunks(bytes);
  assertEquals(chunks[0].type, "IHDR");
  assertEquals(chunks.at(-1).type, "IEND");
  const hv = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
  const width = hv.getUint32(0);
  const height = hv.getUint32(4);
  const depth = chunks[0].data[8];
  assertEquals(chunks[0].data[9], 3, "colour type 3");
  const plte = chunks.find((c) => c.type === "PLTE").data;
  const trns = chunks.find((c) => c.type === "tRNS")?.data || null;
  const idats = chunks.filter((c) => c.type === "IDAT").map((c) => c.data);
  const joined = new Uint8Array(idats.reduce((n, d) => n + d.length, 0));
  let at = 0;
  for (const d of idats) {
    joined.set(d, at);
    at += d.length;
  }
  const rowBytes = Math.ceil((width * depth) / 8);
  const inflated = await inflate(joined);
  assertEquals(inflated.length, (rowBytes + 1) * height, "scanline bytes");
  const { raw, types } = unfilter(inflated, rowBytes, height);
  const rgba = new Uint8Array(width * height * 4);
  const per = 8 / depth;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = raw[y * rowBytes + Math.floor(x / per)];
      const idx = depth === 8 ? byte : (byte >> (8 - depth * ((x % per) + 1))) & ((1 << depth) - 1);
      assert(idx * 3 < plte.length, "index inside the palette");
      const p = (y * width + x) * 4;
      rgba[p] = plte[idx * 3];
      rgba[p + 1] = plte[idx * 3 + 1];
      rgba[p + 2] = plte[idx * 3 + 2];
      rgba[p + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, depth, colors: plte.length / 3, trns, rgba, types };
}

// ---- fixtures ------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function paletteImage(width, height, count, { alpha = false, seed = 1 } = {}) {
  const rand = rng(seed);
  const colours = [];
  const seen = new Set();
  while (colours.length < count) {
    const a = !alpha ? 255 : colours.length === 0 ? 0 : [255, 128, 64, 200][colours.length % 4];
    const c = a === 0 ? [0, 0, 0, 0] : [(rand() * 256) | 0, (rand() * 256) | 0, (rand() * 256) | 0, a];
    const key = c.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    colours.push(c);
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // Use every colour at least once.
    const c = colours[i < count ? i : (rand() * count) | 0];
    data.set(c, i * 4);
  }
  return { width, height, data };
}

function gradient(width, height, { holes = false } = {}) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = Math.round((x / (width - 1)) * 255);
      data[p + 1] = Math.round((y / (height - 1)) * 255);
      data[p + 2] = Math.round(((x + y) / (width + height - 2)) * 255);
      data[p + 3] = holes && x < width / 3 ? 0 : 255;
    }
  }
  return { width, height, data };
}

function meanError(a, b) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0) continue;
    for (let ch = 0; ch < 3; ch++) sum += Math.abs(a[i + ch] - b[i + ch]);
    n += 3;
  }
  return sum / n;
}

// ---- tests ---------------------------------------------------------------

Deno.test("crc32 matches the standard check value", () => {
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assertEquals(crc32(new Uint8Array(0)), 0);
});

Deno.test("bit depth drops for small palettes", () => {
  assertEquals(bitDepthFor(1), 1);
  assertEquals(bitDepthFor(2), 1);
  assertEquals(bitDepthFor(3), 2);
  assertEquals(bitDepthFor(4), 2);
  assertEquals(bitDepthFor(5), 4);
  assertEquals(bitDepthFor(16), 4);
  assertEquals(bitDepthFor(17), 8);
  assertEquals(bitDepthFor(256), 8);
});

for (const count of [1, 2, 3, 4, 5, 16, 17, 200, 256]) {
  for (const alpha of [false, true]) {
    Deno.test(`few colours round-trip exactly (${count} colours${alpha ? ", alpha" : ""})`, async () => {
      const img = paletteImage(37, 13, count, { alpha, seed: count * 7 + (alpha ? 1 : 0) });
      const out = await encodePng8Data(img, { colors: 256 });
      assert(out.exact, "lossless path");
      const png = await decodePng(out.bytes);
      assertEquals(png.width, 37);
      assertEquals(png.height, 13);
      assertEquals(png.depth, bitDepthFor(count));
      assertEquals(png.colors, count);
      const hasAlpha = [...Array(37 * 13).keys()].some((i) => img.data[i * 4 + 3] < 255);
      assertEquals(!!png.trns, hasAlpha, "tRNS only when needed");
      for (let i = 0; i < img.data.length; i += 4) {
        assertEquals(png.rgba[i + 3], img.data[i + 3], `alpha at ${i / 4}`);
        if (img.data[i + 3] === 0) continue;
        for (let ch = 0; ch < 3; ch++) assertEquals(png.rgba[i + ch], img.data[i + ch], `channel ${ch} at ${i / 4}`);
      }
    });
  }
}

// Average error over 4x4 blocks: what the eye sees once dithering blends.
function blockError(img, rgba, size = 4) {
  let sum = 0;
  let n = 0;
  for (let by = 0; by + size <= img.height; by += size) {
    for (let bx = 0; bx + size <= img.width; bx += size) {
      for (let ch = 0; ch < 3; ch++) {
        let a = 0;
        let b = 0;
        for (let y = by; y < by + size; y++) {
          for (let x = bx; x < bx + size; x++) {
            const p = (y * img.width + x) * 4 + ch;
            a += img.data[p];
            b += rgba[p];
          }
        }
        sum += Math.abs(a - b) / (size * size);
        n++;
      }
    }
  }
  return sum / n;
}

Deno.test("many colours are reduced to the limit with small error", async () => {
  const img = gradient(96, 64);
  for (const colors of [256, 64, 16]) {
    const results = {};
    for (const dither of [false, true]) {
      const out = await encodePng8Data(img, { colors, dither });
      assert(!out.exact);
      const png = await decodePng(out.bytes);
      assert(png.colors <= colors, `${png.colors} <= ${colors}`);
      assertEquals(png.depth, bitDepthFor(png.colors));
      assert(!png.trns, "opaque image has no tRNS");
      results[dither] = { pixel: meanError(img.data, png.rgba), block: blockError(img, png.rgba) };
    }
    const limit = colors >= 256 ? 4 : colors >= 64 ? 8 : 16;
    assert(results.false.pixel < limit, `mean error ${results.false.pixel.toFixed(2)} < ${limit} at ${colors} colours`);
    assert(results.true.pixel < limit * 1.3, `dithered error ${results.true.pixel.toFixed(2)} at ${colors} colours`);
    assert(results.true.block < results.false.block, `dithering lowers the blended error at ${colors} colours`);
  }
});

Deno.test("transparent pixels stay transparent after quantising", async () => {
  const img = gradient(60, 40, { holes: true });
  const out = await encodePng8Data(img, { colors: 32, dither: true });
  const png = await decodePng(out.bytes);
  assert(png.trns, "has tRNS");
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) assertEquals(png.rgba[i + 3], 0, `pixel ${i / 4} stays clear`);
    else assertEquals(png.rgba[i + 3], 255, `pixel ${i / 4} stays opaque`);
  }
});

Deno.test("quantize returns one index per pixel inside the palette", async () => {
  const img = gradient(33, 21);
  const q = await quantize(img, { colors: 48 });
  assertEquals(q.indices.length, 33 * 21);
  assert(q.colors <= 48);
  assertEquals(q.palette.length, q.colors * 4);
  for (const i of q.indices) assert(i < q.colors);
});

Deno.test("adaptive filtering round-trips and picks Sub for ramps", () => {
  const rowBytes = 50;
  const height = 6;
  const raw = new Uint8Array(rowBytes * height);
  const rand = rng(9);
  for (let i = 0; i < raw.length; i++) raw[i] = (rand() * 256) | 0;
  for (let i = 0; i < rowBytes; i++) raw[i] = i * 3; // ramp: Sub wins
  for (let i = 0; i < rowBytes; i++) raw[rowBytes + i] = raw[i]; // repeat: Up wins
  const filtered = filterScanlines(raw, rowBytes, height, { adaptive: true });
  assertEquals(filtered[0], 1, "Sub for the ramp");
  assertEquals(filtered[rowBytes + 1], 2, "Up for the repeated row");
  const { raw: back } = unfilter(filtered, rowBytes, height);
  assertEquals([...back], [...raw]);
  const plain = filterScanlines(raw, rowBytes, height, { adaptive: false });
  for (let y = 0; y < height; y++) assertEquals(plain[y * (rowBytes + 1)], 0);
});

Deno.test("rejects bad input with a plain message", async () => {
  let message = "";
  try {
    await encodePng8Data({ width: 2, height: 2, data: new Uint8Array(3) });
  } catch (err) {
    message = err.message;
  }
  assert(/incomplete/.test(message), message);
});
